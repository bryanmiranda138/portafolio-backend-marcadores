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

// 📌 TUS EQUIPOS FAVORITOS (Con ID exacto de TheSportsDB para evitar filiales y escudos erróneos)
const EQUIPOS_FAVORITOS = [
  { nombre: 'FC Barcelona',   idFootball: 529,  idSportsDB: 133739, strSearch: 'Barcelona' },
  { nombre: 'Real Madrid',    idFootball: 541,  idSportsDB: 133604, strSearch: 'Real Madrid' },
  { nombre: 'Boca Juniors',   idFootball: 451,  idSportsDB: 135205, strSearch: 'Boca Juniors' },
  { nombre: 'River Plate',    idFootball: 435,  idSportsDB: 135211, strSearch: 'River Plate' },
  { nombre: 'Liverpool',      idFootball: 40,   idSportsDB: 133602, strSearch: 'Liverpool' },
  { nombre: 'Manchester City',idFootball: 50,   idSportsDB: 133613, strSearch: 'Manchester City' },
  { nombre: 'C.D. Águila',    idFootball: 2307, idSportsDB: 140411, strSearch: 'Aguila' }, 
  { nombre: 'Inter Miami CF', idFootball: [9723, 8984], idSportsDB: 140989, strSearch: 'Inter Miami' },
  { nombre: 'Argentina',      idFootball: 26,   idSportsDB: 135275, strSearch: 'Argentina' },
  { nombre: 'Brasil',         idFootball: 6,    idSportsDB: 135276, strSearch: 'Brazil' },
  { nombre: 'Inglaterra',     idFootball: 10,   idSportsDB: 133702, strSearch: 'England' },
  { nombre: 'Francia',        idFootball: 2,    idSportsDB: 133714, strSearch: 'France' },
  { nombre: 'España',         idFootball: 9,    idSportsDB: 133738, strSearch: 'Spain' }
];

