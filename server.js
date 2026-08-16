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

// 📌 TUS EQUIPOS FAVORITOS (Con IDs exactos y Escudos Oficiales Blindados)
const EQUIPOS_FAVORITOS = [
  { nombre: 'FC Barcelona',   idFootball: 529,  idSportsDB: 133739, strSearch: 'Barcelona', logo: 'https://media.api-sports.io/football/teams/529.png' },
  { nombre: 'Real Madrid',    idFootball: 541,  idSportsDB: 133604, strSearch: 'Real Madrid', logo: 'https://media.api-sports.io/football/teams/541.png' },
  { nombre: 'Boca Juniors',   idFootball: 451,  idSportsDB: 135205, strSearch: 'Boca Juniors', logo: 'https://media.api-sports.io/football/teams/451.png' },
  { nombre: 'River Plate',    idFootball: 435,  idSportsDB: 135211, strSearch: 'River Plate', logo: 'https://media.api-sports.io/football/teams/435.png' },
  { nombre: 'Liverpool',      idFootball: 40,   idSportsDB: 133602, strSearch: 'Liverpool', logo: 'https://media.api-sports.io/football/teams/40.png' },
  { nombre: 'Manchester City',idFootball: 50,   idSportsDB: 133613, strSearch: 'Manchester City', logo: 'https://media.api-sports.io/football/teams/50.png' },
  { nombre: 'C.D. Águila',    idFootball: 2307, idSportsDB: 140411, strSearch: 'Aguila', logo: 'https://media.api-sports.io/football/teams/2307.png' }, 
  { nombre: 'Inter Miami',    idFootball: [9723, 8984], idSportsDB: 140989, strSearch: 'Inter Miami', logo: 'https://media.api-sports.io/football/teams/9723.png' },
  { nombre: 'Argentina',      idFootball: 26,   idSportsDB: 135275, strSearch: 'Argentina', logo: 'https://media.api-sports.io/football/teams/26.png' },
  { nombre: 'Brasil',         idFootball: 6,    idSportsDB: 135276, strSearch: 'Brazil', logo: 'https://media.api-sports.io/football/teams/6.png' },
  { nombre: 'Inglaterra',     idFootball: 10,   idSportsDB: 133702, strSearch: 'England', logo: 'https://media.api-sports.io/football/teams/10.png' },
  { nombre: 'Francia',        idFootball: 2,    idSportsDB: 133714, strSearch: 'France', logo: 'https://media.api-sports.io/football/teams/2.png' },
  { nombre: 'España',         idFootball: 9,    idSportsDB: 133738, strSearch: 'Spain', logo: 'https://media.api-sports.io/football/teams/9.png' }
];

// 🛡️ EXCLUSIONES CONOCIDAS PARA EVITAR FALSOS POSITIVOS
const EXCLUSIONES = [
  'new england',            // Evita New England Revolution (confundido con England)
  'barcelona sc',           // Evita Barcelona SC de Ecuador
  'barcelona de guayaquil',
  'liverpool montevideo',   
  'river plate montevideo',
  'real madrid b',
  'barcelona b'
];

const INTERVALO_CONSULTA = 3 * 60 * 1000; 

let cacheProximosPartidos = [];
let cargandoProximos = false;
let partidosEnVivoCache = []; 

const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
    
    // 2. Si es una tarjeta TBD, dejarla en pantalla
    if (p.id.toString().startsWith('tbd')) return true;

    // 3. Eliminar partidos cuya hora de inicio ya pasó
    if (p.timestamp && p.timestamp <= ahora) return false;

    return true;
  });

  const listaBruta = [...partidosEnVivoCache, ...proximosFiltrados];
  
  const mapaDeduplicacion = new Map();
  listaBruta.forEach(partido => {
    if (!mapaDeduplicacion.has(partido.id)) {
      mapaDeduplicacion.set(partido.id, partido);
    }
  });
  
  let listaFinal = Array.from(mapaDeduplicacion.values());

  if (socketEspecifico) {
    socketEspecifico.emit('marcadores_actualizados', listaFinal);
  } else {
    io.emit('marcadores_actualizados', listaFinal);
  }
}

