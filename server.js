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

// Frecuencia de actualización: 1 minuto (60,000 ms)
const INTERVALO_CONSULTA = 1 * 60 * 1000;

// Función para obtener y transmitir los datos
async function actualizarYTransmitirPartidos() {
  try {
    console.log('🔄 Actualizando información de partidos...');

    /* // EJEMPLO CON API-FOOTBALL REAL:
    const response = await axios.get('https://v3.football.api-sports.io/fixtures?live=all', {
      headers: { 'x-apisports-key': process.env.FOOTBALL_API_KEY }
    });
    const partidos = response.data.response;
    */

    // SIMULACIÓN (Ideal para probar el flujo sin consumir cuotas de API):
    const partidos = [
      {
        id: 101,
        local: 'Real Madrid',
        visitante: 'Barcelona',
        golesLocal: Math.floor(Math.random() * 4),
        golesVisitante: Math.floor(Math.random() * 3),
        minuto: `${Math.floor(Math.random() * 45) + 45}'`
      },
      {
        id: 102,
        local: 'Arsenal',
        visitante: 'Chelsea',
        golesLocal: Math.floor(Math.random() * 2),
        golesVisitante: Math.floor(Math.random() * 2),
        minuto: `${Math.floor(Math.random() * 30) + 1}'`
      }
    ];

    // Emitir el evento a TODOS los clientes conectados simultáneamente
    io.emit('marcadores_actualizados', partidos);
    console.log('📡 Broadcast enviado a los clientes.');
  } catch (error) {
    console.error('Error al actualizar partidos:', error.message);
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