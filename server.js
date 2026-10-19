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

app.get('/', (req, res) => res.send('⚽ Servidor LiveScoresBC (ESPN + TheSportsDB + ScrapingBee) funcionando.'));
app.get('/debug', (req, res) => res.json({ proximos: cacheProximosPartidos, enVivo: partidosEnVivoCache }));

// 🚀 Endpoint de Rayos X: Permite probar e inyectar un partido en cualquier momento
app.get('/debug-live', async (req, res) => {
  try {
    const equipoPrueba = req.query.equipo || 'Barcelona';
    const favObj = obtenerFavoritoSiCoincide(equipoPrueba) || EQUIPOS_FAVORITOS[0];
    const mainFavId = Array.isArray(favObj.idFootball) ? favObj.idFootball[0] : favObj.idFootball;

    const partidoCalendario = cacheProximosPartidos.find(p => p.equipoTrackedId === mainFavId) || null;
    const queryBusqueda = favObj.queryGoogle || (partidoCalendario && partidoCalendario.visitante !== 'Rival por definir'
      ? `${partidoCalendario.local} vs ${partidoCalendario.visitante}`
      : `${favObj.nombre}`);

    console.log(`🧪 Ejecutando prueba para: "${queryBusqueda}"`);
    const resultado = await rasparPartidoGoogle(queryBusqueda, favObj, true, partidoCalendario);

    if (resultado) {
      partidosEnVivoCache = [
        ...partidosEnVivoCache.filter(p => p.equipoIdFiltro1 !== mainFavId),
        resultado
      ];
      emitirDatosAlFrontend();
    }

    res.json({
      mensaje: "✅ Consulta completada e inyectada en tu panel de 'Partidos en Vivo'",
      busqueda_realizada: queryBusqueda,
      resultado_extraido: resultado
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 📌 TUS EQUIPOS FAVORITOS (Con IDs directos de ESPN y TheSportsDB para evitar bloqueos 429)
const EQUIPOS_FAVORITOS = [
  { nombre: 'FC Barcelona', idFootball: 529, idEspn: 83, idSportsDB: 133739, strSearch: 'Barcelona', logoRespaldo: 'https://a.espncdn.com/i/teamlogos/soccer/500/83.png' },
  { nombre: 'Real Madrid', idFootball: 541, idEspn: 86, idSportsDB: 133738, strSearch: 'Real Madrid', logoRespaldo: 'https://a.espncdn.com/i/teamlogos/soccer/500/86.png' },
  { nombre: 'Boca Juniors', idFootball: 451, idEspn: 5, idSportsDB: 135156, strSearch: 'Boca Juniors', logoRespaldo: 'https://a.espncdn.com/i/teamlogos/soccer/500/5.png' },
  { nombre: 'River Plate', idFootball: 435, idEspn: 16, idSportsDB: 135171, strSearch: 'River Plate', logoRespaldo: 'https://a.espncdn.com/i/teamlogos/soccer/500/16.png' },
  { nombre: 'Liverpool', idFootball: 40, idEspn: 364, idSportsDB: 133602, strSearch: 'Liverpool', logoRespaldo: 'https://a.espncdn.com/i/teamlogos/soccer/500/364.png' },
  { nombre: 'Manchester City', idFootball: 50, idEspn: 382, idSportsDB: 133613, strSearch: 'Manchester City', logoRespaldo: 'https://a.espncdn.com/i/teamlogos/soccer/500/382.png' },
  {
    nombre: 'C.D. Águila',
    idFootball: 4300,
    idEspn: 7270,
    ligaEspn: 'slv.1',
    idSportsDB: 142622,
    strSearch: 'Aguila',
    queryGoogle: 'c d aguila',
    pais: 'El Salvador',
    logoRespaldo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/69/Escudo_del_Club_Deportivo_%C3%81guila.svg/500px-Escudo_del_Club_Deportivo_%C3%81guila.svg.png'
  }, { nombre: 'Inter Miami', idFootball: [9723, 8984], idEspn: 20232, idSportsDB: 139639, strSearch: 'Inter Miami', logoRespaldo: 'https://a.espncdn.com/i/teamlogos/soccer/500/20232.png' },
  { nombre: 'Argentina', idFootball: 26, idEspn: 202, idSportsDB: 133932, strSearch: 'Argentina', logoRespaldo: 'https://a.espncdn.com/i/teamlogos/countries/500/arg.png' },
  { nombre: 'Brasil', idFootball: 6, idEspn: 205, idSportsDB: 134965, strSearch: 'Brazil', logoRespaldo: 'https://a.espncdn.com/i/teamlogos/countries/500/bra.png' },
  { nombre: 'Inglaterra', idFootball: 10, idEspn: 448, idSportsDB: 134000, strSearch: 'England', logoRespaldo: 'https://a.espncdn.com/i/teamlogos/countries/500/eng.png' },
  { nombre: 'Francia', idFootball: 2, idEspn: 478, idSportsDB: 134001, strSearch: 'France', logoRespaldo: 'https://a.espncdn.com/i/teamlogos/countries/500/fra.png' },
  { nombre: 'España', idFootball: 9, idEspn: 164, idSportsDB: 133997, strSearch: 'Spain', logoRespaldo: 'https://a.espncdn.com/i/teamlogos/countries/500/esp.png' }
];

const EXCLUSIONES = [
  'new england', 'barcelona sc', 'barcelona de guayaquil',
  'liverpool montevideo', 'river plate montevideo', 'real madrid b', 'barcelona b'
];

// ⏱️ Actualización cada 1 minuto (0 créditos en ESPN) + Freno de 12 min exclusivo para ScrapingBee
const INTERVALO_CONSULTA = 1 * 60 * 1000;
const memoriaScrapingBee = new Map();
const COOLDOWN_SCRAPINGBEE = 12 * 60 * 1000;

let cacheProximosPartidos = [];
let cargandoProximos = false;
let partidosEnVivoCache = [];

const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

function limpiarTexto(texto) {
  return (texto || '')
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Elimina tildes (Águila -> aguila)
    .trim();
}

function obtenerFavoritoSiCoincide(nombreEquipoAPI) {
  if (!nombreEquipoAPI) return null;
  const nombreNorm = limpiarTexto(nombreEquipoAPI);
  if (EXCLUSIONES.some(ex => nombreNorm.includes(limpiarTexto(ex)))) return null;

  // Evitamos confundir a C.D. Águila con "Águilas Doradas" (Colombia) o "Águilas" en plural
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

  const limpiar = (str) => (str || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  const localKey = limpiar(nombreLocal).split(' ')[0];
  const visitKey = limpiar(nombreVisitante).split(' ')[0];

  for (const rawTexto of textos) {
    const t = limpiar(rawTexto);
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

// 📅 FUNCIÓN AUXILIAR: Obtener el próximo partido real desde ESPN Team API + Schedule API
async function obtenerProximoPartidoESPN(equipo) {
  if (!equipo.idEspn && !equipo.ligaEspn) return null;
  const mainFavId = Array.isArray(equipo.idFootball) ? equipo.idFootball[0] : equipo.idFootball;
  const ahora = Date.now();
  const ligaRuta = equipo.ligaEspn || 'all';

  try {
    let candidatos = [];

    if (equipo.idEspn) {
      const urlTeam = `https://site.api.espn.com/apis/site/v2/sports/soccer/${ligaRuta}/teams/${equipo.idEspn}`;
      const resTeam = await axios.get(urlTeam, { timeout: 8000 });
      candidatos = resTeam.data?.team?.nextEvent || [];
    }

    const eventoValido = candidatos.find(ev => {
      const ts = new Date(ev.date).getTime();
      return (ts + (2 * 60 * 60 * 1000)) > ahora;
    });

    if (!eventoValido && equipo.idEspn) {
      const urlSched = `https://site.api.espn.com/apis/site/v2/sports/soccer/${ligaRuta}/teams/${equipo.idEspn}/schedule?fixture=true`;
      const resSched = await axios.get(urlSched, { timeout: 8000 });
      candidatos = resSched.data?.events || [];
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
    const esHomeFav = obtenerFavoritoSiCoincide(homeComp.team?.displayName || homeComp.team?.name)?.nombre === equipo.nombre;
    const esAwayFav = obtenerFavoritoSiCoincide(awayComp.team?.displayName || awayComp.team?.name)?.nombre === equipo.nombre;

    // Si es C.D. Águila, priorizamos su escudo oficial para evitar escudos genéricos o erróneos
    const logoLocal = (esHomeFav && equipo.ligaEspn === 'slv.1')
      ? equipo.logoRespaldo
      : (homeComp.team?.logos?.[0]?.href || (esHomeFav ? equipo.logoRespaldo : null));

    const logoVisitante = (esAwayFav && equipo.ligaEspn === 'slv.1')
      ? equipo.logoRespaldo
      : (awayComp.team?.logos?.[0]?.href || (esAwayFav ? equipo.logoRespaldo : null));

    return {
      id: proximo.id,
      equipoTrackedId: mainFavId,
      timestampInicio: timestampInicio,
      local: homeComp.team?.displayName || homeComp.team?.name || 'Local',
      logoLocal: logoLocal,
      visitante: awayComp.team?.displayName || awayComp.team?.name || 'Visitante',
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

// 📅 CALENDARIO DUAL: Primero ESPN -> Respaldo TheSportsDB con ID directo
async function cargarProximosPartidosProgresivamente() {
  if (cargandoProximos) return;
  cargandoProximos = true;
  console.log('⏳ Sincronizando calendario de próximos partidos (ESPN + TheSportsDB)...');

  let listaTemporal = [];
  const ahora = Date.now();

  for (const equipo of EQUIPOS_FAVORITOS) {
    const mainFavId = Array.isArray(equipo.idFootball) ? equipo.idFootball[0] : equipo.idFootball;

    try {
      // 1️⃣ Intentamos primero con ESPN (No tiene bloqueo de rate-limit y siempre está al día)
      const partidoEspn = await obtenerProximoPartidoESPN(equipo);
      if (partidoEspn) {
        listaTemporal.push(partidoEspn);
        cacheProximosPartidos = [...listaTemporal];
        emitirDatosAlFrontend();
        await esperar(400);
        continue;
      }

      // 2️⃣ Respaldo con TheSportsDB usando idSportsDB directo (Ahorra la mitad de peticiones)
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
            logoLocal: esLocal ? equipo.logoRespaldo : (fixtureFutu.strHomeTeamBadge || null),
            visitante: fixtureFutu.strAwayTeam,
            logoVisitante: !esLocal ? equipo.logoRespaldo : (fixtureFutu.strAwayTeamBadge || null),
            golesLocal: 0,
            golesVisitante: 0,
            minuto: formatearFechaElSalvador(timestampInicio),
            estado: 'PROXIMO',
            esEnVivo: false,
            anotadores: []
          });
          cacheProximosPartidos = [...listaTemporal];
          emitirDatosAlFrontend();
          await esperar(800);
          continue;
        }
      }

      throw new Error('Sin fecha próxima confirmada');
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
    await esperar(500);
  }

  cargandoProximos = false;
  buscarPartidosEnVivo();
}

// ⚡ FUNCIÓN AUXILIAR: Extraer partido desde un evento de ESPN
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

  return {
    id: partidoCalendario?.id || ev.id || `live-${mainFavId}`,
    equipoIdFiltro1: mainFavId,
    equipoIdFiltro2: mainFavId,
    local: hName,
    logoLocal: homeComp.team?.logos?.[0]?.href || partidoCalendario?.logoLocal || equipoFav.logoRespaldo,
    visitante: aName,
    logoVisitante: awayComp.team?.logos?.[0]?.href || partidoCalendario?.logoVisitante || null,
    golesLocal: parseInt(homeComp.score, 10) || 0,
    golesVisitante: parseInt(awayComp.score, 10) || 0,
    minuto: minTexto,
    estado: comp.status?.type?.name === 'STATUS_HALFTIME' || String(minTexto).toUpperCase().includes('HT') ? 'HT' : 'LIVE',
    esEnVivo: true,
    anotadores,
    tarjetas
  };
}

// 🐝 FUNCIÓN NÚCLEO: Primero Gratis (ESPN) -> Respaldo Quirúrgico (ScrapingBee con Freno de 12 min)
async function rasparPartidoGoogle(queryBusqueda, equipoFav, modoDebug = false, partidoCalendario = null) {
  const nombreLocalCal = partidoCalendario?.local || equipoFav.nombre;
  const nombreVisitCal = (partidoCalendario?.visitante && partidoCalendario.visitante !== 'Rival por definir')
    ? partidoCalendario.visitante
    : 'Rival';
  const mainFavId = Array.isArray(equipoFav.idFootball) ? equipoFav.idFootball[0] : equipoFav.idFootball;

  // 1️⃣ PRIORIDAD 1: Consultamos primero el scoreboard gratuito de ESPN
  try {
    const res = await axios.get('https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard', { timeout: 10000 });
    const eventos = res.data?.events || [];

    for (const ev of eventos) {
      const comp = ev.competitions?.[0];
      const homeComp = comp?.competitors?.find(c => c.homeAway === 'home');
      const awayComp = comp?.competitors?.find(c => c.homeAway === 'away');
      if (!homeComp || !awayComp) continue;

      const hName = homeComp.team?.displayName || homeComp.team?.name || '';
      const aName = awayComp.team?.displayName || awayComp.team?.name || '';

      const coincidePorId = String(homeComp.team?.id) === String(equipoFav.idEspn) || String(awayComp.team?.id) === String(equipoFav.idEspn);
      const coincideFav = obtenerFavoritoSiCoincide(hName) || obtenerFavoritoSiCoincide(aName);

      if (coincidePorId || coincideFav?.strSearch === equipoFav.strSearch) {
        const estadoEv = comp.status?.type?.state;
        if (estadoEv === 'in' || modoDebug) {
          return formatearEventoVivoESPN(ev, equipoFav, partidoCalendario);
        }
      }
    }
  } catch (e) {
    console.warn('⚠️ Aviso al consultar ESPN en rasparPartidoGoogle:', e.message);
  }

  // 2️⃣ PRIORIDAD 2: ScrapingBee con freno de 12 minutos
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
      console.log(`🐝 Activando ScrapingBee para: "${queryBusqueda}"...`);
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

  const nombreLocalFinal = partidoCalendario?.local || datosDOM.localDOM || equipoFav.nombre;
  const nombreVisitanteFinal = nombreVisitCal !== 'Rival' ? nombreVisitCal : (datosDOM.visitanteDOM || 'Rival');

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
  if (!minutoGoogle && !enHorarioRealDeJuego && !modoDebug) return null;

  const minutoFinal = minutoGoogle || calcularMinutoPorReloj(partidoCalendario?.timestampInicio);

  return {
    id: partidoCalendario?.id || `sb-${mainFavId}`,
    equipoIdFiltro1: mainFavId,
    equipoIdFiltro2: mainFavId,
    local: nombreLocalFinal,
    logoLocal: partidoCalendario?.logoLocal || equipoFav.logoRespaldo,
    visitante: nombreVisitanteFinal,
    logoVisitante: partidoCalendario?.logoVisitante || null,
    golesLocal: !isNaN(golesLocal) && golesLocal !== null ? golesLocal : 0,
    golesVisitante: !isNaN(golesVisitante) && golesVisitante !== null ? golesVisitante : 0,
    minuto: minutoFinal,
    estado: String(minutoFinal).toLowerCase().includes('medio') || String(minutoFinal).toUpperCase() === 'HT' ? 'HT' : 'LIVE',
    esEnVivo: true,
    anotadores: [],
    tarjetas: []
  };
}

// 🕒 MONITOR EN VIVO DESACOPLADO (Revisa ESPN directo cada 1 min + Smart Trigger para ScrapingBee)
async function buscarPartidosEnVivo() {
  try {
    let nuevosEnVivo = [];
    const idsDetectadosEnESPN = new Set();

    // 1️⃣ Escaneo en vivo gratuito: Marcador Global ('all') + Liga Mayor de El Salvador ('slv.1')
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
            EQUIPOS_FAVORITOS.find(f => String(f.idEspn) === String(homeComp.team?.id) || String(f.idEspn) === String(awayComp.team?.id));

          if (equipoFav) {
            const mainFavId = Array.isArray(equipoFav.idFootball) ? equipoFav.idFootball[0] : equipoFav.idFootball;
            if (idsDetectadosEnESPN.has(mainFavId)) continue;

            const partidoCal = cacheProximosPartidos.find(p => p.equipoTrackedId === mainFavId) || null;
            const partidoVivo = formatearEventoVivoESPN(ev, equipoFav, partidoCal);

            if (partidoVivo) {
              // Aseguramos el escudo correcto si juega C.D. Águila
              if (equipoFav.ligaEspn === 'slv.1') {
                if (obtenerFavoritoSiCoincide(partidoVivo.local)?.nombre === equipoFav.nombre) {
                  partidoVivo.logoLocal = equipoFav.logoRespaldo;
                } else {
                  partidoVivo.logoVisitante = equipoFav.logoRespaldo;
                }
              }
              nuevosEnVivo.push(partidoVivo);
              idsDetectadosEnESPN.add(mainFavId);
            }
          }
        }
      } catch (errEspn) {
        console.warn(`⚠️ Aviso en escaneo de ${url}:`, errEspn.message);
      }
    }

    // 2️⃣ Smart Trigger para ScrapingBee (Usa 'c d aguila' si el equipo tiene queryGoogle personalizado)
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

// 🚀 ARRANQUE INMEDIATO EN PARALELO
buscarPartidosEnVivo();
cargarProximosPartidosProgresivamente();

setInterval(buscarPartidosEnVivo, INTERVALO_CONSULTA);
setInterval(cargarProximosPartidosProgresivamente, 30 * 60 * 1000);

io.on('connection', (socket) => {
  emitirDatosAlFrontend(socket);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Servidor LiveScoresBC corriendo en puerto ${PORT}`));