require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// 📌 TUS EQUIPOS Y SELECCIONES FAVORITAS
const EQUIPOS_FAVORITOS = [
  { id: 529, nombre: 'FC Barcelona' },
  { id: 541, nombre: 'Real Madrid' },
  { id: 451, nombre: 'Boca Juniors' },
  { id: 435, nombre: 'River Plate' },
  { id: 40,  nombre: 'Liverpool' },
  { id: 50,  nombre: 'Manchester City' },
  { id: 2307, nombre: 'C.D. Águila' },
  { id: 8984, nombre: 'Inter Miami' },
  { id: 26,  nombre: 'Argentina' },
  { id: 6,   nombre: 'Brasil' },
  { id: 10,  nombre: 'Inglaterra' },
  { id: 2,   nombre: 'Francia' },
  { id: 9,   nombre: 'España' }
];

const INTERVALO_CONSULTA = 10 * 60 * 1000; // 10 minutos para los partidos en vivo

// Memoria del servidor
let cacheProximosPartidos = [];
let cargandoProximos = false;
let partidosEnVivoCache = []; 

// ⏳ HELPER: Función para pausar el código (Throttling)
const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 1️⃣ FUNCIÓN: Obtener próximos partidos LENTAMENTE (1 por cada 7 segundos)
async function cargarProximosPartidosProgresivamente() {
  if (cargandoProximos || cacheProximosPartidos.length > 0) return;
  
  cargandoProximos = true;
  console.log('⏳ Iniciando carga progresiva de próximos partidos (evitando el Rate Limit de la API)...');

  for (const equipo of EQUIPOS_FAVORITOS) {
    try {
      const response = await axios.get(`https://v3.football.api-sports.io/fixtures?team=${equipo.id}&next=1`, {
        headers: { 'x-apisports-key': process.env.FOOTBALL_API_KEY }
      });

      // Si la API nos avisa que llegamos al límite diario, paramos el ciclo
      if (response.data.errors && response.data.errors.requests) {
        console.error('🚫 LÍMITE DIARIO DE LA API ALCANZADO (100/100). Intenta mañana.');
        break;
      }

      const fixture = response.data.response?.[0];
      
      if (fixture) {
        const fecha = new Date(fixture.fixture.date);
        const fechaFormateada = fecha.toLocaleDateString('es-ES', {
          day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
        });

        // Agregamos el partido a la memoria
        cacheProximosPartidos.push({
          id: fixture.fixture.id,
          equipoTrackedId: equipo.id,
          local: fixture.teams.home.name,
          visitante: fixture.teams.away.name,
          golesLocal: fixture.goals.home ?? 0,
          golesVisitante: fixture.goals.away ?? 0,
          minuto: fechaFormateada,
          estado: 'PROXIMO',
          esEnVivo: false,
          anotadores: []
        });

        // 📡 Emitimos al frontend INMEDIATAMENTE para que aparezca en pantalla
        emitirDatosAlFrontend();
      }
    } catch (err) {
      console.error(`❌ Error con ${equipo.nombre}:`, err.message);
    }

    // 🛑 MAGIA SENIOR: Esperamos 7 segundos entre cada equipo (Respetando los 10 req/minuto)
    await esperar(7000); 
  }
  
  console.log('✅ Carga de próximos partidos completada exitosamente.');
}

// 2️⃣ FUNCIÓN: Consultar partidos en vivo global
async function buscarPartidosEnVivo() {
  try {
    const responseLive = await axios.get('https://v3.football.api-sports.io/fixtures?live=all', {
      headers: { 'x-apisports-key': process.env.FOOTBALL_API_KEY }
    });

    const targetIds = EQUIPOS_FAVORITOS.map(e => e.id);
    const partidosLiveCrudos = responseLive.data.response || [];
    
    partidosEnVivoCache = []; // Limpiamos caché en vivo anterior

    partidosLiveCrudos.forEach(fixture => {
      const homeId = fixture.teams.home.id;
      const awayId = fixture.teams.away.id;

      // Si juega uno de nuestros favoritos...
      if (targetIds.includes(homeId) || targetIds.includes(awayId)) {
        let tiempoAmostrar = `${fixture.fixture.status.elapsed}'`;
        if (fixture.fixture.status.short === 'HT') tiempoAmostrar = 'Medio Tiempo';
        if (fixture.fixture.status.extra) tiempoAmostrar = `${fixture.fixture.status.elapsed} + ${fixture.fixture.status.extra}'`;

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
          anotadores: [] // Simplificado para este ejemplo
        });
      }
    });

    emitirDatosAlFrontend();
  } catch (error) {
    console.error('❌ Error buscando partidos en vivo:', error.message);
  }
}

// 3️⃣ FUNCIÓN: Mezclar en vivo con próximos y enviar a React
function emitirDatosAlFrontend() {
  // Qué equipos están jugando en este instante
  const idsJugandoAhora = new Set();
  partidosEnVivoCache.forEach(p => {
    idsJugandoAhora.add(p.equipoIdFiltro1);
    idsJugandoAhora.add(p.equipoIdFiltro2);
  });

  // Filtramos los próximos partidos para ocultar los que YA están jugando en vivo
  const proximosFiltrados = cacheProximosPartidos.filter(p => !idsJugandoAhora.has(p.equipoTrackedId));

  // Combinamos: Los en vivo primero, los próximos después
  const listaFinal = [...partidosEnVivoCache, ...proximosFiltrados];
  
  io.emit('marcadores_actualizados', listaFinal);
}

// ⏱️ Inicialización de servicios
setTimeout(cargarProximosPartidosProgresivamente, 2000); // Empieza a cargar 2s después de arrancar el server
setInterval(buscarPartidosEnVivo, INTERVALO_CONSULTA); // Busca en vivo cada 10 mins

io.on('connection', (socket) => {
  console.log(`⚡ Cliente conectado: ${socket.id}`);
  
  // Si entra alguien nuevo, le mandamos lo que ya tenemos cargado en memoria de inmediato
  if (cacheProximosPartidos.length > 0 || partidosEnVivoCache.length > 0) {
    emitirDatosAlFrontend();
  } else {
    // Si acaba de prender el server, forzamos un chequeo en vivo rápido
    buscarPartidosEnVivo();
  }
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});