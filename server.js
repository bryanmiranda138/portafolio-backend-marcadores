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

app.get('/', (req, res) => res.send('⚽ Servidor LiveScoresBC (Arquitectura Híbrida Optimizada) funcionando.'));
app.get('/debug', (req, res) => res.json({ proximos: cacheProximosPartidos, enVivo: partidosEnVivoCache }));

// 🚀 Endpoint de Rayos X: Prueba el flujo ahorrador e inyecta el partido en tu panel
app.get('/debug-live', async (req, res) => {
  try {
    const equipoPrueba = req.query.equipo || 'Barcelona';
    const favObj = obtenerFavoritoSiCoincide(equipoPrueba) || EQUIPOS_FAVORITOS[0];
    const mainFavId = Array.isArray(favObj.idFootball) ? favObj.idFootball[0] : favObj.idFootball;

    const partidoCalendario = cacheProximosPartidos.find(p => p.equipoTrackedId === mainFavId) || null;
    const queryBusqueda = partidoCalendario && partidoCalendario.visitante !== 'Rival por definir'
      ? `${partidoCalendario.local} vs ${partidoCalendario.visitante}`
      : `${favObj.nombre}`;

    console.log(`🧪 Ejecutando prueba optimizada para: "${queryBusqueda}"`);
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
    res.status(500).json({
      error: error.message,
      detalles: error.response?.data || "Error en la ejecución de prueba"
    });
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
  {
    nombre: 'Inter Miami',
    idFootball: [9723, 8984],
    strSearch: 'Inter Miami',
    logoRespaldo: 'https://media.api-sports.io/football/teams/9723.png'
  },
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

// ⏱️ Actualización en tiempo real cada 1 minuto (Gratis para Smart Trigger y ESPN)
const INTERVALO_CONSULTA = 1 * 60 * 1000;

// 🛡️ Freno exclusivo para ScrapingBee: guarda la última consulta para no llamarlo cada minuto
const memoriaScrapingBee = new Map();
const COOLDOWN_SCRAPINGBEE = 12 * 60 * 1000; // ScrapingBee solo se activa máximo cada 12 minutos

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

// ⚡ PRIORIDAD 1: Feed Público en Vivo de ESPN (0 Créditos, Alta Precisión)
async function consultarRespaldoEnVivoESPN(equipoFav, nombreLocalCal, nombreVisitCal) {
  try {
    const res = await axios.get('https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard', { timeout: 10000 });
    const eventos = res.data?.events || [];

    for (const ev of eventos) {
      const comp = ev.competitions?.[0];
      if (!comp) continue;

      const homeComp = comp.competitors?.find(c => c.homeAway === 'home');
      const awayComp = comp.competitors?.find(c => c.homeAway === 'away');
      if (!homeComp || !awayComp) continue;

      const hName = homeComp.team?.displayName || homeComp.team?.name || '';
      const aName = awayComp.team?.displayName || awayComp.team?.name || '';

      const coincideFav = obtenerFavoritoSiCoincide(hName) || obtenerFavoritoSiCoincide(aName);
      const coincideCal = (nombreLocalCal && hName.toLowerCase().includes(nombreLocalCal.toLowerCase().split(' ')[0])) ||
        (nombreVisitCal && aName.toLowerCase().includes(nombreVisitCal.toLowerCase().split(' ')[0]));

      if (coincideFav?.strSearch === equipoFav.strSearch || coincideCal) {
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

        return {
          local: hName,
          visitante: aName,
          golesLocal: parseInt(homeComp.score, 10) || 0,
          golesVisitante: parseInt(awayComp.score, 10) || 0,
          minuto: comp.status?.type?.shortDetail || comp.status?.displayClock || null,
          estado: comp.status?.type?.state === 'in' ? 'LIVE' : (comp.status?.type?.name === 'STATUS_HALFTIME' ? 'HT' : 'LIVE'),
          anotadores,
          tarjetas
        };
      }
    }
  } catch (e) {
    console.warn('⚠️ Aviso en feed primario ESPN:', e.message);
  }
  return null;
}

// 📅 CALENDARIO: TheSportsDB (Próximos Partidos + Reloj Disparador)
async function cargarProximosPartidosProgresivamente() {
  if (cargandoProximos) return;
  cargandoProximos = true;
  console.log('⏳ Sincronizando calendario de próximos partidos con TheSportsDB...');

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
              const strTs = ev.strTimestamp.includes('+') || ev.strTimestamp.endsWith('Z') ? ev.strTimestamp : `${ev.strTimestamp}Z`;
              fechaPartido = new Date(strTs).getTime();
            } else if (ev.dateEvent) {
              fechaPartido = new Date(`${ev.dateEvent}T${ev.strTime || '00:00:00'}Z`).getTime();
            }
            if (!fechaPartido || isNaN(fechaPartido)) return true;
            return (fechaPartido + (2 * 60 * 60 * 1000)) > ahora;
          });

          if (eventosRealmenteFuturos.length > 0) {
            eventosRealmenteFuturos.sort((a, b) => {
              const timeA = a.strTimestamp ? new Date(a.strTimestamp).getTime() : new Date(`${a.dateEvent}T${a.strTime || '00:00:00'}Z`).getTime();
              const timeB = b.strTimestamp ? new Date(b.strTimestamp).getTime() : new Date(`${b.dateEvent}T${b.strTime || '00:00:00'}Z`).getTime();
              return timeA - timeB;
            });

            const fixtureFutu = eventosRealmenteFuturos[0];

            let timestampInicio = null;
            if (fixtureFutu.strTimestamp) {
              const strTs = fixtureFutu.strTimestamp.includes('+') || fixtureFutu.strTimestamp.endsWith('Z') ? fixtureFutu.strTimestamp : `${fixtureFutu.strTimestamp}Z`;
              timestampInicio = new Date(strTs).getTime();
            } else if (fixtureFutu.dateEvent && fixtureFutu.strTime) {
              timestampInicio = new Date(`${fixtureFutu.dateEvent}T${fixtureFutu.strTime}Z`).getTime();
            }

            let fechaFormateada = 'Fecha por confirmar';
            if (timestampInicio) {
              const fechaElSalvador = new Date(timestampInicio - (6 * 60 * 60 * 1000));
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
              timestampInicio: timestampInicio,
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
        id: `tbd-${mainFavId}`, equipoTrackedId: mainFavId, timestampInicio: null,
        local: equipo.nombre, logoLocal: urlEscudoRespaldo,
        visitante: 'Rival por definir', logoVisitante: null, golesLocal: 0, golesVisitante: 0,
        minuto: 'Fecha por confirmar', estado: 'PROXIMO', esEnVivo: false, anotadores: []
      });
    }

    cacheProximosPartidos = [...listaTemporal];
    emitirDatosAlFrontend();
    await esperar(1200);
  }
  cargandoProximos = false;
  buscarPartidosEnVivo();
}

