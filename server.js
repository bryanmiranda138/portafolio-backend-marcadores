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
  { nombre: 'Inter Miami', idFootball: 9723, strSearch: 'Inter Miami' },
  { nombre: 'Argentina',      idFootball: 26,   strSearch: 'Argentina' },
  { nombre: 'Brasil',         idFootball: 6,    strSearch: 'Brazil' },
  { nombre: 'Inglaterra',     idFootball: 10,   strSearch: 'England' },
  { nombre: 'Francia',        idFootball: 2,    strSearch: 'France' },
  { nombre: 'España',         idFootball: 9,    strSearch: 'Spain' }
];

// Consulta en vivo cada 3 minutos
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

// 1️⃣ API #1: TheSportsDB (Próximos Partidos)
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
          const fixtureFutu = proximosEventos[0];
          
          // 🇸🇻 Convertimos la fecha UTC a Hora de El Salvador (UTC-6)
          const fechaUTC = new Date(fixtureFutu.strTimestamp);
          const fechaElSalvador = new Date(fechaUTC.getTime() - (6 * 60 * 60 * 1000));
          const fechaFormateada = fechaElSalvador.toLocaleDateString('es-ES', { 
            day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
            timeZone: 'UTC'
          });
          
          const esLocal = fixtureFutu.idHomeTeam === equipoEncontrado.idTeam;
          
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

// 2️⃣ API #2: API-Football (Partidos En Vivo con priorización de estados)
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

    const targetIds = EQUIPOS_FAVORITOS.map(e => e.idFootball);
    const partidosLiveCrudos = responseLive.data?.response || [];
    
    console.log(`🌐 API-Football reporta ${partidosLiveCrudos.length} partidos jugándose en el mundo en este momento.`);

    partidosEnVivoCache = []; 

    partidosLiveCrudos.forEach(fixture => {
      const homeId = fixture.teams.home.id;
      const awayId = fixture.teams.away.id;

      if (targetIds.includes(homeId) || targetIds.includes(awayId)) {
        console.log(`⚽ ¡PARTIDO EN VIVO ENCONTRADO! ${fixture.teams.home.name} vs ${fixture.teams.away.name}`);
        
        const statusCorto = fixture.fixture.status.short;
        const elapsed = fixture.fixture.status.elapsed;
        const extra = fixture.fixture.status.extra;

        // 🧠 LÓGICA CORREGIDA CON "ELSE IF"
        let tiempoAmostrar = '';

        if (statusCorto === 'HT') {
          tiempoAmostrar = 'Medio Tiempo'; // Prioridad #1: Si es Medio Tiempo, muestra el texto
        } else if (['FT', 'AET', 'PEN'].includes(statusCorto)) {
          tiempoAmostrar = 'Finalizado';
        } else if (extra) {
          tiempoAmostrar = `${elapsed} + ${extra}'`; // Si está en juego y tiene tiempo agregado (ej: 45 + 2')
        } else {
          tiempoAmostrar = `${elapsed}'`; // Minuto normal en juego
        }

        const anotadoresData = (fixture.events || []).filter(e => e.type === 'Goal').map(e => ({
          equipo: e.team.name, jugador: e.player.name || 'Desconocido', minuto: e.time.elapsed, tipo: e.detail
        }));

        partidosEnVivoCache.push({
          id: fixture.fixture.id,
          equipoIdFiltro1: homeId,
          equipoIdFiltro2: awayId,
          local: fixture.teams.home.name,
          logoLocal: fixture.teams.home.logo,
          visitante: fixture.teams.away.name,
          logoVisitante: fixture.teams.away.logo,
          golesLocal: fixture.goals.home ?? 0,
          golesVisitante: fixture.goals.away ?? 0,
          minuto: tiempoAmostrar,
          estado: statusCorto,
          esEnVivo: true,
          anotadores: anotadoresData
        });
      }
    });

    if (partidosEnVivoCache.length === 0) {
      console.log('ℹ️ Ninguno de tus 13 equipos favoritos está jugando en vivo en este preciso momento.');
    }

    emitirDatosAlFrontend();
  } catch (error) {
    console.error('❌ Error de conexión con API-Football al buscar en vivo:', error.message);
  }
}

// 🚀 ARRANQUE INMEDIATO
buscarPartidosEnVivo(); // Executar de inmediato al arrancar el servidor
setTimeout(cargarProximosPartidosProgresivamente, 2000); 

// Programar la búsqueda recurrente en vivo
setInterval(buscarPartidosEnVivo, INTERVALO_CONSULTA); 

io.on('connection', (socket) => {
  emitirDatosAlFrontend(socket);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Servidor Multi-API corriendo en puerto ${PORT}`));