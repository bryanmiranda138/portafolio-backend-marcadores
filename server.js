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

// 📌 LISTADO DE EQUIPOS FAVORITOS CON SUS IDs OFICIALES
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

// Frecuencia de consulta en vivo: 10 minutos (para cuidar cuota diaria)
const INTERVALO_CONSULTA = 10 * 60 * 1000;

// Caché en memoria para próximos partidos (Se renueva cada 12 horas)
let cacheProximosPartidos = [];
let ultimaConsultaProximos = 0;
const DOCE_HORAS = 12 * 60 * 60 * 1000;

// Función para obtener el próximo partido de cada equipo favorito
async function obtenerProximosPartidos() {
  if (Date.now() - ultimaConsultaProximos < DOCE_HORAS && cacheProximosPartidos.length > 0) {
    return cacheProximosPartidos;
  }

  console.log('📅 Consultando API para próximos partidos programados...');
  const resultados = [];

  for (const equipo of EQUIPOS_FAVORITOS) {
    try {
      const response = await axios.get(`https://v3.football.api-sports.io/fixtures?team=${equipo.id}&next=1`, {
        headers: { 'x-apisports-key': process.env.FOOTBALL_API_KEY }
      });

      const fixture = response.data.response[0];
      if (fixture) {
        const fecha = new Date(fixture.fixture.date);
        const fechaFormateada = fecha.toLocaleDateString('es-ES', {
          day: '2-digit',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit'
        });

        resultados.push({
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
      }
    } catch (err) {
      console.error(`❌ Error al obtener próximo partido de ${equipo.nombre}:`, err.message);
    }
  }

  cacheProximosPartidos = resultados;
  ultimaConsultaProximos = Date.now();
  return resultados;
}

// Función principal de actualización y emisión
async function actualizarYTransmitirPartidos() {
  try {
    console.log('🔄 Consultando partidos en vivo...');

    // 1. Petición a partidos en vivo globales
    const responseLive = await axios.get('https://v3.football.api-sports.io/fixtures?live=all', {
      headers: { 'x-apisports-key': process.env.FOOTBALL_API_KEY }
    });

    const partidosLiveCrudos = responseLive.data.response || [];
    const targetIds = EQUIPOS_FAVORITOS.map(e => e.id);

    const partidosEnVivoMapeados = [];
    const equiposConPartidoEnVivo = new Set();

    // 2. Filtrar si alguno de nuestros equipos favoritos está jugando en vivo
    partidosLiveCrudos.forEach(fixture => {
      const homeId = fixture.teams.home.id;
      const awayId = fixture.teams.away.id;

      if (targetIds.includes(homeId) || targetIds.includes(awayId)) {
        if (targetIds.includes(homeId)) equiposConPartidoEnVivo.add(homeId);
        if (targetIds.includes(awayId)) equiposConPartidoEnVivo.add(awayId);

        const statusCorto = fixture.fixture.status.short;
        const elapsed = fixture.fixture.status.elapsed;
        const extra = fixture.fixture.status.extra;

        let tiempoAmostrar = '';
        if (statusCorto === 'HT') tiempoAmostrar = 'Medio Tiempo';
        else if (['FT', 'AET', 'PEN'].includes(statusCorto)) tiempoAmostrar = 'Finalizado';
        else if (extra) tiempoAmostrar = `${elapsed} + ${extra}'`;
        else tiempoAmostrar = `${elapsed}'`;

        const anotadores = (fixture.events || [])
          .filter(event => event.type === 'Goal')
          .map(event => ({
            equipo: event.team.name,
            jugador: event.player.name || 'Desconocido',
            minuto: event.time.elapsed,
            tipo: event.detail
          }));

        partidosEnVivoMapeados.push({
          id: fixture.fixture.id,
          local: fixture.teams.home.name,
          visitante: fixture.teams.away.name,
          golesLocal: fixture.goals.home ?? 0,
          golesVisitante: fixture.goals.away ?? 0,
          minuto: tiempoAmostrar,
          estado: statusCorto,
          esEnVivo: true,
          anotadores
        });
      }
    });

    // 3. Obtener próximos partidos para los equipos que NO están jugando en vivo
    const proximos = await obtenerProximosPartidos();
    const proximosFiltrados = proximos.filter(p => !equiposConPartidoEnVivo.has(p.equipoTrackedId));

    // Combinar lista final: En vivo primero, luego próximos
    const listaFinal = [...partidosEnVivoMapeados, ...proximosFiltrados];

    io.emit('marcadores_actualizados', listaFinal);
    console.log(`📡 Transmitidos ${partidosEnVivoMapeados.length} partidos en vivo y ${proximosFiltrados.length} próximos.`);

  } catch (error) {
    console.error('❌ Error en el proceso de consulta:', error.message);
  }
}

setInterval(actualizarYTransmitirPartidos, INTERVALO_CONSULTA);

io.on('connection', (socket) => {
  console.log(`⚡ Cliente conectado: ${socket.id}`);
  actualizarYTransmitirPartidos();

  socket.on('disconnect', () => {
    console.log(`❌ Cliente desconectado: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});