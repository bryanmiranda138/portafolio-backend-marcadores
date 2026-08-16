require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.get('/', (req, res) => res.send('⚽ Servidor de Marcadores en vivo funcionando.'));
app.get('/debug', (req, res) => res.json({ proximos: cacheProximosPartidos, enVivo: partidosEnVivoCache }));

// 📌 TUS EQUIPOS FAVORITOS
const EQUIPOS_FAVORITOS = [
  { nombre: 'FC Barcelona',   idFootball: 529,  idSportsDB: 133739, strSearch: 'Barcelona' },
  { nombre: 'Real Madrid',    idFootball: 541,  idSportsDB: 133604, strSearch: 'Real Madrid' },
  { nombre: 'Boca Juniors',   idFootball: 451,  idSportsDB: 135205, strSearch: 'Boca Juniors' },
  { nombre: 'River Plate',    idFootball: 435,  idSportsDB: 135211, strSearch: 'River Plate' },
  { nombre: 'Liverpool',      idFootball: 40,   idSportsDB: 133602, strSearch: 'Liverpool' },
  { nombre: 'Manchester City',idFootball: 50,   idSportsDB: 133613, strSearch: 'Manchester City' },
  { nombre: 'C.D. Águila',    idFootball: 2307, idSportsDB: 140411, strSearch: 'Aguila' }, 
  { nombre: 'Inter Miami CF', idFootball: [9723, 8984], idSportsDB: 137699, strSearch: 'Inter Miami' },
  { nombre: 'Argentina',      idFootball: 26,   idSportsDB: 135275, strSearch: 'Argentina' },
  { nombre: 'Brasil',         idFootball: 6,    idSportsDB: 135276, strSearch: 'Brazil' },
  { nombre: 'Inglaterra',     idFootball: 10,   idSportsDB: 133702, strSearch: 'England' },
  { nombre: 'Francia',        idFootball: 2,    idSportsDB: 133714, strSearch: 'France' },
  { nombre: 'España',         idFootball: 9,    idSportsDB: 133738, strSearch: 'Spain' }
];

const EXCLUSIONES = [
  'new england', 'barcelona sc', 'barcelona de guayaquil',
  'liverpool montevideo', 'river plate montevideo',
  'real madrid b', 'barcelona b', 'walsham-le-willows', 'walsham le willows'
];

// ⏱️ AUMENTADO A 15 MINUTOS PARA NO AGOTAR LAS 100 PETICIONES DIARIAS
const INTERVALO_CONSULTA = 15 * 60 * 1000; 

let cacheProximosPartidos = [];
let partidosEnVivoCache = []; 
let cargandoProximos = false;

// 🛡️ MEMORIA RAM PARA GUARDAR LOS ESCUDOS Y NUNCA USAR IMÁGENES ROTAS
const cacheEscudos = {};

const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function emitirDatosAlFrontend(socketEspecifico = null) {
  const idsJugandoAhora = new Set();
  partidosEnVivoCache.forEach(p => {
    idsJugandoAhora.add(p.equipoIdFiltro1);
    idsJugandoAhora.add(p.equipoIdFiltro2);
  });

  const proximosFiltrados = cacheProximosPartidos.filter(p => !idsJugandoAhora.has(p.equipoTrackedId));
  const listaBruta = [...partidosEnVivoCache, ...proximosFiltrados];
  
  const mapaDeduplicacion = new Map();
  listaBruta.forEach(partido => {
    if (!mapaDeduplicacion.has(partido.id)) mapaDeduplicacion.set(partido.id, partido);
  });
  
  let listaFinal = Array.from(mapaDeduplicacion.values());

  if (socketEspecifico) socketEspecifico.emit('marcadores_actualizados', listaFinal);
  else io.emit('marcadores_actualizados', listaFinal);
}

function obtenerFavoritoSiCoincide(nombreEquipoAPI) {
  if (!nombreEquipoAPI) return null;
  const nombreNorm = nombreEquipoAPI.toLowerCase().trim();
  if (EXCLUSIONES.some(ex => nombreNorm.includes(ex))) return null;

  for (const fav of EQUIPOS_FAVORITOS) {
    const searchNorm = fav.strSearch.toLowerCase().trim();
    if (nombreNorm === searchNorm || nombreNorm === fav.nombre.toLowerCase().trim()) return fav;
    const regex = new RegExp(`\\b${searchNorm}\\b`, 'i');
    if (regex.test(nombreNorm)) return fav;
  }
  return null;
}

