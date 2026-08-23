require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');

// --- CONFIGURACIÓN ---
const CONFIG = {
  PORT: process.env.PORT || 4000,
  INTERVALO_LIVE: 3 * 60 * 1000, // 3 minutos
  FOOTBALL_API_KEY: process.env.FOOTBALL_API_KEY,
  TZ_OFFSET: 6 * 60 * 60 * 1000, // Offset para El Salvador (UTC-6)
};

if (!CONFIG.FOOTBALL_API_KEY) {
  console.error('❌ ERROR: La variable FOOTBALL_API_KEY no está definida en el archivo .env');
}

const EQUIPOS_FAVORITOS = [
  { nombre: 'FC Barcelona', idFootball: 529, strSearch: 'Barcelona' },
  { nombre: 'Real Madrid', idFootball: 541, strSearch: 'Real Madrid' },
  { nombre: 'Boca Juniors', idFootball: 451, strSearch: 'Boca Juniors' },
  { nombre: 'River Plate', idFootball: 435, strSearch: 'River Plate' },
  { nombre: 'Liverpool', idFootball: 40, strSearch: 'Liverpool' },
  { nombre: 'Manchester City', idFootball: 50, strSearch: 'Manchester City' },
  { nombre: 'C.D. Águila', idFootball: 2307, strSearch: 'Aguila' },
  { nombre: 'Inter Miami', idFootball: 8984, strSearch: 'Inter Miami' },
  { nombre: 'Argentina', idFootball: 26, strSearch: 'Argentina' },
  { nombre: 'Brasil', idFootball: 6, strSearch: 'Brazil' },
  { nombre: 'Inglaterra', idFootball: 10, strSearch: 'England' },
  { nombre: 'Francia', idFootball: 2, strSearch: 'France' },
  { nombre: 'España', idFootball: 9, strSearch: 'Spain' }
];

const EXCLUSIONES = ['new england', 'barcelona sc', 'barcelona de guayaquil', 'liverpool montevideo', 'river plate montevideo', 'real madrid b', 'barcelona b'];

// --- ESTADO GLOBAL ---
let cacheProximosPartidos = [];
let partidosEnVivoCache = [];
let cargandoProximos = false;
const teamIdCacheTSDB = new Map(); // Caché para no buscar el ID de TheSportsDB repetidamente

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// --- RUTAS ---
app.get('/', (req, res) => res.send('⚽ Servidor de Marcadores funcionando.'));
app.get('/debug', (req, res) => res.json({ proximos: cacheProximosPartidos, enVivo: partidosEnVivoCache }));

// --- UTILIDADES ---
const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function obtenerFavoritoSiCoincide(nombreEquipoAPI) {
  if (!nombreEquipoAPI) return null;
  const nombreNorm = nombreEquipoAPI.toLowerCase().trim();

  if (EXCLUSIONES.some(ex => nombreNorm.includes(ex))) return null;

  return EQUIPOS_FAVORITOS.find(fav => {
    const searchNorm = fav.strSearch.toLowerCase().trim();
    const nombreFavNorm = fav.nombre.toLowerCase().trim();
    const regex = new RegExp(`\\b${searchNorm}\\b`, 'i');
    return nombreNorm === searchNorm || nombreNorm === nombreFavNorm || regex.test(nombreNorm);
  }) || null;
}

function emitirDatosAlFrontend(socketEspecifico = null) {
  const idsJugandoAhora = new Set(partidosEnVivoCache.flatMap(p => [p.equipoIdFiltro1, p.equipoIdFiltro2]));

  // Evitamos mostrar en "Próximos" algo que ya está "En Vivo"
  const proximosFiltrados = cacheProximosPartidos.filter(p => !idsJugandoAhora.has(p.equipoTrackedId));

  // Deduplicamos por ID de partido (TheSportsDB ID o API-Football ID)
  const listaFinal = [...partidosEnVivoCache, ...proximosFiltrados].reduce((acc, current) => {
    if (!acc.find(item => item.id === current.id)) acc.push(current);
    return acc;
  }, []);

  if (socketEspecifico) {
    socketEspecifico.emit('marcadores_actualizados', listaFinal);
  } else {
    io.emit('marcadores_actualizados', listaFinal);
  }
}

// --- LÓGICA DE APIS ---

