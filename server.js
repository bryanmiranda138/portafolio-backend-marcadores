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

app.get('/', (req, res) => res.send('⚽ Servidor de Marcadores en vivo (Football-Data) funcionando.'));
app.get('/debug', (req, res) => res.json({ proximos: cacheProximosPartidos, enVivo: partidosEnVivoCache }));

// 🚀 Endpoint de Rayos X (Para Football-Data)
app.get('/debug-live', async (req, res) => {
  try {
    const responseLive = await axios.get('https://api.football-data.org/v4/matches?status=IN_PLAY,PAUSED', {
      headers: { 'X-Auth-Token': process.env.FOOTBALL_DATA_KEY }
    });

    const partidosJugandose = responseLive.data?.matches || [];
    const resumenEnVivo = partidosJugandose.map(p => ({
      partido: `${p.homeTeam.name} vs ${p.awayTeam.name}`,
      estado: p.status
    }));

    res.json({
      mensaje: "✅ Conexión con Football-Data exitosa",
      total_jugandose_en_el_mundo: partidosJugandose.length,
      resumen_partidos: resumenEnVivo
    });
  } catch (error) {
    res.status(500).json({ error: error.message, pista: "Verifica que FOOTBALL_DATA_KEY sea correcto" });
  }
});

// 📌 TUS EQUIPOS FAVORITOS
const EQUIPOS_FAVORITOS = [
  { nombre: 'FC Barcelona', idFootball: 529, strSearch: 'Barcelona' },
  { nombre: 'Real Madrid', idFootball: 541, strSearch: 'Real Madrid' },
  { nombre: 'Boca Juniors', idFootball: 451, strSearch: 'Boca Juniors' },
  { nombre: 'River Plate', idFootball: 435, strSearch: 'River Plate' },
  { nombre: 'Liverpool', idFootball: 40, strSearch: 'Liverpool' },
  { nombre: 'Manchester City', idFootball: 50, strSearch: 'Manchester City' },
  { nombre: 'C.D. Águila', idFootball: 2307, strSearch: 'Aguila' },
  { nombre: 'Inter Miami', idFootball: [9723, 8984], strSearch: 'Inter Miami', logoRespaldo: 'https://r2.thesportsdb.com/images/media/team/badge/m4it3e1602103647.png' },
  { nombre: 'Argentina', idFootball: 26, strSearch: 'Argentina' },
  { nombre: 'Brasil', idFootball: 6, strSearch: 'Brazil' },
  { nombre: 'Inglaterra', idFootball: 10, strSearch: 'England' },
  { nombre: 'Francia', idFootball: 2, strSearch: 'France' },
  { nombre: 'España', idFootball: 9, strSearch: 'Spain' }
];

const EXCLUSIONES = [
  'new england', 'barcelona sc', 'barcelona de guayaquil',
  'liverpool montevideo', 'river plate montevideo', 'real madrid b', 'barcelona b'
];

// ⏱️ TEMPORIZADOR RAPIDO: Football-Data permite 10 peticiones POR MINUTO. Cada 3 minutos es súper seguro.
const INTERVALO_CONSULTA = 1 * 60 * 1000;

let cacheProximosPartidos = [];
let cargandoProximos = false;
let partidosEnVivoCache = [];

const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function extraerEscudoTheSportsDB(objeto) {
  if (!objeto) return null;
  return objeto.strTeamBadge || objeto.strBadge || objeto.strTeamLogo ||
    objeto.strLogo || objeto.strHomeTeamBadge || objeto.strAwayTeamBadge || null;
}

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
    return (t.strTeam || '').toLowerCase().trim().includes(searchNorm);
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
    if (!mapaDeduplicacion.has(partido.id)) mapaDeduplicacion.set(partido.id, partido);
  });

  let listaFinal = Array.from(mapaDeduplicacion.values());

  if (socketEspecifico) socketEspecifico.emit('marcadores_actualizados', listaFinal);
  else io.emit('marcadores_actualizados', listaFinal);
}

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

