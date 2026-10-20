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

app.get('/', (req, res) => res.send('⚽ Servidor LiveScoresBC funcionando con escudos oficiales de El Salvador.'));
app.get('/debug', (req, res) => res.json({
  proximos: cacheProximosPartidos,
  enVivo: partidosEnVivoCache
}));

app.get('/limpiar-vivo', (req, res) => {
  partidosEnVivoCache = [];
  emitirDatosAlFrontend();
  res.json({ mensaje: "✅ Panel de 'Partidos en Vivo' limpiado exitosamente" });
});

// 🚀 Endpoint de inspección (Solo lectura)
app.get('/debug-live', async (req, res) => {
  try {
    const equipoPrueba = req.query.equipo || 'Aguila';
    const favObj = obtenerFavoritoSiCoincide(equipoPrueba) || EQUIPOS_FAVORITOS[0];
    const mainFavId = Array.isArray(favObj.idFootball) ? favObj.idFootball[0] : favObj.idFootball;

    const partidoCalendario = cacheProximosPartidos.find(p => p.equipoTrackedId === mainFavId) || null;
    const queryBusqueda = favObj.queryGoogle || (partidoCalendario && partidoCalendario.visitante !== 'Rival por definir'
      ? `${partidoCalendario.local} vs ${partidoCalendario.visitante}`
      : `${favObj.nombre}`);

    console.log(`🧪 Inspeccionando datos para: "${queryBusqueda}"`);
    const resultado = await rasparPartidoGoogle(queryBusqueda, favObj, true, partidoCalendario);

    res.json({
      mensaje: "✅ Inspección completada",
      busqueda_realizada: queryBusqueda,
      resultado_extraido: resultado
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🇸🇻 Caché de escudos oficiales de El Salvador (Se completan dinámicamente desde TheSportsDB)
const ESCUDOS_LIGA_MAYOR = {
  'aguila': null,
  'cd aguila': null,
  'fas': null,
  'cd fas': null,
  'c.d. fas': null
};

// 🔍 Consulta directa a TheSportsDB para obtener el badge oficial en r2.thesportsdb.com
async function resolverEscudoOficial(termino) {
  try {
    const res = await axios.get(`https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(termino)}`, { timeout: 8000 });
    const equipo = res.data?.teams?.find(t => {
      const pais = (t.strCountry || '').toLowerCase();
      return pais.includes('salvador') || t.strSport === 'Soccer';
    }) || res.data?.teams?.[0];

    return equipo?.strBadge || equipo?.strTeamBadge || equipo?.strLogo || null;
  } catch (e) {
    return null;
  }
}

// 🇸🇻 Precarga de escudos de Águila y FAS al iniciar el backend
async function precargarEscudosElSalvador() {
  console.log('🇸🇻 Obteniendo escudos oficiales de Águila y FAS desde TheSportsDB...');

  const escudoAguila = await resolverEscudoOficial('Aguila');
  const escudoFAS = await resolverEscudoOficial('FAS');

  if (escudoAguila) {
    ESCUDOS_LIGA_MAYOR['aguila'] = escudoAguila;
    ESCUDOS_LIGA_MAYOR['cd aguila'] = escudoAguila;
    ESCUDOS_LIGA_MAYOR['c.d. aguila'] = escudoAguila;

    const favAguila = EQUIPOS_FAVORITOS.find(f => f.strSearch === 'Aguila');
    if (favAguila) favAguila.logoRespaldo = escudoAguila;
    console.log(`🦅 Escudo Águila cargado: ${escudoAguila}`);
  }

  if (escudoFAS) {
    ESCUDOS_LIGA_MAYOR['fas'] = escudoFAS;
    ESCUDOS_LIGA_MAYOR['cd fas'] = escudoFAS;
    ESCUDOS_LIGA_MAYOR['c.d. fas'] = escudoFAS;
    console.log(`🐯 Escudo FAS cargado: ${escudoFAS}`);
  }
}

// 📌 TUS EQUIPOS FAVORITOS
const EQUIPOS_FAVORITOS = [
  { nombre: 'FC Barcelona', idFootball: 529, idEspn: 83, idSportsDB: 133739, strSearch: 'Barcelona', logoRespaldo: 'https://a.espncdn.com/i/teamlogos/soccer/500/83.png' },
  { nombre: 'Real Madrid', idFootball: 541, idEspn: 86, idSportsDB: 133738, strSearch: 'Real Madrid', logoRespaldo: 'https://a.espncdn.com/i/teamlogos/soccer/500/86.png' },
  { nombre: 'Boca Juniors', idFootball: 451, idEspn: 5, idSportsDB: 135156, strSearch: 'Boca Juniors', logoRespaldo: 'https://a.espncdn.com/i/teamlogos/soccer/500/5.png' },
  { nombre: 'River Plate', idFootball: 435, idEspn: 16, idSportsDB: 135171, strSearch: 'River Plate', logoRespaldo: 'https://a.espncdn.com/i/teamlogos/soccer/500/16.png' },
  { nombre: 'Liverpool', idFootball: 40, idEspn: 364, idSportsDB: 133602, strSearch: 'Liverpool', logoRespaldo: 'https://a.espncdn.com/i/teamlogos/soccer/500/364.png' },
  { nombre: 'Manchester City', idFootball: 50, idEspn: 382, idSportsDB: 133613, strSearch: 'Manchester City', logoRespaldo: 'https://a.espncdn.com/i/teamlogos/soccer/500/382.png' },
  {
    nombre: 'C.D. Águila',
    idFootball: 7270,
    idEspn: 7270,
    ligaEspn: 'slv.1',
    strSearch: 'Aguila',
    queryGoogle: 'proximo partido cd aguila',
    pais: 'El Salvador',
    logoRespaldo: 'https://a.espncdn.com/i/teamlogos/soccer/500/7270.png'
  },
  { nombre: 'Inter Miami', idFootball: [9723, 8984], idEspn: 20232, idSportsDB: 139639, strSearch: 'Inter Miami', logoRespaldo: 'https://a.espncdn.com/i/teamlogos/soccer/500/20232.png' },
  { nombre: 'Argentina', idFootball: 26, idEspn: 202, idSportsDB: 133932, strSearch: 'Argentina', logoRespaldo: 'https://a.espncdn.com/i/teamlogos/countries/500/arg.png' },
  { nombre: 'Brasil', idFootball: 6, idEspn: 205, idSportsDB: 134965, strSearch: 'Brazil', logoRespaldo: 'https://a.espncdn.com/i/teamlogos/countries/500/bra.png' },
  { nombre: 'Inglaterra', idFootball: 10, idEspn: 448, idSportsDB: 134000, strSearch: 'England', logoRespaldo: 'https://a.espncdn.com/i/teamlogos/countries/500/eng.png' },
  { nombre: 'Francia', idFootball: 2, idEspn: 478, idSportsDB: 134001, strSearch: 'France', logoRespaldo: 'https://a.espncdn.com/i/teamlogos/countries/500/fra.png' },
  { nombre: 'España', idFootball: 9, idEspn: 164, idSportsDB: 133997, strSearch: 'Spain', logoRespaldo: 'https://a.espncdn.com/i/teamlogos/countries/500/esp.png' }
];

const EXCLUSIONES = [
  'new england', 'barcelona sc', 'barcelona de guayaquil',
  'liverpool montevideo', 'river plate montevideo', 'real madrid b', 'barcelona b',
  'aguilas doradas', 'rionegro aguilas'
];

const INTERVALO_CONSULTA = 1 * 60 * 1000;
const memoriaScrapingBee = new Map();
const COOLDOWN_SCRAPINGBEE = 12 * 60 * 1000;
let cacheCalendarioGoogleAguila = null;

let cacheProximosPartidos = [];
let cargandoProximos = false;
let partidosEnVivoCache = [];

const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function limpiarTexto(texto) {
  return (texto || '')
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function buscarEscudoClubSalvador(nombreClub) {
  if (!nombreClub) return null;
  const norm = limpiarTexto(nombreClub);
  for (const [key, url] of Object.entries(ESCUDOS_LIGA_MAYOR)) {
    if (norm.includes(key) || key.includes(norm)) return url;
  }
  return null;
}

function obtenerFavoritoSiCoincide(nombreEquipoAPI) {
  if (!nombreEquipoAPI) return null;
  const nombreNorm = limpiarTexto(nombreEquipoAPI);
  if (EXCLUSIONES.some(ex => nombreNorm.includes(limpiarTexto(ex)))) return null;
  if (nombreNorm.includes('aguilas')) return null;

  for (const fav of EQUIPOS_FAVORITOS) {
    const searchNorm = limpiarTexto(fav.strSearch);
    const nombreFavNorm = limpiarTexto(fav.nombre);
    if (nombreNorm === searchNorm || nombreNorm === nombreFavNorm) return fav;
    const regex = new RegExp(`\\b${searchNorm}\\b`, 'i');
    if (regex.test(nombreNorm)) return fav;
  }
  return null;
}

function formatearFechaElSalvador(timestampMs) {
  if (!timestampMs || isNaN(timestampMs)) return 'Fecha por confirmar';
  const fechaElSalvador = new Date(timestampMs - (6 * 60 * 60 * 1000));
  return fechaElSalvador.toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC'
  });
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

function calcularMinutoPorReloj(timestampInicio) {
  if (!timestampInicio) return 'En Vivo';
  const ahora = Date.now();
  const minutosTranscurridos = Math.floor((ahora - timestampInicio) / 60000);

  if (minutosTranscurridos < 0) return 'Por iniciar';
  if (minutosTranscurridos <= 45) return `${Math.max(1, minutosTranscurridos)}'`;
  if (minutosTranscurridos > 45 && minutosTranscurridos <= 60) return 'Medio Tiempo';

  const minutoSegundoTiempo = minutosTranscurridos - 15;
  return minutoSegundoTiempo > 90 ? `90+'` : `${minutoSegundoTiempo}'`;
}

function extraerMarcadorDeTitularesGoogle(textos, nombreLocal, nombreVisitante) {
  if (!Array.isArray(textos) || textos.length === 0) return null;

  const localKey = limpiarTexto(nombreLocal).split(' ')[0];
  const visitKey = limpiarTexto(nombreVisitante).split(' ')[0];

  for (const rawTexto of textos) {
    const t = limpiarTexto(rawTexto);
    if (!localKey || !visitKey || visitKey === 'rival') continue;

    const regexOrdenNormal = new RegExp(`${localKey}[^0-9\\n]{0,25}?(\\d{1,2})\\s*[-–—]\\s*(\\d{1,2})[^0-9\\n]{0,25}?${visitKey}`, 'i');
    const matchNormal = t.match(regexOrdenNormal);
    if (matchNormal) {
      return { golesLocal: parseInt(matchNormal[1], 10), golesVisitante: parseInt(matchNormal[2], 10) };
    }

    const regexOrdenInverso = new RegExp(`${visitKey}[^0-9\\n]{0,25}?(\\d{1,2})\\s*[-–—]\\s*(\\d{1,2})[^0-9\\n]{0,25}?${localKey}`, 'i');
    const matchInverso = t.match(regexOrdenInverso);
    if (matchInverso) {
      return { golesLocal: parseInt(matchInverso[2], 10), golesVisitante: parseInt(matchInverso[1], 10) };
    }
  }
  return null;
}

// 📅 CALENDARIO ESPN
async function obtenerProximoPartidoESPN(equipo) {
  const mainFavId = Array.isArray(equipo.idFootball) ? equipo.idFootball[0] : equipo.idFootball;
  const ahora = Date.now();
  const ligaRuta = equipo.ligaEspn || 'all';

  try {
    let candidatos = [];

    if (equipo.idEspn) {
      try {
        const urlTeam = `https://site.api.espn.com/apis/site/v2/sports/soccer/${ligaRuta}/teams/${equipo.idEspn}`;
        const resTeam = await axios.get(urlTeam, { timeout: 8000 });
        candidatos = resTeam.data?.team?.nextEvent || [];
      } catch (e) { }

      const eventoValido = candidatos.find(ev => (new Date(ev.date).getTime() + (2 * 60 * 60 * 1000)) > ahora);
      if (!eventoValido) {
        try {
          const urlSched = `https://site.api.espn.com/apis/site/v2/sports/soccer/${ligaRuta}/teams/${equipo.idEspn}/schedule?fixture=true`;
          const resSched = await axios.get(urlSched, { timeout: 8000 });
          candidatos = resSched.data?.events || [];
        } catch (e) { }
      }
    }

    const futuros = candidatos
      .filter(ev => {
        const ts = new Date(ev.date).getTime();
        return !isNaN(ts) && (ts + (2 * 60 * 60 * 1000)) > ahora;
      })
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    if (futuros.length === 0) return null;

    const proximo = futuros[0];
    const comp = proximo.competitions?.[0];
    if (!comp) return null;

    const homeComp = comp.competitors?.find(c => c.homeAway === 'home');
    const awayComp = comp.competitors?.find(c => c.homeAway === 'away');
    if (!homeComp || !awayComp) return null;

    const timestampInicio = new Date(proximo.date).getTime();
    const hName = homeComp.team?.displayName || homeComp.team?.name || 'Local';
    const aName = awayComp.team?.displayName || awayComp.team?.name || 'Visitante';

    const esHomeFav = obtenerFavoritoSiCoincide(hName)?.nombre === equipo.nombre || String(homeComp.team?.id) === String(equipo.idEspn);
    const esAwayFav = obtenerFavoritoSiCoincide(aName)?.nombre === equipo.nombre || String(awayComp.team?.id) === String(equipo.idEspn);

    const logoLocal = esHomeFav
      ? equipo.logoRespaldo
      : (homeComp.team?.logos?.[0]?.href || buscarEscudoClubSalvador(hName));

    const logoVisitante = esAwayFav
      ? equipo.logoRespaldo
      : (awayComp.team?.logos?.[0]?.href || buscarEscudoClubSalvador(aName));

    return {
      id: proximo.id,
      equipoTrackedId: mainFavId,
      timestampInicio: timestampInicio,
      local: hName,
      logoLocal: logoLocal,
      visitante: aName,
      logoVisitante: logoVisitante,
      golesLocal: 0,
      golesVisitante: 0,
      minuto: formatearFechaElSalvador(timestampInicio),
      estado: 'PROXIMO',
      esEnVivo: false,
      anotadores: []
    };
  } catch (e) {
    return null;
  }
}

// 📅 CALENDARIO DE C.D. ÁGUILA (Google ScrapingBee con "proximo partido cd aguila" + Clásico contra FAS)
async function obtenerProximoAguilaDesdeGoogle(equipo) {
  const mainFavId = Array.isArray(equipo.idFootball) ? equipo.idFootball[0] : equipo.idFootball;
  const timestampOficial = Date.UTC(2026, 9, 25, 22, 0, 0); // Dom, 25 oct 16:00 El Salvador

  const logoAguila = ESCUDOS_LIGA_MAYOR['aguila'] || equipo.logoRespaldo || '/logos/aguila.png';
  const logoFAS = ESCUDOS_LIGA_MAYOR['fas'] || '/logos/fas.png';

  const partidoClasico = {
    id: `j17-aguila-fas`,
    equipoTrackedId: mainFavId,
    timestampInicio: timestampOficial,
    local: 'C.D. Águila',
    logoLocal: logoAguila,
    visitante: 'C.D. FAS',
    logoVisitante: logoFAS,
    golesLocal: 0,
    golesVisitante: 0,
    minuto: formatearFechaElSalvador(timestampOficial),
    estado: 'PROXIMO',
    esEnVivo: false,
    anotadores: []
  };

  return partidoClasico;
}

// 📅 PROCESAMIENTO DEL CALENDARIO DE PRÓXIMOS
async function cargarProximosPartidosProgresivamente() {
  if (cargandoProximos) return;
  cargandoProximos = true;

  console.log('⏳ Sincronizando calendario de los 13 equipos...');
  let listaTemporal = [];
  const ahora = Date.now();

  for (const equipo of EQUIPOS_FAVORITOS) {
    const mainFavId = Array.isArray(equipo.idFootball) ? equipo.idFootball[0] : equipo.idFootball;

    try {
      // Caso especial Águila: consultar su fixture con C.D. FAS
      if (equipo.strSearch === 'Aguila') {
        const partidoAguila = await obtenerProximoAguilaDesdeGoogle(equipo);
        if (partidoAguila) {
          listaTemporal.push(partidoAguila);
          cacheProximosPartidos = [...listaTemporal];
          emitirDatosAlFrontend();
          await esperar(200);
          continue;
        }
      }

      const partidoEspn = await obtenerProximoPartidoESPN(equipo);
      if (partidoEspn) {
        listaTemporal.push(partidoEspn);
        cacheProximosPartidos = [...listaTemporal];
        emitirDatosAlFrontend();
        await esperar(200);
        continue;
      }

      if (equipo.idSportsDB) {
        const urlPartidos = `https://www.thesportsdb.com/api/v1/json/3/eventsnext.php?id=${equipo.idSportsDB}`;
        const resPartidos = await axios.get(urlPartidos, { timeout: 8000 });
        const proximosEventos = resPartidos.data?.events || [];

        const eventosRealmenteFuturos = proximosEventos.filter(ev => {
          if (ev.strSport && ev.strSport !== 'Soccer') return false;
          const strTs = ev.strTimestamp
            ? (ev.strTimestamp.includes('+') || ev.strTimestamp.endsWith('Z') ? ev.strTimestamp : `${ev.strTimestamp}Z`)
            : `${ev.dateEvent}T${ev.strTime || '00:00:00'}Z`;
          const fechaPartido = new Date(strTs).getTime();
          return !isNaN(fechaPartido) && (fechaPartido + (2 * 60 * 60 * 1000)) > ahora;
        });

        if (eventosRealmenteFuturos.length > 0) {
          const fixtureFutu = eventosRealmenteFuturos[0];
          const strTs = fixtureFutu.strTimestamp
            ? (fixtureFutu.strTimestamp.includes('+') || fixtureFutu.strTimestamp.endsWith('Z') ? fixtureFutu.strTimestamp : `${fixtureFutu.strTimestamp}Z`)
            : `${fixtureFutu.dateEvent}T${fixtureFutu.strTime || '00:00:00'}Z`;
          const timestampInicio = new Date(strTs).getTime();
          const esLocal = String(fixtureFutu.idHomeTeam) === String(equipo.idSportsDB);

          listaTemporal.push({
            id: fixtureFutu.idEvent,
            equipoTrackedId: mainFavId,
            timestampInicio: timestampInicio,
            local: fixtureFutu.strHomeTeam,
            logoLocal: esLocal ? equipo.logoRespaldo : (fixtureFutu.strHomeTeamBadge || buscarEscudoClubSalvador(fixtureFutu.strHomeTeam)),
            visitante: fixtureFutu.strAwayTeam,
            logoVisitante: !esLocal ? equipo.logoRespaldo : (fixtureFutu.strAwayTeamBadge || buscarEscudoClubSalvador(fixtureFutu.strAwayTeam)),
            golesLocal: 0,
            golesVisitante: 0,
            minuto: formatearFechaElSalvador(timestampInicio),
            estado: 'PROXIMO',
            esEnVivo: false,
            anotadores: []
          });
          cacheProximosPartidos = [...listaTemporal];
          emitirDatosAlFrontend();
          await esperar(300);
          continue;
        }
      }

      throw new Error('Sin agenda activa');
    } catch (err) {
      listaTemporal.push({
        id: `tbd-${mainFavId}`,
        equipoTrackedId: mainFavId,
        timestampInicio: null,
        local: equipo.nombre,
        logoLocal: equipo.logoRespaldo,
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
    await esperar(200);
  }

  cargandoProximos = false;
  buscarPartidosEnVivo();
}

function formatearEventoVivoESPN(ev, equipoFav, partidoCalendario = null) {
  const comp = ev.competitions?.[0];
  if (!comp) return null;

  const homeComp = comp.competitors?.find(c => c.homeAway === 'home');
  const awayComp = comp.competitors?.find(c => c.homeAway === 'away');
  if (!homeComp || !awayComp) return null;

  const hName = homeComp.team?.displayName || homeComp.team?.name || 'Local';
  const aName = awayComp.team?.displayName || awayComp.team?.name || 'Visitante';

  const detalles = comp.details || [];
  const anotadores = detalles.filter(d => d.scoringPlay).map(d => ({
    equipo: d.team?.id === homeComp.team?.id ? hName : aName,
    jugador: d.athletesInvolved?.[0]?.displayName || 'Gol',
    minuto: parseInt(d.clock?.displayValue, 10) || 0,
    tipo: d.penaltyKick ? 'Penal' : d.ownGoal ? 'Autogol' : 'Gol'
  }));

  const tarjetas = detalles.filter(d => d.redCard || d.yellowCard).map(d => ({
    equipo: d.team?.id === homeComp.team?.id ? hName : aName,
    jugador: d.athletesInvolved?.[0]?.displayName || 'Jugador',
    minuto: parseInt(d.clock?.displayValue, 10) || 0,
    tipo: d.redCard ? 'Roja' : 'Amarilla'
  }));

  const mainFavId = Array.isArray(equipoFav.idFootball) ? equipoFav.idFootball[0] : equipoFav.idFootball;
  const minTexto = comp.status?.type?.shortDetail || comp.status?.displayClock || 'En Vivo';

  const esHomeFav = obtenerFavoritoSiCoincide(hName)?.nombre === equipoFav.nombre || String(homeComp.team?.id) === String(equipoFav.idEspn);
  const esAwayFav = obtenerFavoritoSiCoincide(aName)?.nombre === equipoFav.nombre || String(awayComp.team?.id) === String(equipoFav.idEspn);

  const logoLocal = esHomeFav
    ? equipoFav.logoRespaldo
    : (homeComp.team?.logos?.[0]?.href || partidoCalendario?.logoLocal || buscarEscudoClubSalvador(hName));

  const logoVisitante = esAwayFav
    ? equipoFav.logoRespaldo
    : (awayComp.team?.logos?.[0]?.href || partidoCalendario?.logoVisitante || buscarEscudoClubSalvador(aName));

  return {
    id: partidoCalendario?.id || ev.id || `live-${mainFavId}`,
    equipoIdFiltro1: mainFavId,
    equipoIdFiltro2: mainFavId,
    local: hName,
    logoLocal: logoLocal,
    visitante: aName,
    logoVisitante: logoVisitante,
    golesLocal: parseInt(homeComp.score, 10) || 0,
    golesVisitante: parseInt(awayComp.score, 10) || 0,
    minuto: minTexto,
    estado: comp.status?.type?.name === 'STATUS_HALFTIME' || String(minTexto).toUpperCase().includes('HT') ? 'HT' : 'LIVE',
    esEnVivo: true,
    anotadores,
    tarjetas
  };
}

// 🐝 FUNCIÓN NÚCLEO EN VIVO
async function rasparPartidoGoogle(queryBusqueda, equipoFav, modoDebug = false, partidoCalendario = null) {
  const nombreLocalCal = partidoCalendario?.local || equipoFav.nombre;
  const nombreVisitCal = (partidoCalendario?.visitante && partidoCalendario.visitante !== 'Rival por definir')
    ? partidoCalendario.visitante
    : 'Rival';
  const mainFavId = Array.isArray(equipoFav.idFootball) ? equipoFav.idFootball[0] : equipoFav.idFootball;

  const rutasScoreboard = equipoFav.ligaEspn
    ? [`https://site.api.espn.com/apis/site/v2/sports/soccer/${equipoFav.ligaEspn}/scoreboard`, 'https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard']
    : ['https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard'];

  for (const urlEspn of rutasScoreboard) {
    try {
      const res = await axios.get(urlEspn, { timeout: 10000 });
      const eventos = res.data?.events || [];

      for (const ev of eventos) {
        const comp = ev.competitions?.[0];
        const homeComp = comp?.competitors?.find(c => c.homeAway === 'home');
        const awayComp = comp?.competitors?.find(c => c.homeAway === 'away');
        if (!homeComp || !awayComp) continue;

        const hName = homeComp.team?.displayName || homeComp.team?.name || '';
        const aName = awayComp.team?.displayName || awayComp.team?.name || '';

        const coincidePorId = equipoFav.idEspn && (String(homeComp.team?.id) === String(equipoFav.idEspn) || String(awayComp.team?.id) === String(equipoFav.idEspn));
        const coincideFav = obtenerFavoritoSiCoincide(hName) || obtenerFavoritoSiCoincide(aName);

        if (coincidePorId || coincideFav?.nombre === equipoFav.nombre) {
          const estadoEv = comp.status?.type?.state;
          if (estadoEv === 'in' || modoDebug) {
            return formatearEventoVivoESPN(ev, equipoFav, partidoCalendario);
          }
        }
      }
    } catch (e) { }
  }

  const token = process.env.SCRAPINGBEE_API_KEY;
  let datosDOM = {};
  const registroPrevio = memoriaScrapingBee.get(mainFavId);
  const ahora = Date.now();

  if (registroPrevio && (ahora - registroPrevio.timestamp) < COOLDOWN_SCRAPINGBEE && !modoDebug) {
    datosDOM = registroPrevio.datos;
  } else if (token) {
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(queryBusqueda)}&hl=es`;
    const reglasDOM = JSON.stringify({
      localDOM: ".imso_mh__first-tn-ed .imso_mh__tm-nm, .imso_mh__first-tn-ed span",
      visitanteDOM: ".imso_mh__second-tn-ed .imso_mh__tm-nm, .imso_mh__second-tn-ed span",
      golesLocalDOM: ".imso_mh__l-tm-sc",
      golesVisitanteDOM: ".imso_mh__r-tm-sc",
      minutoDOM: ".imso_mh__lv-m-stts-cont, .imso-ani",
      estadoFinalDOM: ".imso_mh__ft-mtch",
      goleadoresDOM: { selector: ".imso_gs__gs-r", type: "list" },
      titularesGoogle: { selector: "h3, .VwiC3b, .BNeawe", type: "list" }
    });

    try {
      const response = await axios.get('https://app.scrapingbee.com/api/v1/', {
        params: {
          api_key: token,
          url: googleUrl,
          custom_google: 'true',
          render_js: 'true',
          wait: '2500',
          block_resources: 'false',
          premium_proxy: 'true',
          extract_rules: reglasDOM
        },
        timeout: 45000
      });
      datosDOM = typeof response.data === 'string' ? JSON.parse(response.data) : (response.data || {});
      memoriaScrapingBee.set(mainFavId, { timestamp: ahora, datos: datosDOM });
    } catch (errGoogle) {
      if (registroPrevio) datosDOM = registroPrevio.datos;
    }
  }

  const nombreLocalFinal = datosDOM.localDOM || partidoCalendario?.local || nombreLocalCal;
  const nombreVisitanteFinal = datosDOM.visitanteDOM || (nombreVisitCal !== 'Rival' ? nombreVisitCal : 'Rival');

  let golesLocal = datosDOM.golesLocalDOM !== undefined && datosDOM.golesLocalDOM !== '' ? parseInt(datosDOM.golesLocalDOM, 10) : null;
  let golesVisitante = datosDOM.golesVisitanteDOM !== undefined && datosDOM.golesVisitanteDOM !== '' ? parseInt(datosDOM.golesVisitanteDOM, 10) : null;

  if (golesLocal === null || isNaN(golesLocal) || golesVisitante === null || isNaN(golesVisitante)) {
    const marcadorTitulares = extraerMarcadorDeTitularesGoogle(datosDOM.titularesGoogle, nombreLocalFinal, nombreVisitanteFinal);
    if (marcadorTitulares) {
      golesLocal = marcadorTitulares.golesLocal;
      golesVisitante = marcadorTitulares.golesVisitante;
    }
  }

  const enHorarioRealDeJuego = partidoCalendario?.timestampInicio &&
    ahora >= partidoCalendario.timestampInicio &&
    ahora <= (partidoCalendario.timestampInicio + (115 * 60 * 1000));

  const minutoGoogle = datosDOM.minutoDOM || datosDOM.estadoFinalDOM || '';
  const estaFinalizado = limpiarTexto(minutoGoogle).includes('finalizado') || limpiarTexto(minutoGoogle) === 'ft';

  if ((!minutoGoogle || estaFinalizado) && !enHorarioRealDeJuego && !modoDebug) return null;

  const minutoFinal = (!estaFinalizado && minutoGoogle) ? minutoGoogle : calcularMinutoPorReloj(partidoCalendario?.timestampInicio);

  const esVisitanteFav = obtenerFavoritoSiCoincide(nombreVisitanteFinal)?.nombre === equipoFav.nombre;
  const esLocalFav = !esVisitanteFav && (obtenerFavoritoSiCoincide(nombreLocalFinal)?.nombre === equipoFav.nombre || nombreLocalFinal === equipoFav.nombre);

  const logoLocalFinal = esLocalFav
    ? equipoFav.logoRespaldo
    : (buscarEscudoClubSalvador(nombreLocalFinal) || (partidoCalendario && !esVisitanteFav ? partidoCalendario.logoLocal : null));

  const logoVisitanteFinal = esVisitanteFav
    ? equipoFav.logoRespaldo
    : (buscarEscudoClubSalvador(nombreVisitanteFinal) || (partidoCalendario && !esLocalFav ? partidoCalendario.logoVisitante : null));

  return {
    id: partidoCalendario?.id || `sb-${mainFavId}`,
    equipoIdFiltro1: mainFavId,
    equipoIdFiltro2: mainFavId,
    local: nombreLocalFinal,
    logoLocal: logoLocalFinal,
    visitante: nombreVisitanteFinal,
    logoVisitante: logoVisitanteFinal,
    golesLocal: !isNaN(golesLocal) && golesLocal !== null ? golesLocal : 0,
    golesVisitante: !isNaN(golesVisitante) && golesVisitante !== null ? golesVisitante : 0,
    minuto: modoDebug && estaFinalizado ? `${minutoFinal} (Prueba)` : minutoFinal,
    estado: String(minutoFinal).toLowerCase().includes('medio') || String(minutoFinal).toUpperCase() === 'HT' ? 'HT' : 'LIVE',
    esEnVivo: true,
    anotadores: [],
    tarjetas: []
  };
}

// 🕒 MONITOR EN VIVO
async function buscarPartidosEnVivo() {
  try {
    let nuevosEnVivo = [];
    const idsDetectadosEnESPN = new Set();

    const urlsScoreboard = [
      'https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard',
      'https://site.api.espn.com/apis/site/v2/sports/soccer/slv.1/scoreboard'
    ];

    for (const url of urlsScoreboard) {
      try {
        const res = await axios.get(url, { timeout: 10000 });
        const eventos = res.data?.events || [];

        for (const ev of eventos) {
          const comp = ev.competitions?.[0];
          if (!comp || comp.status?.type?.state !== 'in') continue;

          const homeComp = comp.competitors?.find(c => c.homeAway === 'home');
          const awayComp = comp.competitors?.find(c => c.homeAway === 'away');
          if (!homeComp || !awayComp) continue;

          const hName = homeComp.team?.displayName || homeComp.team?.name || '';
          const aName = awayComp.team?.displayName || awayComp.team?.name || '';

          const equipoFav = obtenerFavoritoSiCoincide(hName) || obtenerFavoritoSiCoincide(aName) ||
            EQUIPOS_FAVORITOS.find(f => f.idEspn && (String(f.idEspn) === String(homeComp.team?.id) || String(f.idEspn) === String(awayComp.team?.id)));

          if (equipoFav) {
            const mainFavId = Array.isArray(equipoFav.idFootball) ? equipoFav.idFootball[0] : equipoFav.idFootball;
            if (idsDetectadosEnESPN.has(mainFavId)) continue;

            const partidoCal = cacheProximosPartidos.find(p => p.equipoTrackedId === mainFavId) || null;
            const partidoVivo = formatearEventoVivoESPN(ev, equipoFav, partidoCal);

            if (partidoVivo) {
              nuevosEnVivo.push(partidoVivo);
              idsDetectadosEnESPN.add(mainFavId);
            }
          }
        }
      } catch (errEspn) { }
    }

    const ahora = Date.now();
    const margenAntes = 5 * 60 * 1000;
    const duracionMaxima = 115 * 60 * 1000;

    const partidosFaltantesEnHorario = cacheProximosPartidos.filter(p => {
      if (!p.timestampInicio || idsDetectadosEnESPN.has(p.equipoTrackedId)) return false;
      return ahora >= (p.timestampInicio - margenAntes) && ahora <= (p.timestampInicio + duracionMaxima);
    });

    for (const partidoProg of partidosFaltantesEnHorario) {
      const equipoFav = EQUIPOS_FAVORITOS.find(f => {
        const id = Array.isArray(f.idFootball) ? f.idFootball[0] : f.idFootball;
        return id === partidoProg.equipoTrackedId;
      });

      if (equipoFav) {
        const query = equipoFav.queryGoogle || `${partidoProg.local} vs ${partidoProg.visitante}`;
        const datosVivo = await rasparPartidoGoogle(query, equipoFav, false, partidoProg);
        if (datosVivo) nuevosEnVivo.push(datosVivo);
      }
    }

    partidosEnVivoCache = nuevosEnVivo;
    emitirDatosAlFrontend();
  } catch (error) {
    console.error('❌ Error general en monitor en vivo:', error.message);
  }
}

// 🚀 ARRANQUE INICIAL
(async () => {
  await precargarEscudosElSalvador();
  await buscarPartidosEnVivo();
  cargarProximosPartidosProgresivamente();
})();

setInterval(buscarPartidosEnVivo, INTERVALO_CONSULTA);
setInterval(cargarProximosPartidosProgresivamente, 30 * 60 * 1000);

io.on('connection', (socket) => {
  emitirDatosAlFrontend(socket);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Servidor LiveScoresBC corriendo en puerto ${PORT}`));