// 🐝 FUNCIÓN NÚCLEO OPTIMIZADA: Primero Gratis (ESPN) -> Respaldo Quirúrgico (ScrapingBee)
async function rasparPartidoGoogle(queryBusqueda, equipoFav, modoDebug = false, partidoCalendario = null) {
  const nombreLocalCal = partidoCalendario?.local || equipoFav.nombre;
  const nombreVisitCal = (partidoCalendario?.visitante && partidoCalendario.visitante !== 'Rival por definir')
    ? partidoCalendario.visitante
    : 'Rival';
  const mainFavId = Array.isArray(equipoFav.idFootball) ? equipoFav.idFootball[0] : equipoFav.idFootball;

  // 1️⃣ PRIORIDAD 1: Consultamos primero el verificador gratuito (Gasta 0 créditos de ScrapingBee)
  const datosRespaldoESPN = await consultarRespaldoEnVivoESPN(equipoFav, nombreLocalCal, nombreVisitCal);

  if (datosRespaldoESPN) {
    console.log(`⚡ Partido obtenido gratis vía feed directo (${datosRespaldoESPN.local} vs ${datosRespaldoESPN.visitante}). 0 créditos de ScrapingBee usados.`);
    return {
      id: partidoCalendario?.id || `live-${mainFavId}`,
      equipoIdFiltro1: mainFavId,
      equipoIdFiltro2: mainFavId,
      local: nombreLocalCal,
      logoLocal: partidoCalendario?.logoLocal || equipoFav.logoRespaldo || `https://media.api-sports.io/football/teams/${mainFavId}.png`,
      visitante: nombreVisitCal !== 'Rival' ? nombreVisitCal : datosRespaldoESPN.visitante,
      logoVisitante: partidoCalendario?.logoVisitante || null,
      golesLocal: datosRespaldoESPN.golesLocal,
      golesVisitante: datosRespaldoESPN.golesVisitante,
      minuto: datosRespaldoESPN.minuto || calcularMinutoPorReloj(partidoCalendario?.timestampInicio),
      estado: String(datosRespaldoESPN.minuto).toUpperCase().includes('HT') ? 'HT' : 'LIVE',
      esEnVivo: true,
      anotadores: datosRespaldoESPN.anotadores || [],
      tarjetas: datosRespaldoESPN.tarjetas || []
    };
  }

  // 2️⃣ PRIORIDAD 2: Solo si no está en el feed gratuito, usamos ScrapingBee (Con freno de 12 min)
  const token = process.env.SCRAPINGBEE_API_KEY;
  let datosDOM = {};
  const registroPrevio = memoriaScrapingBee.get(mainFavId);
  const ahora = Date.now();

  if (registroPrevio && (ahora - registroPrevio.timestamp) < COOLDOWN_SCRAPINGBEE && !modoDebug) {
    // Reutilizamos los goles de hace unos minutos para gastar 0 créditos, mientras el minuto avanza por reloj
    datosDOM = registroPrevio.datos;
    console.log(`🛡️ Usando caché de ScrapingBee para ${equipoFav.nombre} (0 créditos gastados en este minuto).`);
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
      console.log(`🐝 Activando ScrapingBee (máx 1 vez cada 12 min) para: "${queryBusqueda}"...`);
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
      // Guardamos el resultado por 12 minutos
      memoriaScrapingBee.set(mainFavId, { timestamp: ahora, datos: datosDOM });
    } catch (errGoogle) {
      console.warn(`⚠️ ScrapingBee sin créditos o bloqueado (${errGoogle.message}). Usando reloj de respaldo.`);
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

  const anotadoresData = Array.isArray(datosDOM.goleadoresDOM)
    ? datosDOM.goleadoresDOM.map(texto => {
      const minMatch = String(texto).match(/(\d+)/);
      return {
        equipo: nombreLocalFinal,
        jugador: String(texto).replace(/\d+'?/g, '').trim(),
        minuto: minMatch ? Number(minMatch[1]) : 0,
        tipo: 'Gol'
      };
    })
    : [];

  return {
    id: partidoCalendario?.id || `sb-${mainFavId}`,
    equipoIdFiltro1: mainFavId,
    equipoIdFiltro2: mainFavId,
    local: nombreLocalFinal,
    logoLocal: partidoCalendario?.logoLocal || equipoFav.logoRespaldo || `https://media.api-sports.io/football/teams/${mainFavId}.png`,
    visitante: nombreVisitanteFinal,
    logoVisitante: partidoCalendario?.logoVisitante || null,
    golesLocal: !isNaN(golesLocal) && golesLocal !== null ? golesLocal : 0,
    golesVisitante: !isNaN(golesVisitante) && golesVisitante !== null ? golesVisitante : 0,
    minuto: minutoFinal,
    estado: String(minutoFinal).toLowerCase().includes('medio') || String(minutoFinal).toUpperCase() === 'HT' ? 'HT' : 'LIVE',
    esEnVivo: true,
    anotadores: anotadoresData,
    tarjetas: []
  };
}

// 🕒 MONITOR DE PARTIDOS EN VIVO CON SMART TRIGGER
async function buscarPartidosEnVivo() {
  try {
    const ahora = Date.now();
    const margenAntes = 5 * 60 * 1000;
    const duracionMaxima = 115 * 60 * 1000;

    const partidosEnHorarioDeJuego = cacheProximosPartidos.filter(p => {
      if (!p.timestampInicio) return false;
      return ahora >= (p.timestampInicio - margenAntes) && ahora <= (p.timestampInicio + duracionMaxima);
    });

    if (partidosEnHorarioDeJuego.length === 0) {
      console.log('🛡️ Smart Trigger: Ningún equipo favorito está en horario de partido ahora. 0 peticiones externas realizadas.');
      partidosEnVivoCache = [];
      emitirDatosAlFrontend();
      return;
    }

    console.log(`⚽ ¡Horario de partido detectado! Verificando ${partidosEnHorarioDeJuego.length} partido(s)...`);
    let nuevosEnVivo = [];

    for (const partidoProg of partidosEnHorarioDeJuego) {
      try {
        const equipoFav = EQUIPOS_FAVORITOS.find(f => {
          const id = Array.isArray(f.idFootball) ? f.idFootball[0] : f.idFootball;
          return id === partidoProg.equipoTrackedId;
        });

        if (equipoFav) {
          const query = `${partidoProg.local} vs ${partidoProg.visitante}`;
          const datosVivo = await rasparPartidoGoogle(query, equipoFav, false, partidoProg);
          if (datosVivo) {
            nuevosEnVivo.push(datosVivo);
          }
        }
      } catch (errPartido) {
        console.error(`⚠️ Error al verificar ${partidoProg.local} vs ${partidoProg.visitante}:`, errPartido.message);
      }
    }

    partidosEnVivoCache = nuevosEnVivo;
    emitirDatosAlFrontend();
  } catch (error) {
    console.error('❌ Error general en monitor en vivo:', error.message);
  }
}

// 🚀 ARRANQUE
cargarProximosPartidosProgresivamente();

setInterval(buscarPartidosEnVivo, INTERVALO_CONSULTA);
setInterval(cargarProximosPartidosProgresivamente, 30 * 60 * 1000);

io.on('connection', (socket) => {
  emitirDatosAlFrontend(socket);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Servidor Híbrido Optimizado corriendo en puerto ${PORT}`));