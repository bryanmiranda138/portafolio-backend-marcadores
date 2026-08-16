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

app.get('/', (req, res) => res.send('⚽ Servidor de Marcadores en vivo (Multi-API) funcionando.'));
app.get('/debug', (req, res) => res.json({ proximos: cacheProximosPartidos, enVivo: partidosEnVivoCache }));

// 📌 TUS EQUIPOS FAVORITOS
const EQUIPOS_FAVORITOS = [
  { nombre: 'FC Barcelona', idFootball: 529, idSportsDB: 133739, strSearch: 'Barcelona' },
  { nombre: 'Real Madrid', idFootball: 541, idSportsDB: 133604, strSearch: 'Real Madrid' },
  { nombre: 'Boca Juniors', idFootball: 451, idSportsDB: 135205, strSearch: 'Boca Juniors' },
  { nombre: 'River Plate', idFootball: 435, idSportsDB: 135211, strSearch: 'River Plate' },
  { nombre: 'Liverpool', idFootball: 40, idSportsDB: 133602, strSearch: 'Liverpool' },
  { nombre: 'Manchester City', idFootball: 50, idSportsDB: 133613, strSearch: 'Manchester City' },
  { nombre: 'C.D. Águila', idFootball: 2307, idSportsDB: 140411, strSearch: 'Aguila' },
  { nombre: 'Inter Miami CF', idFootball: [9723, 8984], idSportsDB: 137699, strSearch: 'Inter Miami' },
  { nombre: 'Argentina', idFootball: 26, idSportsDB: 135275, strSearch: 'Argentina' },
  { nombre: 'Brasil', idFootball: 6, idSportsDB: 135276, strSearch: 'Brazil' },
  { nombre: 'Inglaterra', idFootball: 10, idSportsDB: 133702, strSearch: 'England' },
  { nombre: 'Francia', idFootball: 2, idSportsDB: 133714, strSearch: 'France' },
  { nombre: 'España', idFootball: 9, idSportsDB: 133738, strSearch: 'Spain' }
];

const EXCLUSIONES = [
  'new england', 'barcelona sc', 'barcelona de guayaquil',
  'liverpool montevideo', 'river plate montevideo',
  'real madrid b', 'barcelona b', 'walsham-le-willows', 'walsham le willows'
];

const INTERVALO_CONSULTA = 3 * 60 * 1000;

let cacheProximosPartidos = [];
let partidosEnVivoCache = [];
let cargandoProximos = false;

// 🛡️ BÓVEDA DE ESCUDOS: Aquí guardaremos los escudos perfectos de tus favoritos
let escudosPerfectos = {};

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