// 1. TheSportsDB: Próximos Partidos
async function cargarProximosPartidosProgresivamente() {
  if (cargandoProximos) return;
  cargandoProximos = true;
  console.log('⏳ Actualizando agenda de próximos partidos...');

  let nuevaListaProximos = [];

  for (const equipo of EQUIPOS_FAVORITOS) {
    try {
      let idTSDB = teamIdCacheTSDB.get(equipo.idFootball);
      let teamData = null;

      // Si no tenemos el ID en caché, lo buscamos
      if (!idTSDB) {
        const resBusqueda = await axios.get(`https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(equipo.strSearch)}`);
        teamData = resBusqueda.data?.teams?.find(t => t.strSport === 'Soccer');
        if (teamData) {
          idTSDB = teamData.idTeam;
          teamIdCacheTSDB.set(equipo.idFootball, idTSDB);
        }
      }

      if (idTSDB) {
        const resPartidos = await axios.get(`https://www.thesportsdb.com/api/v1/json/3/eventsnext.php?id=${idTSDB}`);
        const proximosEventos = resPartidos.data?.events || [];
        const ahora = Date.now();

        const proximo = proximosEventos.find(ev => ev.strTimestamp && new Date(ev.strTimestamp).getTime() > ahora);

        if (proximo) {
          const fechaUTC = new Date(proximo.strTimestamp);
          const fechaLocal = new Date(fechaUTC.getTime() - CONFIG.TZ_OFFSET);
          const fechaFormateada = fechaLocal.toLocaleDateString('es-ES', {
            day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC'
          });

          nuevaListaProximos.push({
            id: proximo.idEvent,
            equipoTrackedId: equipo.idFootball,
            local: proximo.strHomeTeam,
            logoLocal: proximo.strHomeTeamBadge || `https://media.api-sports.io/football/teams/${equipo.idFootball}.png`,
            visitante: proximo.strAwayTeam,
            logoVisitante: proximo.strAwayTeamBadge,
            golesLocal: 0,
            golesVisitante: 0,
            minuto: fechaFormateada,
            estado: 'PROXIMO',
            esEnVivo: false,
            anotadores: []
          });
        }
      }
    } catch (err) {
      console.error(`⚠️ Error buscando próximos para ${equipo.nombre}:`, err.message);
      // Fallback si la API falla: Mantener info básica para no dejar el slot vacío
      nuevaListaProximos.push({
        id: `tbd-${equipo.idFootball}`,
        equipoTrackedId: equipo.idFootball,
        local: equipo.nombre,
        logoLocal: `https://media.api-sports.io/football/teams/${equipo.idFootball}.png`,
        visitante: 'Rival por definir',
        logoVisitante: null,
        golesLocal: 0,
        golesVisitante: 0,
        minuto: 'Pendiente',
        estado: 'PROXIMO',
        esEnVivo: false,
        anotadores: []
      });
    }

    // Actualizamos la caché global y avisamos al front gradualmente
    cacheProximosPartidos = [...nuevaListaProximos];
    emitirDatosAlFrontend();
    await esperar(1200); // Respetar rate limit de TheSportsDB
  }
  cargandoProximos = false;
  console.log('✅ Agenda actualizada.');
}

// 2. API-Football: Partidos en Vivo
async function buscarPartidosEnVivo() {
  if (!CONFIG.FOOTBALL_API_KEY) return;

  try {
    console.log('🔍 Revisando partidos en vivo...');
    const responseLive = await axios.get('https://v3.football.api-sports.io/fixtures?live=all', {
      headers: { 'x-apisports-key': CONFIG.FOOTBALL_API_KEY }
    });

    const data = responseLive.data;
    if (data.errors && Object.keys(data.errors).length > 0) {
      console.error('🛑 Error API-Football:', data.errors);
      return;
    }

    const partidosLiveCrudos = data.response || [];
    const nuevosEnVivo = [];

    partidosLiveCrudos.forEach(fixture => {
      try {
        const favHome = obtenerFavoritoSiCoincide(fixture.teams?.home?.name);
        const favAway = obtenerFavoritoSiCoincide(fixture.teams?.away?.name);
        const favorito = favHome || favAway;

        if (favorito) {
          const { status } = fixture.fixture;
          let tiempo = status.short === 'HT' ? 'M. Tiempo' : `${status.elapsed}'`;
          if (status.extra) tiempo = `${status.elapsed}+${status.extra}'`;
          if (['FT', 'AET', 'PEN'].includes(status.short)) tiempo = 'Final';

          const eventos = fixture.events || [];

          nuevosEnVivo.push({
            id: fixture.fixture.id,
            equipoIdFiltro1: favorito.idFootball,
            equipoIdFiltro2: favorito.idFootball,
            local: fixture.teams.home.name,
            logoLocal: fixture.teams.home.logo,
            visitante: fixture.teams.away.name,
            logoVisitante: fixture.teams.away.logo,
            golesLocal: fixture.goals.home ?? 0,
            golesVisitante: fixture.goals.away ?? 0,
            minuto: tiempo,
            estado: status.short,
            esEnVivo: true,
            anotadores: eventos
              .filter(e => e.type === 'Goal' && e.detail !== 'Missed Penalty')
              .map(e => ({
                equipo: e.team.name,
                jugador: e.player.name || '?',
                minuto: e.time.elapsed,
                tipo: e.detail === 'Own Goal' ? 'Autogol' : e.detail === 'Penalty' ? 'Penal' : 'Gol'
              })),
            tarjetas: eventos
              .filter(e => e.type === 'Card')
              .map(e => ({
                equipo: e.team.name,
                jugador: e.player.name || '?',
                minuto: e.time.elapsed,
                tipo: e.detail.toLowerCase().includes('yellow') ? 'Amarilla' : 'Roja'
              }))
          });
        }
      } catch (e) {
        console.error('⚠️ Error procesando partido individual:', e.message);
      }
    });

    partidosEnVivoCache = nuevosEnVivo;
    console.log(`📡 En vivo: ${partidosEnVivoCache.length} partidos de interés.`);
    emitirDatosAlFrontend();
  } catch (error) {
    console.error('❌ Error conexión API-Football:', error.message);
  }
}

// --- INICIO ---
io.on('connection', (socket) => {
  emitirDatosAlFrontend(socket);
});

// Ciclos de actualización
buscarPartidosEnVivo();
setTimeout(cargarProximosPartidosProgresivamente, 5000);

setInterval(buscarPartidosEnVivo, CONFIG.INTERVALO_LIVE);
// Recargar la agenda completa cada 1 hora para ver si hay nuevos partidos programados
setInterval(cargarProximosPartidosProgresivamente, 60 * 60 * 1000);

server.listen(CONFIG.PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${CONFIG.PORT}`);
});