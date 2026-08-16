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

app.get('/', (req, res) => res.send('⚽ Servidor de Marcadores (Arquitectura Inmune) funcionando.'));
app.get('/debug', (req, res) => res.json({ proximos: cacheProximosPartidos, enVivo: partidosEnVivoCache }));

// 📌 TUS EQUIPOS FAVORITOS (Con Escudos Oficiales Blindados e ID correcto de Miami)
const EQUIPOS_FAVORITOS = [
  { nombre: 'FC Barcelona',   idFootball: 529,  strSearch: 'Barcelona', logo: 'https://media.api-sports.io/football/teams/529.png' },
  { nombre: 'Real Madrid',    idFootball: 541,  strSearch: 'Real Madrid', logo: 'https://media.api-sports.io/football/teams/541.png' },
  { nombre: 'Boca Juniors',   idFootball: 451,  strSearch: 'Boca Juniors', logo: 'https://media.api-sports.io/football/teams/451.png' },
  { nombre: 'River Plate',    idFootball: 435,  strSearch: 'River Plate', logo: 'https://media.api-sports.io/football/teams/435.png' },
  { nombre: 'Liverpool',      idFootball: 40,   strSearch: 'Liverpool', logo: 'https://media.api-sports.io/football/teams/40.png' },
  { nombre: 'Manchester City',idFootball: 50,   strSearch: 'Manchester City', logo: 'https://media.api-sports.io/football/teams/50.png' },
  { nombre: 'C.D. Águila',    idFootball: 2307, strSearch: 'Aguila', logo: 'https://media.api-sports.io/football/teams/2307.png' }, 
  { nombre: 'Inter Miami',    idFootball: 9723, strSearch: 'Inter Miami', logo: 'https://media.api-sports.io/football/teams/9723.png' }, // ID y Logo oficial
  { nombre: 'Argentina',      idFootball: 26,   strSearch: 'Argentina', logo: 'https://media.api-sports.io/football/teams/26.png' },
  { nombre: 'Brasil',         idFootball: 6,    strSearch: 'Brazil', logo: 'https://media.api-sports.io/football/teams/6.png' },
  { nombre: 'Inglaterra',     idFootball: 10,   strSearch: 'England', logo: 'https://media.api-sports.io/football/teams/10.png' },
  { nombre: 'Francia',        idFootball: 2,    strSearch: 'France', logo: 'https://media.api-sports.io/football/teams/2.png' },
  { nombre: 'España',         idFootball: 9,    strSearch: 'Spain', logo: 'https://media.api-sports.io/football/teams/9.png' }
];

// 🛡️ EXCLUSIONES ESTRICTAS
const EXCLUSIONES = ['new england', 'barcelona sc', 'barcelona de guayaquil', 'liverpool montevideo', 'river plate montevideo', 'real madrid b', 'barcelona b'];

const INTERVALO_CONSULTA = 3 * 60 * 1000; 

let cacheProximosPartidos = [];
let cargandoProximos = false;
let partidosEnVivoCache = []; 