// 🛡️ EXCLUSIONES CONOCIDAS PARA EVITAR FALSOS POSITIVOS
const EXCLUSIONES = [
  'new england',            // Evita New England Revolution (confundido con England)
  'barcelona sc',           // Evita Barcelona SC de Ecuador (confundido con FC Barcelona)
  'barcelona de guayaquil',
  'liverpool montevideo',   // Evita Liverpool de Uruguay
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

  const proximosFiltrados = cacheProximosPartidos.filter(p => !idsJugandoAhora.has(p.equipoTrackedId));
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
function obtenerFavoritoSiCoincide(nombreEquipoAPI) {
  if (!nombreEquipoAPI) return null;
  const nombreNorm = nombreEquipoAPI.toLowerCase().trim();

  // 1. Si el equipo coincide con alguna exclusión, se descarta de inmediato
  if (EXCLUSIONES.some(ex => nombreNorm.includes(ex))) {
    return null;
  }

  // 2. Comprobación estricta con palabras completas
  for (const fav of EQUIPOS_FAVORITOS) {
    const searchNorm = fav.strSearch.toLowerCase().trim();
    const nombreFavNorm = fav.nombre.toLowerCase().trim();

    // Coincidencia exacta
    if (nombreNorm === searchNorm || nombreNorm === nombreFavNorm) {
      return fav;
    }

    // Coincidencia por límite de palabra (\b) para no confundir subpalabras
    const regex = new RegExp(`\\b${searchNorm}\\b`, 'i');
    if (regex.test(nombreNorm)) {
      return fav;
    }
  }

  return null;
}

// 1️⃣ API #1: TheSportsDB (Búsqueda exacta por ID para garantizar los escudos nativos)
async function cargarProximosPartidosProgresivamente() {
  if (cargandoProximos) return;
  cargandoProximos = true;
  console.log('⏳ Iniciando buscador de próximos partidos...');

  let listaTemporal = [];

  for (const equipo of EQUIPOS_FAVORITOS) {
    const mainFavId = Array.isArray(equipo.idFootball) ? equipo.idFootball[0] : equipo.idFootball;

    try {
      // 🚀 Consulta directa al equipo por su ID oficial para no equivocarnos de filial
      const urlBusqueda = `https://www.thesportsdb.com/api/v1/json/3/lookupteam.php?id=${equipo.idSportsDB}`;
      const resBusqueda = await axios.get(urlBusqueda);
      const equipoEncontrado = resBusqueda.data?.teams?.[0];
      
      if (equipoEncontrado) {
        const urlPartidos = `https://www.thesportsdb.com/api/v1/json/3/eventsnext.php?id=${equipoEncontrado.idTeam}`;
        const resPartidos = await axios.get(urlPartidos);
        const proximosEventos = resPartidos.data?.events;

        if (proximosEventos && proximosEventos.length > 0) {
          const ahora = Date.now();

          // 🧠 FILTRO DE SEGURIDAD
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
            
            const esLocal = fixtureFutu.idHomeTeam === equipoEncontrado.idTeam;
            
            listaTemporal.push({
              id: fixtureFutu.idEvent,
              equipoTrackedId: mainFavId,
              local: fixtureFutu.strHomeTeam,
              // 🛡️ Asignamos el escudo nativo que devuelve la API
              logoLocal: fixtureFutu.strHomeTeamBadge || (esLocal ? equipoEncontrado.strTeamBadge : null),
              visitante: fixtureFutu.strAwayTeam,
              // 🛡️ Asignamos el escudo nativo que devuelve la API
              logoVisitante: fixtureFutu.strAwayTeamBadge || (!esLocal ? equipoEncontrado.strTeamBadge : null),
              golesLocal: 0, 
              golesVisitante: 0,
              minuto: fechaFormateada,
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
      } else {
         throw new Error("Equipo no encontrado"); 
      }
    } catch (err) {
      // Imagen genérica en caso de no haber partido (Rival por definir)
      const urlEscudoRespaldo = `https://media.api-sports.io/football/teams/${mainFavId}.png`;
      listaTemporal.push({
        id: `tbd-${mainFavId}`,
        equipoTrackedId: mainFavId, 
        local: equipo.nombre, 
        logoLocal: urlEscudoRespaldo,
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
      console.error('⚠️ API-Football devolvió un mensaje/error:', JSON.stringify(errores));
      return;
    }

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

        // 🧠 1. FILTRO DE GOLES REALES
        const anotadoresData = eventos
          .filter(e => e.type === 'Goal' && e.detail !== 'Missed Penalty')
          .map(e => ({
            equipo: e.team.name,
            jugador: e.player.name || 'Desconocido',
            minuto: e.time.elapsed,
            tipo: e.detail === 'Own Goal' ? 'Autogol' : e.detail === 'Penalty' ? 'Penal' : 'Gol'
          }));

        // 🟨 🟥 2. CAPTURA DE TARJETAS
        const tarjetasData = eventos
          .filter(e => e.type === 'Card')
          .map(e => ({
            equipo: e.team.name,
            jugador: e.player.name || 'Desconocido',
            minuto: e.time.elapsed,
            tipo: e.detail.toLowerCase().includes('yellow') ? 'Amarilla' : 'Roja'
          }));

        // Resolvemos el ID en caso de que sea un array
        const mainFavId = Array.isArray(equipoFavoritoEncontrado.idFootball) 
          ? equipoFavoritoEncontrado.idFootball[0] 
          : equipoFavoritoEncontrado.idFootball;

        partidosEnVivoCache.push({
          id: fixture.fixture.id,
          equipoIdFiltro1: mainFavId, 
          equipoIdFiltro2: mainFavId,
          local: fixture.teams.home.name,
          logoLocal: fixture.teams.home.logo,
          visitante: fixture.teams.away.name,
          logoVisitante: fixture.teams.away.logo,
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

setInterval(buscarPartidosEnVivo, INTERVALO_CONSULTA);
// Añadido para que la lista de próximos partidos se limpie/actualice periódicamente (cada 30 min)
setInterval(cargarProximosPartidosProgresivamente, 30 * 60 * 1000);

io.on('connection', (socket) => {
  emitirDatosAlFrontend(socket);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Servidor Multi-API corriendo en puerto ${PORT}`));