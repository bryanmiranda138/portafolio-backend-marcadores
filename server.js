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

// 📌 TUS EQUIPOS FAVORITOS (Corregido el ID de Inter Miami a 9723)
const EQUIPOS_FAVORITOS = [
  { nombre: 'FC Barcelona',   idFootball: 529,  strSearch: 'Barcelona' },
  { nombre: 'Real Madrid',    idFootball: 541,  strSearch: 'Real Madrid' },
  { nombre: 'Boca Juniors',   idFootball: 451,  strSearch: 'Boca Juniors' },
  { nombre: 'River Plate',    idFootball: 435,  strSearch: 'River Plate' },
  { nombre: 'Liverpool',      idFootball: 40,   strSearch: 'Liverpool' },
  { nombre: 'Manchester City',idFootball: 50,   strSearch: 'Manchester City' },
  { nombre: 'C.D. Águila',    idFootball: 2307, strSearch: 'Aguila' }, 
  { nombre: 'Inter Miami',    idFootball: 9723, strSearch: 'Inter Miami' }, // 👈 ID Oficial Primer Equipo
  { nombre: 'Argentina',      idFootball: 26,   strSearch: 'Argentina' },
  { nombre: 'Brasil',         idFootball: 6,    strSearch: 'Brazil' },
  { nombre: 'Inglaterra',     idFootball: 10,   strSearch: 'England' },
  { nombre: 'Francia',        idFootball: 2,    strSearch: 'France' },
  { nombre: 'España',         idFootball: 9,    strSearch: 'Spain' }
];

// 🛡️ EXCLUSIONES CONOCIDAS PARA EVITAR FALSOS POSITIVOS
const EXCLUSIONES = [
  'new england',            
  'barcelona sc',           
  'barcelona de guayaquil',
  'liverpool montevideo',   
  'river plate montevideo',
  'real madrid b',
  'barcelona b'
];

const INTERVALO_CONSULTA = 3 * 60 * 1000; 

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

// 🧠 FUNCIÓN AUXILIAR DE VALIDACIÓN ESTRICTA
function obtenerFavoritoSiCoincide(nombreEquipoAPI) {
  if (!nombreEquipoAPI) return null;
  const nombreNorm = nombreEquipoAPI.toLowerCase().trim();

  if (EXCLUSIONES.some(ex => nombreNorm.includes(ex))) {
    return null;
  }

  for (const fav of EQUIPOS_FAVORITOS) {
    const searchNorm = fav.strSearch.toLowerCase().trim();
    const nombreFavNorm = fav.nombre.toLowerCase().trim();

    if (nombreNorm === searchNorm || nombreNorm === nombreFavNorm) {
      return fav;
    }

    const regex = new RegExp(`\\b${searchNorm}\\b`, 'i');
    if (regex.test(nombreNorm)) {
      return fav;
    }
  }

  return null;
}