// 🧠 FUNCIÓN AUXILIAR DE VALIDACIÓN ESTRICTA
function obtenerFavoritoSiCoincide(nombreEquipoAPI, idEquipoAPI = null) {
  // Comprobación previa por ID directo de API-Football
  if (idEquipoAPI) {
    const favPorId = EQUIPOS_FAVORITOS.find(f => {
      if (Array.isArray(f.idFootball)) return f.idFootball.includes(idEquipoAPI);
      return f.idFootball === idEquipoAPI;
    });
    if (favPorId) return favPorId;
  }

  if (!nombreEquipoAPI) return null;
  const nombreNorm = nombreEquipoAPI.toLowerCase().trim();

  if (EXCLUSIONES.some(ex => nombreNorm.includes(ex))) {
    return null;
  }

  for (const fav of EQUIPOS_FAVORITOS) {
    const searchNorm = fav.strSearch.toLowerCase().trim();
    const nombreFavNorm = fav.nombre.toLowerCase().trim();

    if (nombreNorm === searchNorm || nombreNorm === nombreFavNorm) {
      return fav;
    }

    const regex = new RegExp(`\\b${searchNorm}\\b`, 'i');
    if (regex.test(nombreNorm)) {
      return fav;
    }
  }

  return null;
}

// 1️⃣ API #1: TheSportsDB (Consulta directa por idSportsDB con Escudo Garantizado)
async function cargarProximosPartidosProgresivamente() {
  if (cargandoProximos) return;
  cargandoProximos = true;
  console.log('⏳ Consultando calendario de próximos partidos...');

  let listaTemporal = [];

  for (const equipo of EQUIPOS_FAVORITOS) {
    try {
      // Consulta directa por idSportsDB exacto
      const urlPartidos = `https://www.thesportsdb.com/api/v1/json/3/eventsnext.php?id=${equipo.idSportsDB}`;
      const resPartidos = await axios.get(urlPartidos);
      const proximosEventos = resPartidos.data?.events;

      if (proximosEventos && proximosEventos.length > 0) {
        const ahora = Date.now();

        // FILTRO: Solo aceptamos partidos futuros
        const eventosRealmenteFuturos = proximosEventos.filter(ev => {
          if (!ev.strTimestamp) return false;
          const fechaEv = new Date(ev.strTimestamp).getTime();
          return fechaEv > ahora;
        });

        if (eventosRealmenteFuturos.length > 0) {
          const fixtureFutu = eventosRealmenteFuturos[0];
          
          const fechaUTC = new Date(fixtureFutu.strTimestamp);
          const fechaElSalvador = new Date(fechaUTC.getTime() - (6 * 60 * 60 * 1000));
          const fechaFormateada = fechaElSalvador.toLocaleDateString('es-ES', { 
            day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
            timeZone: 'UTC'
          });
          
          const esLocal = fixtureFutu.idHomeTeam.toString() === equipo.idSportsDB.toString();
          const mainFavId = Array.isArray(equipo.idFootball) ? equipo.idFootball[0] : equipo.idFootball;

          listaTemporal.push({
            id: fixtureFutu.idEvent,
            equipoTrackedId: mainFavId,
            local: fixtureFutu.strHomeTeam,
            logoLocal: esLocal ? equipo.logo : (fixtureFutu.strHomeTeamBadge || null),
            visitante: fixtureFutu.strAwayTeam,
            logoVisitante: !esLocal ? equipo.logo : (fixtureFutu.strAwayTeamBadge || null),
            golesLocal: 0, 
            golesVisitante: 0,
            minuto: fechaFormateada,
            timestamp: fechaUTC.getTime(),
            estado: 'PROXIMO',
            esEnVivo: false,
            anotadores: [] 
          });
        } else {
           throw new Error("El partido ya ocurrió o está en curso"); 
        }
      } else {
         throw new Error("Agenda vacía"); 
      }
    } catch (err) {
      const mainFavId = Array.isArray(equipo.idFootball) ? equipo.idFootball[0] : equipo.idFootball;
      listaTemporal.push({
        id: `tbd-${mainFavId}`,
        equipoTrackedId: mainFavId, 
        local: equipo.nombre, 
        logoLocal: equipo.logo,
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
    await esperar(800); 
  }
  cargandoProximos = false;
}

// 2️⃣ API #2: API-Football (Partidos en vivo con filtro de penales errados, tarjetas y escudo asignado)
async function buscarPartidosEnVivo() {
  try {
    console.log('🔍 Consultando partidos en vivo en API-Football...');
    
    const responseLive = await axios.get('https://v3.football.api-sports.io/fixtures?live=all', {
      headers: { 'x-apisports-key': process.env.FOOTBALL_API_KEY }
    });

    const errores = responseLive.data?.errors;
    if (errores && Object.keys(errores).length > 0) {
      console.error('⚠️ API-Football devolvió un mensaje/error:', JSON.stringify(errores));
      return;
    }

    const partidosLiveCrudos = responseLive.data?.response || [];
    partidosEnVivoCache = []; 

    partidosLiveCrudos.forEach(fixture => {
      const homeName = fixture.teams.home.name;
      const awayName = fixture.teams.away.name;
      const homeId = fixture.teams.home.id;
      const awayId = fixture.teams.away.id;

      const favHome = obtenerFavoritoSiCoincide(homeName, homeId);
      const favAway = obtenerFavoritoSiCoincide(awayName, awayId);
      const equipoFavoritoEncontrado = favHome || favAway;

      if (equipoFavoritoEncontrado) {
        const statusCorto = fixture.fixture.status.short;
        const elapsed = fixture.fixture.status.elapsed;
        const extra = fixture.fixture.status.extra;

        let tiempoAmostrar = '';
        if (statusCorto === 'HT') {
          tiempoAmostrar = 'Medio Tiempo';
        } else if (['FT', 'AET', 'PEN'].includes(statusCorto)) {
          tiempoAmostrar = 'Finalizado';
        } else if (extra) {
          tiempoAmostrar = `${elapsed} + ${extra}'`; 
        } else {
          tiempoAmostrar = `${elapsed}'`; 
        }

        const eventos = fixture.events || [];

        // 🧠 1. FILTRO DE GOLES REALES (Excluimos 'Missed Penalty')
        const anotadoresData = eventos
          .filter(e => e.type === 'Goal' && e.detail !== 'Missed Penalty')
          .map(e => ({
            equipo: e.team.name,
            jugador: e.player.name || 'Desconocido',
            minuto: e.time.elapsed,
            tipo: e.detail === 'Own Goal' ? 'Autogol' : e.detail === 'Penalty' ? 'Penal' : 'Gol'
          }));

        // 🟨 🟥 2. CAPTURA DE TARJETAS (Amarillas y Rojas)
        const tarjetasData = eventos
          .filter(e => e.type === 'Card')
          .map(e => ({
            equipo: e.team.name,
            jugador: e.player.name || 'Desconocido',
            minuto: e.time.elapsed,
            tipo: e.detail.toLowerCase().includes('yellow') ? 'Amarilla' : 'Roja'
          }));

        const mainFavId = Array.isArray(equipoFavoritoEncontrado.idFootball) 
          ? equipoFavoritoEncontrado.idFootball[0] 
          : equipoFavoritoEncontrado.idFootball;

        partidosEnVivoCache.push({
          id: fixture.fixture.id,
          equipoIdFiltro1: mainFavId, 
          equipoIdFiltro2: mainFavId,
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

// 🚀 ARRANQUE INMEDIATO E INTERVALOS
buscarPartidosEnVivo(); 
setTimeout(cargarProximosPartidosProgresivamente, 2000); 

setInterval(buscarPartidosEnVivo, INTERVALO_CONSULTA); 
setInterval(cargarProximosPartidosProgresivamente, 30 * 60 * 1000);

io.on('connection', (socket) => {
  emitirDatosAlFrontend(socket);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Servidor Multi-API corriendo en puerto ${PORT}`));