// 🛡️ NUEVO: Descarga y guarda los escudos una sola vez al arrancar
async function inicializarEscudosSeguros() {
  console.log('🛡️ Descargando escudos oficiales a la memoria RAM...');
  for (const eq of EQUIPOS_FAVORITOS) {
    try {
      const url = `https://www.thesportsdb.com/api/v1/json/3/lookupteam.php?id=${eq.idSportsDB}`;
      const res = await axios.get(url);
      const escudo = res.data?.teams?.[0]?.strTeamBadge;
      const mainId = Array.isArray(eq.idFootball) ? eq.idFootball[0] : eq.idFootball;
      if (escudo) cacheEscudos[mainId] = escudo;
    } catch (e) {
      console.log(`⚠️ No se pudo descargar el escudo de ${eq.nombre}`);
    }
    await esperar(500); // Respetar tasa de peticiones
  }
  console.log('✅ Escudos guardados. Adiós a las imágenes rotas.');
}

async function obtenerEscudoOponente(idTeam) {
  if (!idTeam) return null;
  try {
    const res = await axios.get(`https://www.thesportsdb.com/api/v1/json/3/lookupteam.php?id=${idTeam}`);
    return res.data?.teams?.[0]?.strTeamBadge || null;
  } catch (error) { return null; }
}

// 1️⃣ API #1: TheSportsDB (Buscador blindado con Escudos desde RAM)
async function cargarProximosPartidosProgresivamente() {
  if (cargandoProximos) return;
  cargandoProximos = true;
  console.log('⏳ Iniciando buscador de próximos partidos...');

  let listaTemporal = [];

  for (const equipo of EQUIPOS_FAVORITOS) {
    const mainFavId = Array.isArray(equipo.idFootball) ? equipo.idFootball[0] : equipo.idFootball;
    let partidoEncontrado = false;

    try {
      const resBusqueda = await axios.get(`https://www.thesportsdb.com/api/v1/json/3/lookupteam.php?id=${equipo.idSportsDB}`);
      const equipoEncontrado = resBusqueda.data?.teams?.[0];
      
      if (equipoEncontrado) {
        const resPartidos = await axios.get(`https://www.thesportsdb.com/api/v1/json/3/eventsnext.php?id=${equipoEncontrado.idTeam}`);
        const proximosEventos = resPartidos.data?.events;

        if (proximosEventos && proximosEventos.length > 0) {
          const ahora = Date.now();
          const eventosFuturos = proximosEventos.filter(ev => {
            if (ev.strSport && ev.strSport !== 'Soccer') return false; 
            const liga = (ev.strLeague || '').toLowerCase();
            if (liga.includes('basket') || liga.includes('acb')) return false;
            if (!ev.strTimestamp) return false;
            return new Date(ev.strTimestamp).getTime() > ahora; 
          });

          if (eventosFuturos.length > 0) {
            const fixtureFutu = eventosFuturos[0];
            const fechaUTC = new Date(fixtureFutu.strTimestamp);
            const fechaElSalvador = new Date(fechaUTC.getTime() - (6 * 60 * 60 * 1000));
            const fechaFormateada = fechaElSalvador.toLocaleDateString('es-ES', { 
              day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC'
            });
            
            const esLocal = fixtureFutu.idHomeTeam === equipoEncontrado.idTeam;
            const idOponente = esLocal ? fixtureFutu.idAwayTeam : fixtureFutu.idHomeTeam;

            // Extrae escudo oponente, y usa nuestro caché seguro para el propio
            const escudoOponente = await obtenerEscudoOponente(idOponente);
            const miEscudo = cacheEscudos[mainFavId] || equipoEncontrado.strTeamBadge;
            
            listaTemporal.push({
              id: fixtureFutu.idEvent,
              equipoTrackedId: mainFavId,
              local: fixtureFutu.strHomeTeam,
              logoLocal: esLocal ? miEscudo : escudoOponente,
              visitante: fixtureFutu.strAwayTeam,
              logoVisitante: !esLocal ? miEscudo : escudoOponente,
              golesLocal: 0, golesVisitante: 0,
              minuto: fechaFormateada,
              estado: 'PROXIMO',
              esEnVivo: false, anotadores: [] 
            });
            partidoEncontrado = true;
          }
        }
      }
    } catch (err) {}

    // 🛡️ TBD: Si no hay partido, construye tarjeta usando EL ESCUDO SEGURO DE LA RAM
    if (!partidoEncontrado) {
      listaTemporal.push({
        id: `tbd-${mainFavId}`,
        equipoTrackedId: mainFavId, 
        local: equipo.nombre, 
        logoLocal: cacheEscudos[mainFavId] || null, // 👈 NUNCA MÁS UNA IMAGEN ROTA
        visitante: 'Rival por definir', 
        logoVisitante: null,
        golesLocal: 0, golesVisitante: 0,
        minuto: 'Fecha por confirmar', 
        estado: 'PROXIMO',
        esEnVivo: false, anotadores: [] 
      });
    }
    
    cacheProximosPartidos = [...listaTemporal];
    emitirDatosAlFrontend();
    await esperar(800); 
  }
  cargandoProximos = false;
}

