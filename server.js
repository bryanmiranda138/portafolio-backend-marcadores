const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());

const server = http.createServer(app);

// Configuración de Socket.io con CORS permitido para producción
const io = new Server(server, {
  cors: {
    origin: '*', // En producción puedes cambiarlo por la URL de tu frontend (ej. Vercel)
    methods: ['GET', 'POST']
  }
});

// Frecuencia de actualización: 3 minuto (60,000 ms)
const INTERVALO_CONSULTA = 3 * 60 * 1000;

// Función para obtener y transmitir los datos reales
async function actualizarYTransmitirPartidos() {
  try {
    console.log('🔄 Consultando API-Football para partidos en vivo...');

    // 1. Llamada a la API Real
    const response = await axios.get('https://v3.football.api-sports.io/fixtures?live=all', {
      headers: {
        'x-apisports-key': '460429b04bedb173f57157c21ea8fdd9' // Reemplaza esto con tu llave real
      }
    });

    const partidosCrudos = response.data.response;

    // 2. Traducción de datos (Mapeo)
    // Convertimos la respuesta compleja de la API al formato sencillo que espera React
    const partidos = partidosCrudos.map(fixture => ({
      id: fixture.fixture.id,
      local: fixture.teams.home.name,
      visitante: fixture.teams.away.name,
      golesLocal: fixture.goals.home ?? 0,
      golesVisitante: fixture.goals.away ?? 0,
      minuto: `${fixture.fixture.status.elapsed}'`
    }));

    // 3. Emitir el evento a los clientes
    io.emit('marcadores_actualizados', partidos);
    console.log(`📡 Broadcast enviado: ${partidos.length} partidos en vivo actualizados.`);

  } catch (error) {
    console.error('❌ Error al obtener los partidos reales:', error.message);
  }
}

// Ejecutar consulta periódica en el servidor
setInterval(actualizarYTransmitirPartidos, INTERVALO_CONSULTA);

// Gestión de conexiones de clientes
io.on('connection', (socket) => {
  console.log(`⚡ Cliente conectado: ${socket.id}`);

  // Enviar el estado actual inmediatamente al nuevo usuario que entra
  actualizarYTransmitirPartidos();

  socket.on('disconnect', () => {
    console.log(`❌ Cliente desconectado: ${socket.id}`);
  });
});

// Render asigna dinámicamente el puerto mediante process.env.PORT
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});