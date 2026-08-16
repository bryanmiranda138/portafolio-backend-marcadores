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
  { nombre: 'FC Barcelona',   idFootball: 529,  strSearch: 'Barcelona' },
  { nombre: 'Real Madrid',    idFootball: 541,  strSearch: 'Real Madrid' },
  { nombre: 'Boca Juniors',   idFootball: 451,  strSearch: 'Boca Juniors' },
  { nombre: 'River Plate',    idFootball: 435,  strSearch: 'River Plate' },
  { nombre: 'Liverpool',      idFootball: 40,   strSearch: 'Liverpool' },
  { nombre: 'Manchester City',idFootball: 50,   strSearch: 'Manchester City' },
  { nombre: 'C.D. Águila',    idFootball: 2307, strSearch: 'Aguila' }, 
  { nombre: 'Inter Miami',    idFootball: 8984, strSearch: 'Inter Miami' },
  { nombre: 'Argentina',      idFootball: 26,   strSearch: 'Argentina' },
  { nombre: 'Brasil',         idFootball: 6,    strSearch: 'Brazil' },
  { nombre: 'Inglaterra',     idFootball: 10,   strSearch: 'England' },
  { nombre: 'Francia',        idFootball: 2,    strSearch: 'France' },
  { nombre: 'España',         idFootball: 9,    strSearch: 'Spain' }
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

const DATOS_RESPALDO = [
  { id: 991, equipoTrackedId: 541, local: 'Real Madrid', logoLocal: 'https://media.api-sports.io/football/teams/541.png', visitante: 'AC Milan', logoVisitante: 'https://media.api-sports.io/football/teams/489.png', golesLocal: 0, golesVisitante: 0, minuto: 'Sábado, 13:00', estado: 'PROXIMO', esEnVivo: false, anotadores: [] },
  { id: 992, equipoTrackedId: 529, local: 'FC Barcelona', logoLocal: 'https://media.api-sports.io/football/teams/529.png', visitante: 'Arsenal', logoVisitante: 'https://media.api-sports.io/football/teams/42.png', golesLocal: 0, golesVisitante: 0, minuto: 'Domingo, 10:00', estado: 'PROXIMO', esEnVivo: false, anotadores: [] }
];

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

// 1️⃣ API #1: TheSportsDB (Próximos Partidos con Filtro de Tiempo Futuro)
async function cargarProximosPartidosProgresivamente() {
  if (cargandoProximos) return;
  cargandoProximos = true;
  console.log('⏳ Iniciando buscador dinámico de próximos partidos...');

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
          const ahora = Date.now();

          // 🧠 FILTRO DE SEGURIDAD: Solo aceptamos partidos cuya hora de inicio sea en el FUTURO
          const eventosRealmenteFuturos = proximosEventos.filter(ev => {
            if (!ev.strTimestamp) return false;
            const fechaEv = new Date(ev.strTimestamp).getTime();
            return fechaEv > ahora; // Ignora partidos pasados o que ya iniciaron
          });

          if (eventosRealmenteFuturos.length > 0) {
            const fixtureFutu = eventosRealmenteFuturos[0];
            
            const fechaUTC = new Date(fixtureFutu.strTimestamp);
            const fechaElSalvador = new Date(fechaUTC.getTime() - (6 * 60 * 60 * 1000));
            const fechaFormateada = fechaElSalvador.toLocaleDateString('es-ES', { 
              day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
              timeZone: 'UTC'
            });
            
            const esLocal = String(fixtureFutu.idHomeTeam) === String(equipoEncontrado.idTeam);
            
            listaTemporal.push({
              id: fixtureFutu.idEvent,
              equipoTrackedId: equipo.idFootball,
              local: fixtureFutu.strHomeTeam,
              logoLocal: fixtureFutu.strHomeTeamBadge || (esLocal ? equipoEncontrado.strTeamBadge : null),
              visitante: fixtureFutu.strAwayTeam,
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
      const urlEscudoRespaldo = `https://media.api-sports.io/football/teams/${equipo.idFootball}.png`;
      listaTemporal.push({
        id: `tbd-${equipo.idFootball}`,
        equipoTrackedId: equipo.idFootball, 
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

// 2️⃣ API #2: API-Football (Partidos en vivo con filtro de penales errados y tarjetas)
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

        partidosEnVivoCache.push({
          id: fixture.fixture.id,
          equipoIdFiltro1: equipoFavoritoEncontrado.idFootball, 
          equipoIdFiltro2: equipoFavoritoEncontrado.idFootball,
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
          tarjetas: tarjetasData // 👈 Agregamos las tarjetas al objeto enviado
        });
      }
    });

    emitirDatosAlFrontend();
  } catch (error) {
    console.error('❌ Error de conexión con API-Football al buscar en vivo:', error.message);
  }
}

// 🚀 ARRANQUE INMEDIATO
buscarPartidosEnVivo(); 
setTimeout(cargarProximosPartidosProgresivamente, 2000); 

setInterval(buscarPartidosEnVivo, INTERVALO_CONSULTA); 

io.on('connection', (socket) => {
  emitirDatosAlFrontend(socket);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Servidor Multi-API corriendo en puerto ${PORT}`));