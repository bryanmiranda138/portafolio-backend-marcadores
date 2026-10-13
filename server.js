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

app.get('/', (req, res) => res.send('⚽ Servidor de Marcadores en vivo (TheSportsDB + ScrapingBee Google DOM) funcionando.'));
app.get('/debug', (req, res) => res.json({ proximos: cacheProximosPartidos, enVivo: partidosEnVivoCache }));

// 🚀 Endpoint de Rayos X: Prueba la extracción de 3 capas y actualiza tu panel en Vercel
app.get('/debug-live', async (req, res) => {
  try {
    const token = process.env.SCRAPINGBEE_API_KEY;
    if (!token) {
      return res.status(401).json({ error: "Falta configurar SCRAPINGBEE_API_KEY en Render o en tu .env" });
    }

    const equipoPrueba = req.query.equipo || 'Barcelona';
    const favObj = obtenerFavoritoSiCoincide(equipoPrueba) || EQUIPOS_FAVORITOS[0];
    const mainFavId = Array.isArray(favObj.idFootball) ? favObj.idFootball[0] : favObj.idFootball;

    const partidoCalendario = cacheProximosPartidos.find(p => p.equipoTrackedId === mainFavId) || null;
    
    // Búsqueda limpia sin palabras extra para forzar el widget deportivo de Google
    const queryBusqueda = partidoCalendario && partidoCalendario.visitante !== 'Rival por definir'
      ? `${partidoCalendario.local} vs ${partidoCalendario.visitante}`
      : `${favObj.nombre}`;

    console.log(`🧪 Ejecutando prueba en Google vía ScrapingBee para: "${queryBusqueda}"`);
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
      detalles: error.response?.data || "Verifica tu SCRAPINGBEE_API_KEY" 
    });
  }
});

// 📌 TUS EQUIPOS FAVORITOS
const EQUIPOS_FAVORITOS = [
  { nombre: 'FC Barcelona',   idFootball: 529,  strSearch: 'Barcelona' },
  { nombre: 'Real Madrid',    idFootball: 541,  strSearch: 'Real Madrid' },
  { nombre: 'Boca Juniors',   idFootball: 451,  strSearch: 'Boca Juniors' },
  { nombre: 'River Plate',    idFootball: 435,  strSearch: 'River Plate' },
  { nombre: 'Liverpool',      idFootball: 40,   strSearch: 'Liverpool' },
  { nombre: 'Manchester City',idFootball: 50,   strSearch: 'Manchester City' },
  { nombre: 'C.D. Águila',    idFootball: 2307, strSearch: 'Aguila' },
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

const EXCLUSIONES = [
  'new england', 'barcelona sc', 'barcelona de guayaquil',
  'liverpool montevideo', 'river plate montevideo', 'real madrid b', 'barcelona b'
];

const INTERVALO_CONSULTA = 3 * 60 * 1000;

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

// 🔍 CAPA 2: Escáner Regex para leer el marcador desde los titulares de Google si el widget se oculta
function extraerMarcadorDeTitularesGoogle(textos, nombreLocal, nombreVisitante) {
  if (!Array.isArray(textos) || textos.length === 0) return null;

  const limpiar = (str) => (str || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  const localKey = limpiar(nombreLocal).split(' ')[0];
  const visitKey = limpiar(nombreVisitante).split(' ')[0];

  for (const rawTexto of textos) {
    const t = limpiar(rawTexto);
    if (!localKey || !visitKey || visitKey === 'rival') continue;

    // Patrón 1: Local X - Y Visitante
    const regexOrdenNormal = new RegExp(`${localKey}[^0-9\\n]{0,25}?(\\d{1,2})\\s*[-–—]\\s*(\\d{1,2})[^0-9\\n]{0,25}?${visitKey}`, 'i');
    const matchNormal = t.match(regexOrdenNormal);
    if (matchNormal) {
      return { golesLocal: parseInt(matchNormal[1], 10), golesVisitante: parseInt(matchNormal[2], 10) };
    }

    // Patrón 2: Visitante Y - X Local
    const regexOrdenInverso = new RegExp(`${visitKey}[^0-9\\n]{0,25}?(\\d{1,2})\\s*[-–—]\\s*(\\d{1,2})[^0-9\\n]{0,25}?${localKey}`, 'i');
    const matchInverso = t.match(regexOrdenInverso);
    if (matchInverso) {
      return { golesLocal: parseInt(matchInverso[2], 10), golesVisitante: parseInt(matchInverso[1], 10) };
    }
  }
  return null;
}

// 🛡️ CAPA 3: Verificador en tiempo real con el feed público de ESPN (Respaldo exacto sin gastar créditos)
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
    console.warn('⚠️ Aviso en verificador secundario:', e.message);
  }
  return null;
}

