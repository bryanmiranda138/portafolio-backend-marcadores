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

// 📌 TUS EQUIPOS FAVORITOS (Nombres exactos para el buscador)
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

const INTERVALO_CONSULTA = 10 * 60 * 1000; 

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

// 1️⃣ API #1: TheSportsDB (100% REAL - PRÓXIMOS PARTIDOS VERDADEROS)
async function cargarProximosPartidosProgresivamente() {
  if (cargandoProximos) return;
  cargandoProximos = true;
  console.log('⏳ Iniciando buscador dinámico de próximos partidos 100% REALES...');

  let listaTemporal = [];

  for (const equipo of EQUIPOS_FAVORITOS) {
    try {
      // 1. Buscamos el equipo dinámicamente por nombre
      const urlBusqueda = `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(equipo.strSearch)}`;
      const resBusqueda = await axios.get(urlBusqueda);
      
      const equipoEncontrado = resBusqueda.data?.teams?.find(t => t.strSport === 'Soccer');
      
      if (equipoEncontrado) {
        // 2. Buscamos su PRÓXIMO partido oficial (eventsnext)
        const urlPartidos = `https://www.thesportsdb.com/api/v1/json/3/eventsnext.php?id=${equipoEncontrado.idTeam}`;
        const resPartidos = await axios.get(urlPartidos);
        
        const proximosEventos = resPartidos.data?.events;

        if (proximosEventos && proximosEventos.length > 0) {
          // ✅ EL EQUIPO TIENE PARTIDO PROGRAMADO
          const fixtureFutu = proximosEventos[0];
          
          const fechaReal = new Date(fixtureFutu.strTimestamp);
          const fechaFormateada = fechaReal.toLocaleDateString('es-ES', { 
            day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' 
          });
          
          listaTemporal.push({
            id: fixtureFutu.idEvent,
            equipoTrackedId: equipo.idFootball,
            local: fixtureFutu.strHomeTeam,
            visitante: fixtureFutu.strAwayTeam,
            golesLocal: 0, 
            golesVisitante: 0,
            minuto: fechaFormateada,
            estado: 'PROXIMO',
            esEnVivo: false,
            anotadores: [] 
          });

        } else {
           throw new Error("Agenda vacía"); // Salta al catch para poner la tarjeta TBD
        }
      } else {
         throw new Error("Equipo no encontrado"); // Salta al catch para poner la tarjeta TBD
      }

    } catch (err) {
      console.log(`ℹ️ ${equipo.nombre} no tiene partidos programados. Generando tarjeta TBD.`);
      // 🛡️ PLAN B (TBD): Tarjeta elegante "Por definir" si el calendario está vacío
      listaTemporal.push({
        id: `tbd-${equipo.idFootball}`,
        equipoTrackedId: equipo.idFootball, 
        local: equipo.nombre, 
        visitante: 'Rival por definir', 
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

  console.log(`✅ Carga de calendario completada con éxito.`);
  cargandoProximos = false;
}

// 2️⃣ API #2: API-Football para Partidos En Vivo (Usando tu llave)
async function buscarPartidosEnVivo() {
  try {
    const responseLive = await axios.get('https://v3.football.api-sports.io/fixtures?live=all', {
      headers: { 'x-apisports-key': process.env.FOOTBALL_API_KEY }
    });

    if (responseLive.data?.errors && Object.keys(responseLive.data.errors).length > 0) return;

    const targetIds = EQUIPOS_FAVORITOS.map(e => e.idFootball);
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