// 2️⃣ API #2: API-Football (Partidos en vivo)
async function buscarPartidosEnVivo() {
  try {
    console.log('🔍 Consultando partidos en vivo en API-Football...');
    
    const responseLive = await axios.get('https://v3.football.api-sports.io/fixtures?live=all', {
      headers: { 'x-apisports-key': process.env.FOOTBALL_API_KEY }
    });

    const errores = responseLive.data?.errors;
    if (errores && Object.keys(errores).length > 0) {
      if (errores.requests) {
        console.error('🛑 LÍMITE DE API ALCANZADO: Has gastado tus 100 consultas gratuitas de hoy.');
      } else {
        console.error('⚠️ Error API-Football:', JSON.stringify(errores));
      }
      return;
    }

    const partidosLiveCrudos = responseLive.data?.response || [];
    let nuevosEnVivo = []; 

    partidosLiveCrudos.forEach(fixture => {
      try {
        const favHome = obtenerFavoritoSiCoincide(fixture.teams.home.name);
        const favAway = obtenerFavoritoSiCoincide(fixture.teams.away.name);
        const equipoFavorito = favHome || favAway;

        if (equipoFavorito) {
          const statusCorto = fixture.fixture.status.short;
          const elapsed = fixture.fixture.status.elapsed;
          const extra = fixture.fixture.status.extra;

          let tiempoAmostrar = ['HT'].includes(statusCorto) ? 'Medio Tiempo' : 
                               ['FT', 'AET', 'PEN'].includes(statusCorto) ? 'Finalizado' : 
                               extra ? `${elapsed} + ${extra}'` : `${elapsed}'`; 

          const eventos = fixture.events || [];
          const anotadoresData = eventos.filter(e => e.type === 'Goal' && e.detail !== 'Missed Penalty')
            .map(e => ({ equipo: e.team.name, jugador: e.player.name || 'Desconocido', minuto: e.time.elapsed, tipo: e.detail === 'Own Goal' ? 'Autogol' : e.detail === 'Penalty' ? 'Penal' : 'Gol' }));

          const tarjetasData = eventos.filter(e => e.type === 'Card')
            .map(e => ({ equipo: e.team.name, jugador: e.player.name || 'Desconocido', minuto: e.time.elapsed, tipo: (e.detail || '').toLowerCase().includes('yellow') ? 'Amarilla' : 'Roja' }));

          const mainFavId = Array.isArray(equipoFavorito.idFootball) ? equipoFavorito.idFootball[0] : equipoFavorito.idFootball;

          nuevosEnVivo.push({
            id: fixture.fixture.id,
            equipoIdFiltro1: mainFavId, equipoIdFiltro2: mainFavId,
            local: fixture.teams.home.name, logoLocal: fixture.teams.home.logo,
            visitante: fixture.teams.away.name, logoVisitante: fixture.teams.away.logo,
            golesLocal: fixture.goals.home ?? 0, golesVisitante: fixture.goals.away ?? 0,
            minuto: tiempoAmostrar, estado: statusCorto, esEnVivo: true, anotadores: anotadoresData, tarjetas: tarjetasData
          });
        }
      } catch (errLoop) {}
    });

    partidosEnVivoCache = nuevosEnVivo;
    emitirDatosAlFrontend();
  } catch (error) {
    console.error('❌ Error API-Football:', error.message);
  }
}

// 🚀 ARRANQUE SECUENCIAL ASEGURADO
(async () => {
  await inicializarEscudosSeguros(); // Primero descargamos y aseguramos los escudos
  buscarPartidosEnVivo();            // Luego buscamos en vivo
  cargarProximosPartidosProgresivamente(); // Luego generamos la lista
  
  // Establecemos los intervalos saludables (15 min = 96 peticiones al día)
  setInterval(buscarPartidosEnVivo, INTERVALO_CONSULTA); 
  setInterval(cargarProximosPartidosProgresivamente, 30 * 60 * 1000); 
})();

io.on('connection', (socket) => emitirDatosAlFrontend(socket));

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Servidor Multi-API corriendo en puerto ${PORT}`));