// 1️⃣ API #1: TheSportsDB (Calendario de Próximos Partidos)
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
              const timeA = a.strTimestamp ? new Date(a.strTimestamp).getTime() : new Date(`${a.dateEvent}T${a.strTime||'00:00:00'}Z`).getTime();
              const timeB = b.strTimestamp ? new Date(b.strTimestamp).getTime() : new Date(`${b.dateEvent}T${b.strTime||'00:00:00'}Z`).getTime();
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

// 🐝 FUNCIÓN NÚCLEO EN 3 CAPAS: Selectores DOM de Google + Regex de Titulares + Verificador ESPN
async function rasparPartidoGoogle(queryBusqueda, equipoFav, modoDebug = false, partidoCalendario = null) {
  const token = process.env.SCRAPINGBEE_API_KEY;
  if (!token) return null;

  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(queryBusqueda)}&hl=es`;

  // CAPA 1: Selectores CSS oficiales de Google Sports OneBox (extract_rules no cobra el extra de IA)
  const reglasDOM = JSON.stringify({
    localDOM: ".imso_mh__first-tn-ed .imso_mh__tm-nm, .imso_mh__first-tn-ed span",
    visitanteDOM: ".imso_mh__second-tn-ed .imso_mh__tm-nm, .imso_mh__second-tn-ed span",
    golesLocalDOM: ".imso_mh__l-tm-sc",
    golesVisitanteDOM: ".imso_mh__r-tm-sc",
    minutoDOM: ".imso_mh__lv-m-stts-cont, .imso-ani",
    estadoFinalDOM: ".imso_mh__ft-mtch",
    goleadoresDOM: {
      selector: ".imso_gs__gs-r",
      type: "list"
    },
    titularesGoogle: {
      selector: "h3, .VwiC3b, .BNeawe",
      type: "list"
    }
  });

  let datosDOM = {};

  try {
    console.log(`🐝 Consultando DOM de Google Sports vía ScrapingBee: "${queryBusqueda}"...`);
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
  } catch (errGoogle) {
    console.warn(`⚠️ Aviso en petición a Google (${errGoogle.message}). Activando capas de respaldo...`);
  }

  const nombreLocalFinal = partidoCalendario?.local || datosDOM.localDOM || equipoFav.nombre;
  const nombreVisitanteFinal = (partidoCalendario?.visitante && partidoCalendario.visitante !== 'Rival por definir')
    ? partidoCalendario.visitante
    : (datosDOM.visitanteDOM || 'Rival');

  // 1️⃣ Intentamos leer los goles directamente del Widget de Google (Capa 1)
  let golesLocal = datosDOM.golesLocalDOM !== null && datosDOM.golesLocalDOM !== undefined && datosDOM.golesLocalDOM !== ''
    ? parseInt(datosDOM.golesLocalDOM, 10)
    : null;
  let golesVisitante = datosDOM.golesVisitanteDOM !== null && datosDOM.golesVisitanteDOM !== undefined && datosDOM.golesVisitanteDOM !== ''
    ? parseInt(datosDOM.golesVisitanteDOM, 10)
    : null;

  // 2️⃣ Si el Widget de Google vino vacío, escaneamos los titulares de la búsqueda de Google (Capa 2)
  if (golesLocal === null || isNaN(golesLocal) || golesVisitante === null || isNaN(golesVisitante)) {
    const marcadorTitulares = extraerMarcadorDeTitularesGoogle(datosDOM.titularesGoogle, nombreLocalFinal, nombreVisitanteFinal);
    if (marcadorTitulares) {
      console.log(`🎯 Marcador extraído de los titulares de Google: ${marcadorTitulares.golesLocal} - ${marcadorTitulares.golesVisitante}`);
      golesLocal = marcadorTitulares.golesLocal;
      golesVisitante = marcadorTitulares.golesVisitante;
    }
  }

  // 3️⃣ Consultamos el verificador secundario en vivo (Capa 3) para asegurar goles exactos, goleadores y tarjetas
  const datosRespaldoESPN = await consultarRespaldoEnVivoESPN(equipoFav, nombreLocalFinal, nombreVisitanteFinal);
  if (datosRespaldoESPN) {
    if (golesLocal === null || isNaN(golesLocal) || (golesLocal === 0 && golesVisitante === 0)) {
      golesLocal = datosRespaldoESPN.golesLocal;
      golesVisitante = datosRespaldoESPN.golesVisitante;
    }
  }

  const ahora = Date.now();
  const enHorarioRealDeJuego = partidoCalendario?.timestampInicio && 
                               ahora >= partidoCalendario.timestampInicio && 
                               ahora <= (partidoCalendario.timestampInicio + (115 * 60 * 1000));

  const minutoGoogle = datosDOM.minutoDOM || datosDOM.estadoFinalDOM || '';
  const hayDatosEnVivo = Boolean(minutoGoogle) || Boolean(datosRespaldoESPN) || enHorarioRealDeJuego;

  if (!hayDatosEnVivo && !modoDebug) {
    return null;
  }

  let minutoFinal = 'En Vivo';
  if (minutoGoogle) {
    minutoFinal = minutoGoogle;
  } else if (datosRespaldoESPN?.minuto) {
    minutoFinal = datosRespaldoESPN.minuto;
  } else if (enHorarioRealDeJuego) {
    minutoFinal = calcularMinutoPorReloj(partidoCalendario.timestampInicio);
  }

  // Formateo de goleadores (de Google DOM o del respaldo en vivo)
  let anotadoresData = [];
  if (Array.isArray(datosDOM.goleadoresDOM) && datosDOM.goleadoresDOM.length > 0) {
    anotadoresData = datosDOM.goleadoresDOM.map(texto => {
      const minMatch = String(texto).match(/(\d+)/);
      return {
        equipo: nombreLocalFinal,
        jugador: String(texto).replace(/\d+'?/g, '').trim(),
        minuto: minMatch ? Number(minMatch[1]) : 0,
        tipo: 'Gol'
      };
    });
  } else if (datosRespaldoESPN?.anotadores?.length > 0) {
    anotadoresData = datosRespaldoESPN.anotadores;
  }

  const tarjetasData = datosRespaldoESPN?.tarjetas || [];
  const mainFavId = Array.isArray(equipoFav.idFootball) ? equipoFav.idFootball[0] : equipoFav.idFootball;

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
    tarjetas: tarjetasData
  };
}

// 2️⃣ API #2: ScrapingBee con "Smart Trigger"
async function buscarPartidosEnVivo() {
  try {
    const token = process.env.SCRAPINGBEE_API_KEY;
    if (!token) {
      console.error('🛑 ERROR: No se ha configurado la variable SCRAPINGBEE_API_KEY');
      return;
    }

    const ahora = Date.now();
    const margenAntes = 5 * 60 * 1000;
    const duracionMaxima = 115 * 60 * 1000;

    const partidosEnHorarioDeJuego = cacheProximosPartidos.filter(p => {
      if (!p.timestampInicio) return false;
      return ahora >= (p.timestampInicio - margenAntes) && ahora <= (p.timestampInicio + duracionMaxima);
    });

    if (partidosEnHorarioDeJuego.length === 0) {
      console.log('🛡️ Smart Trigger: Ningún equipo favorito está en horario de partido ahora. 0 créditos gastados.');
      partidosEnVivoCache = [];
      emitirDatosAlFrontend();
      return;
    }

    console.log(`🐝 ¡Horario de partido detectado! Consultando ${partidosEnHorarioDeJuego.length} partido(s)...`);
    let nuevosEnVivo = [];

    for (const partidoProg of partidosEnHorarioDeJuego) {
      try {
        const equipoFav = EQUIPOS_FAVORITOS.find(f => {
          const id = Array.isArray(f.idFootball) ? f.idFootball[0] : f.idFootball;
          return id === partidoProg.equipoTrackedId;
        });

        if (equipoFav) {
          // Búsqueda directa "Local vs Visitante" para activar el marcador oficial de Google
          const query = `${partidoProg.local} vs ${partidoProg.visitante}`;
          const datosVivo = await rasparPartidoGoogle(query, equipoFav, false, partidoProg);
          if (datosVivo) {
            nuevosEnVivo.push(datosVivo);
          }
        }
      } catch (errPartido) {
        console.error(`⚠️ Error al raspar ${partidoProg.local} vs ${partidoProg.visitante}:`, errPartido.message);
      }
    }

    partidosEnVivoCache = nuevosEnVivo;
    emitirDatosAlFrontend();
  } catch (error) {
    console.error('❌ Error general en ScrapingBee:', error.message);
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
server.listen(PORT, () => console.log(`🚀 Servidor Híbrido 3 Capas corriendo en puerto ${PORT}`));