// 1️⃣ API #1: TheSportsDB (Buscador Próximos Partidos con Fechas Blindadas)
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
        let proximosEventos = resPartidos.data?.events;

        if (proximosEventos && proximosEventos.length > 0) {
          const ahora = Date.now();

          // 🧠 FILTRO DE FECHA INDESTRUCTIBLE
          const eventosRealmenteFuturos = proximosEventos.filter(ev => {
            let fechaPartido;
            if (ev.strTimestamp) {
                fechaPartido = new Date(ev.strTimestamp).getTime();
            } else if (ev.dateEvent) {
                const hora = ev.strTime || '00:00:00';
                fechaPartido = new Date(`${ev.dateEvent}T${hora}+00:00`).getTime();
            }

            // Si la API mandó una fecha corrupta, lo pasamos por si acaso en vez de borrarlo
            if (!fechaPartido || isNaN(fechaPartido)) return true;

            // Tolerancia de 4 horas: Retiene el partido en "Próximos" hasta 4 horas tras su inicio
            const toleranciaHoras = 4 * 60 * 60 * 1000;
            return (fechaPartido + toleranciaHoras) > ahora;
          });

          if (eventosRealmenteFuturos.length > 0) {
            
            // ORDENAMOS cronológicamente para garantizar que muestre el inminente y no uno lejano
            eventosRealmenteFuturos.sort((a, b) => {
                const timeA = a.strTimestamp ? new Date(a.strTimestamp).getTime() : new Date(`${a.dateEvent}T${a.strTime||'00:00:00'}+00:00`).getTime();
                const timeB = b.strTimestamp ? new Date(b.strTimestamp).getTime() : new Date(`${b.dateEvent}T${b.strTime||'00:00:00'}+00:00`).getTime();
                return timeA - timeB;
            });

            const fixtureFutu = eventosRealmenteFuturos[0];
            
            let fechaFormateada = 'Fecha por confirmar';
            if (fixtureFutu.strTimestamp) {
                const fechaUTC = new Date(fixtureFutu.strTimestamp);
                const fechaElSalvador = new Date(fechaUTC.getTime() - (6 * 60 * 60 * 1000));
                fechaFormateada = fechaElSalvador.toLocaleDateString('es-ES', { 
                  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                  timeZone: 'UTC'
                });
            } else if (fixtureFutu.dateEvent) {
                fechaFormateada = `${fixtureFutu.dateEvent} ${fixtureFutu.strTime || ''}`.trim();
            }
            
            const esLocal = String(fixtureFutu.idHomeTeam) === String(equipoEncontrado.idTeam);
            
            listaTemporal.push({
              id: fixtureFutu.idEvent,
              equipoTrackedId: equipo.idFootball,
              local: fixtureFutu.strHomeTeam,
              // Asignamos tu escudo del perfil principal para evitar imágenes defectuosas
              logoLocal: esLocal ? equipoEncontrado.strTeamBadge : (fixtureFutu.strHomeTeamBadge || null),
              visitante: fixtureFutu.strAwayTeam,
              logoVisitante: !esLocal ? equipoEncontrado.strTeamBadge : (fixtureFutu.strAwayTeamBadge || null),
              golesLocal: 0, 
              golesVisitante: 0,
              minuto: fechaFormateada,
              estado: 'PROXIMO',
              esEnVivo: false,
              anotadores: [] 
            });
          } else {
             throw new Error("Solo hay partidos pasados"); 
          }
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

// 2️⃣ API #2: API-Football (Partidos en vivo con filtro de penales errados y tarjetas)
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

    const partidosLiveCrudos = responseLive.data?.response || [];
    partidosEnVivoCache = []; 

    partidosLiveCrudos.forEach(fixture => {
      const homeName = fixture.teams.home.name;
      const awayName = fixture.teams.away.name;

      const favHome = obtenerFavoritoSiCoincide(homeName);
      const favAway = obtenerFavoritoSiCoincide(awayName);
      const equipoFavoritoEncontrado = favHome || favAway;

      if (equipoFavoritoEncontrado) {
        const statusCorto = fixture.fixture.status.short;
        const elapsed = fixture.fixture.status.elapsed;
        const extra = fixture.fixture.status.extra;

        let tiempoAmostrar = '';
        if (statusCorto === 'HT') {
          tiempoAmostrar = 'Medio Tiempo';
        } else if (['FT', 'AET', 'PEN'].includes(statusCorto)) {
          tiempoAmostrar = 'Finalizado';
        } else if (extra) {
          tiempoAmostrar = `${elapsed} + ${extra}'`; 
        } else {
          tiempoAmostrar = `${elapsed}'`; 
        }

        const eventos = fixture.events || [];

        // 🧠 1. FILTRO DE GOLES REALES (Excluimos 'Missed Penalty')
        const anotadoresData = eventos
          .filter(e => e.type === 'Goal' && e.detail !== 'Missed Penalty')
          .map(e => ({
            equipo: e.team.name,
            jugador: e.player.name || 'Desconocido',
            minuto: e.time.elapsed,
            tipo: e.detail === 'Own Goal' ? 'Autogol' : e.detail === 'Penalty' ? 'Penal' : 'Gol'
          }));

        // 🟨 🟥 2. CAPTURA DE TARJETAS (Protegido contra Nulos)
        const tarjetasData = eventos
          .filter(e => e.type === 'Card')
          .map(e => ({
            equipo: e.team.name,
            jugador: e.player.name || 'Desconocido',
            minuto: e.time.elapsed,
            tipo: (e.detail || '').toLowerCase().includes('yellow') ? 'Amarilla' : 'Roja'
          }));

        partidosEnVivoCache.push({
          id: fixture.fixture.id,
          equipoIdFiltro1: equipoFavoritoEncontrado.idFootball, 
          equipoIdFiltro2: equipoFavoritoEncontrado.idFootball,
          local: fixture.teams.home.name,
          logoLocal: fixture.teams.home.logo,
          visitante: fixture.teams.away.name,
          logoVisitante: fixture.teams.away.logo,
          golesLocal: fixture.goals.home ?? 0,
          golesVisitante: fixture.goals.away ?? 0,
          minuto: tiempoAmostrar,
          estado: statusCorto,
          esEnVivo: true,
          anotadores: anotadoresData,
          tarjetas: tarjetasData
        });
      }
    });

    emitirDatosAlFrontend();
  } catch (error) {
    console.error('❌ Error de conexión con API-Football al buscar en vivo:', error.message);
  }
}

// 🚀 ARRANQUE INMEDIATO
buscarPartidosEnVivo(); 
setTimeout(cargarProximosPartidosProgresivamente, 2000); 

setInterval(buscarPartidosEnVivo, INTERVALO_CONSULTA); 
setInterval(cargarProximosPartidosProgresivamente, 30 * 60 * 1000); 

io.on('connection', (socket) => {
  emitirDatosAlFrontend(socket);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Servidor Multi-API corriendo en puerto ${PORT}`));