// 1️⃣ API #1: TheSportsDB (Con Forzado de Escudo Seguro)
async function cargarProximosPartidosProgresivamente() {
  if (cargandoProximos) return;
  cargandoProximos = true;
  console.log('⏳ Iniciando buscador de próximos partidos...');

  let listaTemporal = [];

  for (const equipo of EQUIPOS_FAVORITOS) {
    const mainFavId = Array.isArray(equipo.idFootball) ? equipo.idFootball[0] : equipo.idFootball;
    let partidoAgregado = false;

    try {
      const urlBusqueda = `https://www.thesportsdb.com/api/v1/json/3/lookupteam.php?id=${equipo.idSportsDB}`;
      const resBusqueda = await axios.get(urlBusqueda);
      const equipoEncontrado = resBusqueda.data?.teams?.[0];

      if (equipoEncontrado) {
        // 🛡️ Guardamos el escudo oficial en la bóveda por si lo necesitamos luego
        if (equipoEncontrado.strTeamBadge) escudosPerfectos[mainFavId] = equipoEncontrado.strTeamBadge;

        const urlPartidos = `https://www.thesportsdb.com/api/v1/json/3/eventsnext.php?id=${equipoEncontrado.idTeam}`;
        const resPartidos = await axios.get(urlPartidos);
        const proximosEventos = resPartidos.data?.events;

        if (proximosEventos && proximosEventos.length > 0) {
          const ahora = Date.now();

          // 🛑 FILTRO DE SEGURIDAD ESTRICTO: Solo Fútbol y Futuro
          const eventosRealmenteFuturos = proximosEventos.filter(ev => {
            if (ev.strSport && ev.strSport !== 'Soccer') return false;
            const liga = (ev.strLeague || '').toLowerCase();
            if (liga.includes('basket') || liga.includes('acb') || liga.includes('endesa')) return false;

            if (!ev.strTimestamp) return false;
            return new Date(ev.strTimestamp).getTime() > ahora;
          });

          if (eventosRealmenteFuturos.length > 0) {
            const fixtureFutu = eventosRealmenteFuturos[0];

            const fechaUTC = new Date(fixtureFutu.strTimestamp);
            const fechaElSalvador = new Date(fechaUTC.getTime() - (6 * 60 * 60 * 1000));
            const fechaFormateada = fechaElSalvador.toLocaleDateString('es-ES', {
              day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC'
            });

            // Verificamos si nuestro equipo es el local o visitante
            const esLocal = String(fixtureFutu.idHomeTeam) === String(equipoEncontrado.idTeam);

            listaTemporal.push({
              id: fixtureFutu.idEvent,
              equipoTrackedId: mainFavId,
              local: fixtureFutu.strHomeTeam,
              // 🌟 LA MAGIA: Si somos locales, forzamos nuestro escudo perfecto de la bóveda. Si es el rival, usamos el que traiga el evento.
              logoLocal: esLocal ? escudosPerfectos[mainFavId] : (fixtureFutu.strHomeTeamBadge || null),
              visitante: fixtureFutu.strAwayTeam,
              // 🌟 LA MAGIA: Si somos visitantes, forzamos nuestro escudo perfecto de la bóveda. Si es el rival, usamos el que traiga el evento.
              logoVisitante: !esLocal ? escudosPerfectos[mainFavId] : (fixtureFutu.strAwayTeamBadge || null),
              golesLocal: 0,
              golesVisitante: 0,
              minuto: fechaFormateada,
              estado: 'PROXIMO',
              esEnVivo: false,
              anotadores: []
            });
            partidoAgregado = true;
          }
        }
      }
    } catch (err) {
      console.log(`⚠️ Silenciado: Rate limit o error temporal en ${equipo.nombre}`);
    }

    // 🛡️ TBD: Si no hay partido o hubo error, construimos la tarjeta con el escudo de la bóveda
    if (!partidoAgregado) {
      listaTemporal.push({
        id: `tbd-${mainFavId}`,
        equipoTrackedId: mainFavId,
        local: equipo.nombre,
        logoLocal: escudosPerfectos[mainFavId] || null, // Nunca más usar URLs de otras APIs
        visitante: 'Rival por definir',
        logoVisitante: null,
        golesLocal: 0,
        golesVisitante: 0,
        minuto: 'Fecha por confirmar',
        estado: 'PROXIMO',
        esEnVivo: false,
        anotadores: []
      });
    }

    cacheProximosPartidos = [...listaTemporal];
    emitirDatosAlFrontend();
    await esperar(1000); // 1 segundo de respiro obligatorio entre peticiones
  }
  cargandoProximos = false;
  console.log('✅ Calendario de próximos partidos actualizado.');
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
        console.error('🛑 ¡LÍMITE ALCANZADO! Has superado las 100 consultas gratis de hoy en API-Football.');
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
        const equipoFavoritoEncontrado = favHome || favAway;

        if (equipoFavoritoEncontrado) {
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

          const mainFavId = Array.isArray(equipoFavoritoEncontrado.idFootball) ? equipoFavoritoEncontrado.idFootball[0] : equipoFavoritoEncontrado.idFootball;

          nuevosEnVivo.push({
            id: fixture.fixture.id,
            equipoIdFiltro1: mainFavId, equipoIdFiltro2: mainFavId,
            local: fixture.teams.home.name, logoLocal: fixture.teams.home.logo,
            visitante: fixture.teams.away.name, logoVisitante: fixture.teams.away.logo,
            golesLocal: fixture.goals.home ?? 0, golesVisitante: fixture.goals.away ?? 0,
            minuto: tiempoAmostrar, estado: statusCorto, esEnVivo: true, anotadores: anotadoresData, tarjetas: tarjetasData
          });
        }
      } catch (errLoop) { }
    });

    partidosEnVivoCache = nuevosEnVivo;
    emitirDatosAlFrontend();
  } catch (error) {
    console.error('❌ Error API-Football:', error.message);
  }
}

// 🚀 ARRANQUES E INTERVALOS
buscarPartidosEnVivo();
setTimeout(cargarProximosPartidosProgresivamente, 2000);

setInterval(buscarPartidosEnVivo, INTERVALO_CONSULTA);
setInterval(cargarProximosPartidosProgresivamente, 30 * 60 * 1000);

io.on('connection', (socket) => emitirDatosAlFrontend(socket));

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Servidor Multi-API corriendo en puerto ${PORT}`));