// 1️⃣ API #1: TheSportsDB (Próximos Partidos - Intacto)
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
            if (ev.strTimestamp) fechaPartido = new Date(ev.strTimestamp).getTime();
            else if (ev.dateEvent) fechaPartido = new Date(`${ev.dateEvent}T${ev.strTime || '00:00:00'}+00:00`).getTime();
            if (!fechaPartido || isNaN(fechaPartido)) return true;
            return (fechaPartido + (2.5 * 60 * 60 * 1000)) > ahora;
          });

          if (eventosRealmenteFuturos.length > 0) {
            eventosRealmenteFuturos.sort((a, b) => {
              const timeA = a.strTimestamp ? new Date(a.strTimestamp).getTime() : new Date(`${a.dateEvent}T${a.strTime || '00:00:00'}+00:00`).getTime();
              const timeB = b.strTimestamp ? new Date(b.strTimestamp).getTime() : new Date(`${b.dateEvent}T${b.strTime || '00:00:00'}+00:00`).getTime();
              return timeA - timeB;
            });

            const fixtureFutu = eventosRealmenteFuturos[0];
            let fechaFormateada = 'Fecha por confirmar';
            if (fixtureFutu.strTimestamp) {
              const fechaUTC = new Date(fixtureFutu.strTimestamp);
              const fechaElSalvador = new Date(fechaUTC.getTime() - (6 * 60 * 60 * 1000));
              fechaFormateada = fechaElSalvador.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
            } else if (fixtureFutu.dateEvent) {
              fechaFormateada = `${fixtureFutu.dateEvent} ${fixtureFutu.strTime || ''}`.trim();
            }

            const esLocal = String(fixtureFutu.idHomeTeam) === String(equipoEncontrado.idTeam);
            const escudoEquipoFound = extraerEscudoTheSportsDB(equipoEncontrado);
            const escudoTrackedFinal = escudoEquipoFound || equipo.logoRespaldo || `https://media.api-sports.io/football/teams/${mainFavId}.png`;

            listaTemporal.push({
              id: fixtureFutu.idEvent,
              equipoTrackedId: mainFavId,
              local: fixtureFutu.strHomeTeam,
              logoLocal: esLocal ? escudoTrackedFinal : (fixtureFutu.strHomeTeamBadge || null),
              visitante: fixtureFutu.strAwayTeam,
              logoVisitante: !esLocal ? escudoTrackedFinal : (fixtureFutu.strAwayTeamBadge || null),
              golesLocal: 0, golesVisitante: 0, minuto: fechaFormateada, estado: 'PROXIMO', esEnVivo: false, anotadores: []
            });
          } else { throw new Error("Pasados"); }
        } else { throw new Error("Vacía"); }
      } else { throw new Error("No encontrado"); }
    } catch (err) {
      const urlEscudoRespaldo = equipo.logoRespaldo || `https://media.api-sports.io/football/teams/${mainFavId}.png`;
      listaTemporal.push({
        id: `tbd-${mainFavId}`, equipoTrackedId: mainFavId, local: equipo.nombre, logoLocal: urlEscudoRespaldo,
        visitante: 'Rival por definir', logoVisitante: null, golesLocal: 0, golesVisitante: 0,
        minuto: 'Fecha por confirmar', estado: 'PROXIMO', esEnVivo: false, anotadores: []
      });
    }

    cacheProximosPartidos = [...listaTemporal];
    emitirDatosAlFrontend();
    await esperar(1000);
  }
  cargandoProximos = false;
}

