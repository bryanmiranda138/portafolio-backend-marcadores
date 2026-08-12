require('dotenv').config();
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
        'x-apisports-key': process.env.FOOTBALL_API_KEY
      }
    });

    const partidosCrudos = response.data.response;

    // 2. Traducción de datos (Mapeo)
    const partidos = partidosCrudos.map(fixture => {
      // Extraemos únicamente los eventos de tipo "Goal"
      const anotadores = (fixture.events || [])
        .filter(event => event.type === 'Goal')
        .map(event => ({
          equipo: event.team.name,          // Nombre del equipo
          jugador: event.player.name || 'Desconocido', // Nombre del goleador
          minuto: event.time.elapsed,       // Minuto del gol
          tipo: event.detail                // 'Normal Goal', 'Penalty', 'Own Goal', etc.
        }));

      return {
        id: fixture.fixture.id,
        local: fixture.teams.home.name,
        visitante: fixture.teams.away.name,
        golesLocal: fixture.goals.home ?? 0,
        golesVisitante: fixture.goals.away ?? 0,
        minuto: `${fixture.fixture.status.elapsed}'`,
        anotadores: anotadores // 👈 Enviamos la lista de goleadores
      };
    }); // <-- Aquí termina el mapeo de los partidos

    // 👇 ESTAS DOS LÍNEAS SON LAS QUE TE FALTABAN 👇
    // 3. Emitir el evento a todos los clientes conectados
    io.emit('marcadores_actualizados', partidos);
    console.log(`📡 Broadcast enviado: ${partidos.length} partidos actualizados.`);

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