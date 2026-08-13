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

// 📌 DICCIONARIO DE IDs (API-Football para En Vivo | TheSportsDB para Próximos)
const EQUIPOS_FAVORITOS = [
  { nombre: 'FC Barcelona',   idFootball: 529,  idSportsDB: 133739 },
  { nombre: 'Real Madrid',    idFootball: 541,  idSportsDB: 133604 },
  { nombre: 'Boca Juniors',   idFootball: 451,  idSportsDB: 135205 },
  { nombre: 'River Plate',    idFootball: 435,  idSportsDB: 135211 },
  { nombre: 'Liverpool',      idFootball: 40,   idSportsDB: 133602 },
  { nombre: 'Manchester City',idFootball: 50,   idSportsDB: 133613 },
  { nombre: 'C.D. Águila',    idFootball: 2307, idSportsDB: 140411 }, 
  { nombre: 'Inter Miami',    idFootball: 8984, idSportsDB: 140989 },
  { nombre: 'Argentina',      idFootball: 26,   idSportsDB: 135275 },
  { nombre: 'Brasil',         idFootball: 6,    idSportsDB: 135276 },
  { nombre: 'Inglaterra',     idFootball: 10,   idSportsDB: 133702 },
  { nombre: 'Francia',        idFootball: 2,    idSportsDB: 133714 },
  { nombre: 'España',         idFootball: 9,    idSportsDB: 133738 }
];

const INTERVALO_CONSULTA = 10 * 60 * 1000; 

let cacheProximosPartidos = [];
let cargandoProximos = false;
let partidosEnVivoCache = []; 

const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const DATOS_RESPALDO = [
  { id: 991, equipoTrackedId: 541, local: 'Real Madrid', visitante: 'AC Milan', golesLocal: 0, golesVisitante: 0, minuto: 'Sábado, 13:00', estado: 'PROXIMO', esEnVivo: false, anotadores: [] },
  { id: 992, equipoTrackedId: 529, local: 'FC Barcelona', visitante: 'Arsenal', golesLocal: 0, golesVisitante: 0, minuto: 'Domingo, 10:00', estado: 'PROXIMO', esEnVivo: false, anotadores: [] }
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
  const datosAEnviar = listaFinal.length > 0 ? listaFinal : DATOS_RESPALDO;

  if (socketEspecifico) {
    socketEspecifico.emit('marcadores_actualizados', datosAEnviar);
  } else {
    io.emit('marcadores_actualizados', datosAEnviar);
  }
}

// 1️⃣ API #1: TheSportsDB para Próximos Partidos (100% Gratis, sin API Key requerida)
async function cargarProximosPartidosProgresivamente() {
  if (cargandoProximos) return;
  cargandoProximos = true;
  console.log('⏳ Iniciando carga de próximos partidos desde TheSportsDB...');

  let listaTemporal = [];

  for (const equipo of EQUIPOS_FAVORITOS) {
    try {
      // Usamos el endpoint público v1/json/3 de TheSportsDB
      const urlSportsDB = `https://www.thesportsdb.com/api/v1/json/3/eventsnext.php?id=${equipo.idSportsDB}`;
      const response = await axios.get(urlSportsDB);

      // TheSportsDB devuelve un arreglo 'events', o null si no hay partidos programados pronto
      const eventos = response.data?.events;

      if (eventos && eventos.length > 0) {
        const fixture = eventos[0]; // Tomamos el más cercano
        
        // Convertimos la fecha de TheSportsDB (viene en UTC) a formato amigable
        const fechaPartido = new Date(fixture.strTimestamp);
        const fechaFormateada = fechaPartido.toLocaleDateString('es-ES', { 
          day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' 
        });
        
        listaTemporal.push({
          id: fixture.idEvent, // ID único del evento en TheSportsDB
          equipoTrackedId: equipo.idFootball, // Guardamos el ID de Football para que el filtro en vivo funcione
          local: fixture.strHomeTeam,
          visitante: fixture.strAwayTeam,
          golesLocal: 0,
          golesVisitante: 0,
          minuto: fechaFormateada,
          estado: 'PROXIMO',
          esEnVivo: false,
          anotadores: [] 
        });

        cacheProximosPartidos = [...listaTemporal];
        emitirDatosAlFrontend();
      }
    } catch (err) {
      console.error(`❌ Error consultando TheSportsDB para ${equipo.nombre}:`, err.message);
    }
    
    // TheSportsDB es muy generosa, pero esperamos 1 segundo entre peticiones por educación
    await esperar(1000); 
  }

  if (cacheProximosPartidos.length === 0) {
    console.log('🛡️ Usando datos de respaldo (TheSportsDB no devolvió partidos).');
    cacheProximosPartidos = [...DATOS_RESPALDO];
    emitirDatosAlFrontend();
  } else {
    console.log(`✅ Carga completada desde TheSportsDB: ${cacheProximosPartidos.length} partidos encontrados.`);
  }
  cargandoProximos = false;
}

// 2️⃣ API #2: API-Football para Partidos En Vivo (Usando tu llave)
async function buscarPartidosEnVivo() {
  try {
    const responseLive = await axios.get('https://v3.football.api-sports.io/fixtures?live=all', {
      headers: { 'x-apisports-key': process.env.FOOTBALL_API_KEY }
    });

    if (responseLive.data?.errors && Object.keys(responseLive.data.errors).length > 0) return;

    const targetIds = EQUIPOS_FAVORITOS.map(e => e.idFootball); // Usamos los IDs de API-Football
    const partidosLiveCrudos = responseLive.data.response || [];
    partidosEnVivoCache = []; 

    partidosLiveCrudos.forEach(fixture => {
      const homeId = fixture.teams.home.id;
      const awayId = fixture.teams.away.id;

      if (targetIds.includes(homeId) || targetIds.includes(awayId)) {
        let tiempoAmostrar = `${fixture.fixture.status.elapsed}'`;
        if (fixture.fixture.status.short === 'HT') tiempoAmostrar = 'Medio Tiempo';
        if (fixture.fixture.status.extra) tiempoAmostrar = `${fixture.fixture.status.elapsed} + ${fixture.fixture.status.extra}'`;

        const anotadoresData = (fixture.events || [])
          .filter(event => event.type === 'Goal')
          .map(event => ({
            equipo: event.team.name,
            jugador: event.player.name || 'Desconocido',
            minuto: event.time.elapsed,
            tipo: event.detail
          }));

        partidosEnVivoCache.push({
          id: fixture.fixture.id,
          equipoIdFiltro1: homeId,
          equipoIdFiltro2: awayId,
          local: fixture.teams.home.name,
          visitante: fixture.teams.away.name,
          golesLocal: fixture.goals.home ?? 0,
          golesVisitante: fixture.goals.away ?? 0,
          minuto: tiempoAmostrar,
          estado: fixture.fixture.status.short,
          esEnVivo: true,
          anotadores: anotadoresData
        });
      }
    });

    emitirDatosAlFrontend();
  } catch (error) {
    console.error('❌ Error buscando en vivo en API-Football:', error.message);
  }
}

setTimeout(cargarProximosPartidosProgresivamente, 2000); 
setInterval(buscarPartidosEnVivo, INTERVALO_CONSULTA); 

io.on('connection', (socket) => {
  emitirDatosAlFrontend(socket);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Servidor Multi-API corriendo en puerto ${PORT}`));