const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 🧠 FILTRO INTELIGENTE AL EMITIR
function emitirDatosAlFrontend(socketEspecifico = null) {
  const idsJugandoAhora = new Set();
  partidosEnVivoCache.forEach(p => {
    idsJugandoAhora.add(p.equipoIdFiltro1);
    idsJugandoAhora.add(p.equipoIdFiltro2);
  });

  const ahora = Date.now();

  const proximosFiltrados = cacheProximosPartidos.filter(p => {
    // 1. Ocultar si el partido ya está en vivo
    if (idsJugandoAhora.has(p.equipoTrackedId)) return false;
    
    // 2. Si es una tarjeta "TBD", dejarla en pantalla
    if (p.id.toString().startsWith('tbd')) return true;

    // 🚀 3. EL FILTRO CRONOLÓGICO: Si la hora de inicio del partido ya pasó, SE ELIMINA (Adiós partidos terminados).
    if (p.timestamp && p.timestamp <= ahora) return false;

    return true;
  });

  const listaBruta = [...partidosEnVivoCache, ...proximosFiltrados];
  const mapaDeduplicacion = new Map();
  
  listaBruta.forEach(partido => {
    if (!mapaDeduplicacion.has(partido.id)) mapaDeduplicacion.set(partido.id, partido);
  });
  
  let listaFinal = Array.from(mapaDeduplicacion.values());

  if (socketEspecifico) {
    socketEspecifico.emit('marcadores_actualizados', listaFinal);
  } else {
    io.emit('marcadores_actualizados', listaFinal);
  }
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

// 1️⃣ API #1: TheSportsDB (Con Inyección de Logos Oficiales)
async function cargarProximosPartidosProgresivamente() {
  if (cargandoProximos) return;
  cargandoProximos = true;
  console.log('⏳ Buscando calendario de próximos partidos...');

  let listaTemporal = [];

  for (const equipo of EQUIPOS_FAVORITOS) {
    try {
      const urlBusqueda = `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(equipo.strSearch)}`;
      const resBusqueda = await axios.get(urlBusqueda);
      const equipoEncontrado = resBusqueda.data?.teams?.find(t => t.strSport === 'Soccer');
      
      if (equipoEncontrado) {
        const urlPartidos = `https://www.thesportsdb.com/api/v1/json/3/eventsnext.php?id=${equipoEncontrado.idTeam}`;
        const resPartidos = await axios.get(urlPartidos);
        const proximosEventos = resPartidos.data?.events;

        if (proximosEventos && proximosEventos.length > 0) {
          // Filtramos eventos viejos que la API aún no ha limpiado
          const eventosFuturos = proximosEventos.filter(ev => new Date(ev.strTimestamp).getTime() > Date.now());

          if (eventosFuturos.length > 0) {
            const fixtureFutu = eventosFuturos[0];
            const fechaUTC = new Date(fixtureFutu.strTimestamp);
            const fechaElSalvador = new Date(fechaUTC.getTime() - (6 * 60 * 60 * 1000));
            
            const fechaFormateada = fechaElSalvador.toLocaleDateString('es-ES', { 
              day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC'
            });
            
            const esLocal = fixtureFutu.idHomeTeam === equipoEncontrado.idTeam;
            
            listaTemporal.push({
              id: fixtureFutu.idEvent,
              equipoTrackedId: equipo.idFootball,
              local: fixtureFutu.strHomeTeam,
              // 🛡️ Asignamos NUESTRO logo blindado si es favorito
              logoLocal: esLocal ? equipo.logo : fixtureFutu.strHomeTeamBadge,
              visitante: fixtureFutu.strAwayTeam,
              // 🛡️ Asignamos NUESTRO logo blindado si es favorito
              logoVisitante: !esLocal ? equipo.logo : fixtureFutu.strAwayTeamBadge,
              golesLocal: 0, 
              golesVisitante: 0,
              minuto: fechaFormateada,
              timestamp: fechaUTC.getTime(), // ⏱️ Guardamos el tiempo exacto para el filtro automático
              estado: 'PROXIMO',
              esEnVivo: false,
              anotadores: [] 
            });
          } else {
             throw new Error("El partido ya pasó en el reloj real"); 
          }
        } else {
           throw new Error("Agenda vacía"); 
        }
      } else {
         throw new Error("Equipo no encontrado"); 
      }
    } catch (err) {
      listaTemporal.push({
        id: `tbd-${equipo.idFootball}`,
        equipoTrackedId: equipo.idFootball, 
        local: equipo.nombre, 
        logoLocal: equipo.logo, // Logo 100% seguro de nuestra lista
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
    await esperar(1000); 
  }
  console.log(`✅ Calendario actualizado con éxito.`);
  cargandoProximos = false;
}

// 2️⃣ API #2: API-Football (Partidos En Vivo)
async function buscarPartidosEnVivo() {
  try {
    const responseLive = await axios.get('https://v3.football.api-sports.io/fixtures?live=all', {
      headers: { 'x-apisports-key': process.env.FOOTBALL_API_KEY }
    });

    const errores = responseLive.data?.errors;
    if (errores && Object.keys(errores).length > 0) return;

    const partidosLiveCrudos = responseLive.data?.response || [];
    partidosEnVivoCache = []; 

    partidosLiveCrudos.forEach(fixture => {
      const homeName = fixture.teams.home.name;
      const awayName = fixture.teams.away.name;

      const favHome = obtenerFavoritoSiCoincide(homeName);
      const favAway = obtenerFavoritoSiCoincide(awayName);
      const equipoFavoritoEncontrado = favHome || favAway;

      if (equipoFavoritoEncontrado) {
        const statusCorto = fixture.fixture.status.short;
        const elapsed = fixture.fixture.status.elapsed;
        const extra = fixture.fixture.status.extra;

        let tiempoAmostrar = '';
        if (statusCorto === 'HT') tiempoAmostrar = 'Medio Tiempo';
        else if (['FT', 'AET', 'PEN'].includes(statusCorto)) tiempoAmostrar = 'Finalizado';
        else if (extra) tiempoAmostrar = `${elapsed} + ${extra}'`; 
        else tiempoAmostrar = `${elapsed}'`; 

        // Filtrado de penales errados
        const eventos = fixture.events || [];
        const anotadoresData = eventos.filter(e => e.type === 'Goal' && e.detail !== 'Missed Penalty')
          .map(e => ({ equipo: e.team.name, jugador: e.player.name || 'Desconocido', minuto: e.time.elapsed, tipo: e.detail === 'Own Goal' ? 'Autogol' : e.detail === 'Penalty' ? 'Penal' : 'Gol' }));

        const tarjetasData = eventos.filter(e => e.type === 'Card')
          .map(e => ({ equipo: e.team.name, jugador: e.player.name || 'Desconocido', minuto: e.time.elapsed, tipo: e.detail.toLowerCase().includes('yellow') ? 'Amarilla' : 'Roja' }));

        partidosEnVivoCache.push({
          id: fixture.fixture.id,
          equipoIdFiltro1: equipoFavoritoEncontrado.idFootball, 
          equipoIdFiltro2: equipoFavoritoEncontrado.idFootball,
          local: fixture.teams.home.name,
          logoLocal: favHome ? favHome.logo : fixture.teams.home.logo,
          visitante: fixture.teams.away.name,
          logoVisitante: favAway ? favAway.logo : fixture.teams.away.logo,
          golesLocal: fixture.goals.home ?? 0,
          golesVisitante: fixture.goals.away ?? 0,
          minuto: tiempoAmostrar,
          estado: statusCorto,
          esEnVivo: true,
          anotadores: anotadoresData,
          tarjetas: tarjetasData
        });
      }
    });

    emitirDatosAlFrontend();
  } catch (error) {
    console.error('❌ Error de conexión con API-Football al buscar en vivo:', error.message);
  }
}

// 🚀 ARRANQUES E INTERVALOS
buscarPartidosEnVivo(); 
setTimeout(cargarProximosPartidosProgresivamente, 2000); 

// Consultamos en vivo cada 10 min
setInterval(buscarPartidosEnVivo, INTERVALO_CONSULTA); 
// ♻️ ACTUALIZAMOS EL CALENDARIO DE PRÓXIMOS CADA 30 MINUTOS
setInterval(cargarProximosPartidosProgresivamente, 30 * 60 * 1000);

io.on('connection', (socket) => {
  emitirDatosAlFrontend(socket);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Servidor Multi-API corriendo en puerto ${PORT}`));