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

app.get('/', (req, res) => res.send('⚽ Servidor de Marcadores en vivo funcionando correctamente.'));
app.get('/debug', (req, res) => res.json({ proximos: cacheProximosPartidos, enVivo: partidosEnVivoCache }));

// 📌 TUS EQUIPOS FAVORITOS
const EQUIPOS_FAVORITOS = [
  { id: 529, nombre: 'FC Barcelona' }, { id: 541, nombre: 'Real Madrid' },
  { id: 451, nombre: 'Boca Juniors' }, { id: 435, nombre: 'River Plate' },
  { id: 40,  nombre: 'Liverpool' }, { id: 50,  nombre: 'Manchester City' },
  { id: 2307, nombre: 'C.D. Águila' }, { id: 8984, nombre: 'Inter Miami' },
  { id: 26,  nombre: 'Argentina' }, { id: 6,   nombre: 'Brasil' },
  { id: 10,  nombre: 'Inglaterra' }, { id: 2,   nombre: 'Francia' }, { id: 9,   nombre: 'España' }
];

const INTERVALO_CONSULTA = 10 * 60 * 1000; 

let cacheProximosPartidos = [];
let cargandoProximos = false;
let partidosEnVivoCache = []; 

const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const DATOS_RESPALDO = [
  { id: 991, equipoTrackedId: 541, local: 'Real Madrid', visitante: 'AC Milan', golesLocal: 0, golesVisitante: 0, minuto: 'Próx. Sábado, 13:00', estado: 'PROXIMO', esEnVivo: false, anotadores: [] },
  { id: 992, equipoTrackedId: 529, local: 'FC Barcelona', visitante: 'Arsenal', golesLocal: 0, golesVisitante: 0, minuto: 'Próx. Domingo, 10:00', estado: 'PROXIMO', esEnVivo: false, anotadores: [] },
  { id: 993, equipoTrackedId: 8984, local: 'Inter Miami', visitante: 'LA Galaxy', golesLocal: 0, golesVisitante: 0, minuto: 'Mañana, 18:30', estado: 'PROXIMO', esEnVivo: false, anotadores: [] }
];

function emitirDatosAlFrontend(socketEspecifico = null) {
  const idsJugandoAhora = new Set();
  partidosEnVivoCache.forEach(p => {
    idsJugandoAhora.add(p.equipoIdFiltro1);
    idsJugandoAhora.add(p.equipoIdFiltro2);
  });

  const proximosFiltrados = cacheProximosPartidos.filter(p => !idsJugandoAhora.has(p.equipoTrackedId));
  const listaBruta = [...partidosEnVivoCache, ...proximosFiltrados];
  
  // 🛡️ MAGIA SENIOR: Deduplicar partidos que tengan el mismo ID (Ej. Barça vs Madrid)
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

async function cargarProximosPartidosProgresivamente() {
  if (cargandoProximos) return;
  cargandoProximos = true;
  let listaTemporal = [];

  for (const equipo of EQUIPOS_FAVORITOS) {
    try {
      const response = await axios.get(`https://v3.football.api-sports.io/fixtures?team=${equipo.id}&next=1`, {
        headers: { 'x-apisports-key': process.env.FOOTBALL_API_KEY }
      });

      const errors = response.data?.errors;
      if (errors && errors.requests) {
        if (listaTemporal.length === 0) cacheProximosPartidos = [...DATOS_RESPALDO];
        break;
      }
      if (errors && errors.rateLimit) {
        await esperar(12000);
        continue;
      }

      const fixture = response.data.response?.[0];
      if (fixture) {
        const fecha = new Date(fixture.fixture.date);
        const fechaFormateada = fecha.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        
        listaTemporal.push({
          id: fixture.fixture.id,
          equipoTrackedId: equipo.id,
          local: fixture.teams.home.name,
          visitante: fixture.teams.away.name,
          golesLocal: fixture.goals.home ?? 0,
          golesVisitante: fixture.goals.away ?? 0,
          minuto: fechaFormateada,
          estado: 'PROXIMO',
          esEnVivo: false,
          anotadores: [] // Los próximos partidos nunca tienen goles, esto está bien
        });

        cacheProximosPartidos = [...listaTemporal];
        emitirDatosAlFrontend();
      }
    } catch (err) {
      console.error(`❌ Error HTTP consultando ${equipo.nombre}:`, err.message);
    }
    await esperar(9000); 
  }

  if (cacheProximosPartidos.length === 0) {
    cacheProximosPartidos = [...DATOS_RESPALDO];
    emitirDatosAlFrontend();
  }
  cargandoProximos = false;
}

async function buscarPartidosEnVivo() {
  try {
    const responseLive = await axios.get('https://v3.football.api-sports.io/fixtures?live=all', {
      headers: { 'x-apisports-key': process.env.FOOTBALL_API_KEY }
    });

    if (responseLive.data?.errors && Object.keys(responseLive.data.errors).length > 0) return;

    const targetIds = EQUIPOS_FAVORITOS.map(e => e.id);
    const partidosLiveCrudos = responseLive.data.response || [];
    partidosEnVivoCache = []; 

    partidosLiveCrudos.forEach(fixture => {
      const homeId = fixture.teams.home.id;
      const awayId = fixture.teams.away.id;

      if (targetIds.includes(homeId) || targetIds.includes(awayId)) {
        let tiempoAmostrar = `${fixture.fixture.status.elapsed}'`;
        if (fixture.fixture.status.short === 'HT') tiempoAmostrar = 'Medio Tiempo';
        if (fixture.fixture.status.extra) tiempoAmostrar = `${fixture.fixture.status.elapsed} + ${fixture.fixture.status.extra}'`;

        // 🛡️ RECREAMOS LA LÓGICA DE GOLES QUE HABÍAS BORRADO
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
          anotadores: anotadoresData // Ahora los goles sí viajan al frontend
        });
      }
    });

    emitirDatosAlFrontend();
  } catch (error) {
    console.error('❌ Error buscando en vivo:', error.message);
  }
}

setTimeout(cargarProximosPartidosProgresivamente, 3000); 
setInterval(buscarPartidosEnVivo, INTERVALO_CONSULTA); 

io.on('connection', (socket) => {
  emitirDatosAlFrontend(socket);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));