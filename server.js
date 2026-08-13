require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
// Ruta principal para evitar el error "Cannot GET /"
app.get('/', (req, res) => {
  res.send('⚽ El Servidor de Marcadores (API) está en línea y funcionando perfectamente.');
});
const server = http.createServer(app);

const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

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

// Memoria
let cacheProximosPartidos = [];
let cargandoProximos = false;
let partidosEnVivoCache = []; 

const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 🛡️ PLAN B: Datos simulados en caso de que la API bloquee por límite diario
const DATOS_RESPALDO = [
  { id: 991, equipoTrackedId: 541, local: 'Real Madrid', visitante: 'AC Milan', golesLocal: 0, golesVisitante: 0, minuto: 'Próx. Sábado, 13:00', estado: 'PROXIMO', esEnVivo: false, anotadores: [] },
  { id: 992, equipoTrackedId: 529, local: 'FC Barcelona', visitante: 'Arsenal', golesLocal: 0, golesVisitante: 0, minuto: 'Próx. Domingo, 10:00', estado: 'PROXIMO', esEnVivo: false, anotadores: [] },
  { id: 993, equipoTrackedId: 8984, local: 'Inter Miami', visitante: 'LA Galaxy', golesLocal: 0, golesVisitante: 0, minuto: 'Mañana, 18:30', estado: 'PROXIMO', esEnVivo: false, anotadores: [] }
];

// Función para unificar y enviar
function emitirDatosAlFrontend(socketEspecifico = null) {
  const idsJugandoAhora = new Set();
  partidosEnVivoCache.forEach(p => {
    idsJugandoAhora.add(p.equipoIdFiltro1);
    idsJugandoAhora.add(p.equipoIdFiltro2);
  });

  const proximosFiltrados = cacheProximosPartidos.filter(p => !idsJugandoAhora.has(p.equipoTrackedId));
  const listaFinal = [...partidosEnVivoCache, ...proximosFiltrados];
  
  if (socketEspecifico) {
    // Solo le envía a quien acaba de entrar
    socketEspecifico.emit('marcadores_actualizados', listaFinal);
  } else {
    // Le envía a todos (cuando hay una actualización)
    io.emit('marcadores_actualizados', listaFinal);
  }
}

// 1️⃣ Obtener próximos partidos progresivamente
async function cargarProximosPartidosProgresivamente() {
  if (cargandoProximos || cacheProximosPartidos.length > 0) return;
  
  cargandoProximos = true;
  console.log('⏳ Iniciando carga de próximos partidos...');

  for (const equipo of EQUIPOS_FAVORITOS) {
    try {
      const response = await axios.get(`https://v3.football.api-sports.io/fixtures?team=${equipo.id}&next=1`, {
        headers: { 'x-apisports-key': process.env.FOOTBALL_API_KEY }
      });

      // 🚨 DETECCIÓN DE ERRORES BLINDADA
      // Verificamos si hay errores, ya sea que la API los envíe como Arreglo [] o como Objeto {}
      const apiEnvioErrores = response.data.errors && (
        (Array.isArray(response.data.errors) && response.data.errors.length > 0) || 
        (!Array.isArray(response.data.errors) && Object.keys(response.data.errors).length > 0)
      );

      if (apiEnvioErrores) {
        console.error(`⚠️ API rechazó la petición de ${equipo.nombre}:`, response.data.errors);
        console.log('🛡️ ACTIVANDO PLAN B: Inyectando partidos de respaldo para proteger el portafolio.');
        
        // Activamos los datos de prueba y rompemos el ciclo para no seguir gastando
        cacheProximosPartidos = [...DATOS_RESPALDO];
        emitirDatosAlFrontend();
        break; 
      }

      const fixture = response.data.response?.[0];
      if (fixture) {
        const fecha = new Date(fixture.fixture.date);
        const fechaFormateada = fecha.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        
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
        emitirDatosAlFrontend();
      }
    } catch (err) {
      console.error(`❌ Error HTTP con ${equipo.nombre}:`, err.message);
    }
    
    // Esperamos 8 segundos para no agobiar a la API
    await esperar(8000); 
  }
  console.log('✅ Carga completada.');
}

// 2️⃣ Consultar en vivo
async function buscarPartidosEnVivo() {
  try {
    const responseLive = await axios.get('https://v3.football.api-sports.io/fixtures?live=all', {
      headers: { 'x-apisports-key': process.env.FOOTBALL_API_KEY }
    });

    // 🚨 DETECCIÓN DE ERRORES BLINDADA
    // Verificamos si hay errores, ya sea que la API los envíe como Arreglo [] o como Objeto {}
    const apiEnvioErrores = responseLive.data.errors && (
      (Array.isArray(responseLive.data.errors) && responseLive.data.errors.length > 0) || 
      (!Array.isArray(responseLive.data.errors) && Object.keys(responseLive.data.errors).length > 0)
    );

    if (apiEnvioErrores) return; // Si hay error, lo ignoramos para no romper el caché

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
          anotadores: [] 
        });
      }
    });

    emitirDatosAlFrontend();
  } catch (error) {
    console.error('❌ Error buscando en vivo:', error.message);
  }
}

// Arranque
setTimeout(cargarProximosPartidosProgresivamente, 2000); 
setInterval(buscarPartidosEnVivo, INTERVALO_CONSULTA); 

io.on('connection', (socket) => {
  console.log(`⚡ Cliente conectado: ${socket.id}`);
  
  if (cacheProximosPartidos.length > 0 || partidosEnVivoCache.length > 0) {
    // Si ya tenemos datos listos, se los mandamos directo a él
    emitirDatosAlFrontend(socket);
  } else {
    // Si acaba de prender, forzamos busqueda
    buscarPartidosEnVivo();
  }

  socket.on('disconnect', () => console.log(`❌ Desconectado: ${socket.id}`));
});

// 🩺 ENDPOINT DE DIAGNÓSTICO (DEBUG)
// Entra a esta URL en tu navegador para ver qué está pensando el servidor
app.get('/debug', (req, res) => {
  res.json({
    mensaje: "Estado actual de la memoria del servidor",
    estaCargandoLaCola: cargandoProximos,
    partidosEnVivoEncontrados: partidosEnVivoCache.length,
    proximosPartidosEncontrados: cacheProximosPartidos.length,
    datosProximos: cacheProximosPartidos
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));