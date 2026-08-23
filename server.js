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

// 📌 TUS EQUIPOS FAVORITOS
const EQUIPOS_FAVORITOS = [
  { nombre: 'FC Barcelona',   idFootball: 529,  strSearch: 'Barcelona' },
  { nombre: 'Real Madrid',    idFootball: 541,  strSearch: 'Real Madrid' },
  { nombre: 'Boca Juniors',   idFootball: 451,  strSearch: 'Boca Juniors' },
  { nombre: 'River Plate',    idFootball: 435,  strSearch: 'River Plate' },
  { nombre: 'Liverpool',      idFootball: 40,   strSearch: 'Liverpool' },
  { nombre: 'Manchester City',idFootball: 50,   strSearch: 'Manchester City' },
  { nombre: 'C.D. Águila',    idFootball: 2307, strSearch: 'Aguila' },
  // 🌟 INTER MIAMI CON LOGO DE RESPALDO Y DOBLE ID
  { 
    nombre: 'Inter Miami',    
    idFootball: [9723, 8984], 
    strSearch: 'Inter Miami', 
    logoRespaldo: 'https://media.api-sports.io/football/teams/9723.png' 
  },
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

// 🖼️ EVALUACIÓN DE VARIOS NOMBRES DE CAMPOS PARA EL ESCUDO
function extraerEscudoTheSportsDB(objeto) {
  if (!objeto) return null;
  return objeto.strTeamBadge || 
         objeto.strBadge || 
         objeto.strTeamLogo || 
         objeto.strLogo || 
         objeto.strHomeTeamBadge || 
         objeto.strAwayTeamBadge || 
         null;
}

// 🧠 BÚSQUEDA COMPARANDO NOMBRES REALES PARA PROXIMOS PARTIDOS
function encontrarEquipoSportsDB(teamsArray, equipoFav) {
  if (!teamsArray || !Array.isArray(teamsArray) || teamsArray.length === 0) return null;

  const searchNorm = equipoFav.strSearch.toLowerCase().trim();
  const nombreFavNorm = equipoFav.nombre.toLowerCase().trim();

  const coincidenciaExacta = teamsArray.find(t => {
    if (t.strSport && t.strSport !== 'Soccer') return false;
    const strTeam = (t.strTeam || '').toLowerCase().trim();
    const strAlt = (t.strTeamAlternate || '').toLowerCase().trim();
    const strKeywords = (t.strKeywords || '').toLowerCase().trim();

    return strTeam === searchNorm || strTeam === nombreFavNorm ||
           strAlt === searchNorm || strAlt === nombreFavNorm ||
           (strKeywords && strKeywords.includes(searchNorm));
  });

  if (coincidenciaExacta) return coincidenciaExacta;

  return teamsArray.find(t => {
    if (t.strSport && t.strSport !== 'Soccer') return false;
    const strTeam = (t.strTeam || '').toLowerCase().trim();
    return strTeam.includes(searchNorm);
  }) || null;
}

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

// 🧠 FUNCIÓN AUXILIAR #1: Búsqueda por Texto (Respaldo)
function obtenerFavoritoSiCoincide(nombreEquipoAPI) {
  if (!nombreEquipoAPI) return null;
  const nombreNorm = nombreEquipoAPI.toLowerCase().trim();
  if (EXCLUSIONES.some(ex => nombreNorm.includes(ex))) return null;

  for (const fav of EQUIPOS_FAVORITOS) {
    const searchNorm = fav.strSearch.toLowerCase().trim();
    const nombreFavNorm = fav.nombre.toLowerCase().trim();
    if (nombreNorm === searchNorm || nombreNorm === nombreFavNorm) return fav;
    const regex = new RegExp(`\\b${searchNorm}\\b`, 'i');
    if (regex.test(nombreNorm)) return fav;
  }
  return null;
}

// 🧠 FUNCIÓN AUXILIAR #2 (NUEVA): Búsqueda Infallible por ID numérico de API-Football
function obtenerFavoritoPorIdAPI(idEquipoAPI) {
  if (!idEquipoAPI) return null;
  return EQUIPOS_FAVORITOS.find(fav => {
    if (Array.isArray(fav.idFootball)) {
      return fav.idFootball.includes(idEquipoAPI);
    }
    return fav.idFootball === idEquipoAPI;
  }) || null;
}

// 1️⃣ API #1: TheSportsDB (Próximos Partidos)
async function cargarProximosPartidosProgresivamente() {
  if (cargandoProximos) return;
  cargandoProximos = true;
  console.log('⏳ Iniciando buscador dinámico de próximos partidos...');

  let listaTemporal = [];

  for (const equipo of EQUIPOS_FAVORITOS) {
    const mainFavId = Array.isArray(equipo.idFootball) ? equipo.idFootball[0] : equipo.idFootball;

    try {
      const urlBusqueda = `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(equipo.strSearch)}`;
      const resBusqueda = await axios.get(urlBusqueda);
      
      const equipoEncontrado = encontrarEquipoSportsDB(resBusqueda.data?.teams, equipo);

      if (equipoEncontrado) {
        const urlPartidos = `https://www.thesportsdb.com/api/v1/json/3/eventsnext.php?id=${equipoEncontrado.idTeam}`;
        const resPartidos = await axios.get(urlPartidos);
        const proximosEventos = resPartidos.data?.events;

        if (proximosEventos && proximosEventos.length > 0) {
          const ahora = Date.now();

          const eventosRealmenteFuturos = proximosEventos.filter(ev => {
            if (ev.strSport && ev.strSport !== 'Soccer') return false;

            let fechaPartido;
            if (ev.strTimestamp) {
              fechaPartido = new Date(ev.strTimestamp).getTime();
            } else if (ev.dateEvent) {
              const hora = ev.strTime || '00:00:00';
              fechaPartido = new Date(`${ev.dateEvent}T${hora}+00:00`).getTime();
            }

            if (!fechaPartido || isNaN(fechaPartido)) return true;
            const toleranciaHoras = 4 * 60 * 60 * 1000;
            return (fechaPartido + toleranciaHoras) > ahora;
          });

          if (eventosRealmenteFuturos.length > 0) {
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

            const escudoEquipoFound = extraerEscudoTheSportsDB(equipoEncontrado);
            const escudoTrackedFinal = escudoEquipoFound || equipo.logoRespaldo || `https://media.api-sports.io/football/teams/${mainFavId}.png`;

            const logoLocalFinal = esLocal ? escudoTrackedFinal : (fixtureFutu.strHomeTeamBadge || null);
            const logoVisitanteFinal = !esLocal ? escudoTrackedFinal : (fixtureFutu.strAwayTeamBadge || null);

            listaTemporal.push({
              id: fixtureFutu.idEvent,
              equipoTrackedId: mainFavId,
              local: fixtureFutu.strHomeTeam,
              logoLocal: logoLocalFinal,
              visitante: fixtureFutu.strAwayTeam,
              logoVisitante: logoVisitanteFinal,
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
      const urlEscudoRespaldo = equipo.logoRespaldo || `https://media.api-sports.io/football/teams/${mainFavId}.png`;
      listaTemporal.push({
        id: `tbd-${mainFavId}`,
        equipoTrackedId: mainFavId,
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

// 2️⃣ API #2: API-Football (Partidos en vivo con DOBLE BLINDAJE)
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
    console.log(`🌐 API-Football detectó ${partidosLiveCrudos.length} partidos jugándose en el mundo.`);
    
    let nuevosEnVivo = [];

    partidosLiveCrudos.forEach(fixture => {
      try {
        const homeId = fixture.teams?.home?.id;
        const awayId = fixture.teams?.away?.id;
        const homeName = fixture.teams?.home?.name || '';
        const awayName = fixture.teams?.away?.name || '';

        // 🌟 DOBLE BLINDAJE: Primero verificamos si coincide el ID exacto, si no, intentamos con el nombre.
        const favHome = obtenerFavoritoPorIdAPI(homeId) || obtenerFavoritoSiCoincide(homeName);
        const favAway = obtenerFavoritoPorIdAPI(awayId) || obtenerFavoritoSiCoincide(awayName);
        const equipoFavoritoEncontrado = favHome || favAway;

        if (equipoFavoritoEncontrado) {
          console.log(`✅ ¡PARTIDO EN VIVO ATRAPADO! -> ${homeName} vs ${awayName}`);

          const statusCorto = fixture.fixture?.status?.short || '';
          const elapsed = fixture.fixture?.status?.elapsed || 0;
          const extra = fixture.fixture?.status?.extra;

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

          const anotadoresData = eventos
            .filter(e => e.type === 'Goal' && e.detail !== 'Missed Penalty')
            .map(e => ({
              equipo: e.team?.name || 'Desconocido',
              jugador: e.player?.name || 'Desconocido',
              minuto: e.time?.elapsed || 0,
              tipo: e.detail === 'Own Goal' ? 'Autogol' : e.detail === 'Penalty' ? 'Penal' : 'Gol'
            }));

          const tarjetasData = eventos
            .filter(e => e.type === 'Card')
            .map(e => ({
              equipo: e.team?.name || 'Desconocido',
              jugador: e.player?.name || 'Desconocido',
              minuto: e.time?.elapsed || 0,
              tipo: (e.detail || '').toLowerCase().includes('yellow') ? 'Amarilla' : 'Roja'
            }));

          const mainFavId = Array.isArray(equipoFavoritoEncontrado.idFootball) 
            ? equipoFavoritoEncontrado.idFootball[0] 
            : equipoFavoritoEncontrado.idFootball;

          nuevosEnVivo.push({
            id: fixture.fixture?.id,
            equipoIdFiltro1: mainFavId,
            equipoIdFiltro2: mainFavId,
            local: fixture.teams?.home?.name || 'Local',
            logoLocal: fixture.teams?.home?.logo || null,
            visitante: fixture.teams?.away?.name || 'Visitante',
            logoVisitante: fixture.teams?.away?.logo || null,
            golesLocal: fixture.goals?.home ?? 0,
            golesVisitante: fixture.goals?.away ?? 0,
            minuto: tiempoAmostrar,
            estado: statusCorto,
            esEnVivo: true,
            anotadores: anotadoresData,
            tarjetas: tarjetasData
          });
        }
      } catch (errLoop) {
        console.error('⚠️ Error al procesar un partido en vivo:', errLoop.message);
      }
    });

    partidosEnVivoCache = nuevosEnVivo;
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