// 2️⃣ API #2: Football-Data.org (Con Algoritmo de Cálculo de Minutos)
async function buscarPartidosEnVivo() {
  try {
    console.log('🔍 Consultando partidos en vivo en Football-Data.org...');

    const token = process.env.FOOTBALL_DATA_KEY;
    if (!token) {
      console.error('🛑 ERROR: No se ha configurado la variable FOOTBALL_DATA_KEY');
      return;
    }

    const responseLive = await axios.get('https://api.football-data.org/v4/matches?status=IN_PLAY,PAUSED', {
      headers: { 'X-Auth-Token': token }
    });

    const partidosLiveCrudos = responseLive.data?.matches || [];
    let nuevosEnVivo = [];

    partidosLiveCrudos.forEach(match => {
      try {
        const homeName = match.homeTeam?.name || '';
        const awayName = match.awayTeam?.name || '';
        const homeShort = match.homeTeam?.shortName || '';
        const awayShort = match.awayTeam?.shortName || '';

        const favHome = obtenerFavoritoSiCoincide(homeName) || obtenerFavoritoSiCoincide(homeShort);
        const favAway = obtenerFavoritoSiCoincide(awayName) || obtenerFavoritoSiCoincide(awayShort);
        const equipoFavoritoEncontrado = favHome || favAway;

        if (equipoFavoritoEncontrado) {
          const statusCorto = match.status === 'PAUSED' ? 'HT' : 'LIVE';

          // 🧠 ALGORITMO INTELIGENTE PARA CALCULAR EL MINUTO
          let tiempoAmostrar = 'En Vivo';

          if (match.status === 'PAUSED') {
            tiempoAmostrar = 'Medio Tiempo';
          } else if (match.status === 'IN_PLAY' && match.utcDate) {
            // Tomamos la hora oficial de inicio y la hora actual
            const inicioPartido = new Date(match.utcDate).getTime();
            const ahora = Date.now();

            // Calculamos la diferencia en minutos reales
            const minutosTranscurridos = Math.floor((ahora - inicioPartido) / 60000);

            if (minutosTranscurridos <= 45) {
              // Primer tiempo
              tiempoAmostrar = `${minutosTranscurridos}'`;
            } else if (minutosTranscurridos > 45 && minutosTranscurridos <= 60) {
              // Si la API tarda en cambiar a 'PAUSED', lo limitamos a 45+
              tiempoAmostrar = `45+'`;
            } else {
              // Segundo tiempo: le restamos los 15 minutos que duró el descanso
              const minutoSegundoTiempo = minutosTranscurridos - 15;
              // Si pasa del 90, mostramos 90+
              tiempoAmostrar = minutoSegundoTiempo > 90 ? `90+'` : `${minutoSegundoTiempo}'`;
            }
          }

          const golesLocal = match.score?.fullTime?.home ?? 0;
          const golesVisitante = match.score?.fullTime?.away ?? 0;

          const mainFavId = Array.isArray(equipoFavoritoEncontrado.idFootball) ? equipoFavoritoEncontrado.idFootball[0] : equipoFavoritoEncontrado.idFootball;

          nuevosEnVivo.push({
            id: match.id,
            equipoIdFiltro1: mainFavId,
            equipoIdFiltro2: mainFavId,
            local: homeName || 'Local',
            logoLocal: match.homeTeam?.crest || null,
            visitante: awayName || 'Visitante',
            logoVisitante: match.awayTeam?.crest || null,
            golesLocal: golesLocal,
            golesVisitante: golesVisitante,
            minuto: tiempoAmostrar,
            estado: statusCorto,
            esEnVivo: true,
            anotadores: [],
            tarjetas: []
          });
        }
      } catch (errLoop) {
        console.error('⚠️ Error loop Football-Data:', errLoop.message);
      }
    });

    partidosEnVivoCache = nuevosEnVivo;
    emitirDatosAlFrontend();
  } catch (error) {
    console.error('❌ Error Football-Data:', error.message);
  }
}

// 🚀 ARRANQUE
buscarPartidosEnVivo();
setTimeout(cargarProximosPartidosProgresivamente, 2000);

// ¡Podemos volver a consultar cada 3 minutos sin miedo!
setInterval(buscarPartidosEnVivo, INTERVALO_CONSULTA);
setInterval(cargarProximosPartidosProgresivamente, 30 * 60 * 1000);

io.on('connection', (socket) => {
  emitirDatosAlFrontend(socket);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Servidor Multi-API corriendo en puerto ${PORT}`));