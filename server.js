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

app.get('/', (req, res) => res.send('⚽ Servidor de Marcadores en vivo (TheSportsDB + ScrapingBee Google Sports) funcionando.'));
app.get('/debug', (req, res) => res.json({ proximos: cacheProximosPartidos, enVivo: partidosEnVivoCache }));

// 🚀 Endpoint de Rayos X + Inyección de Prueba en Vivo para tu Portafolio
app.get('/debug-live', async (req, res) => {
  try {
    const token = process.env.SCRAPINGBEE_API_KEY;
    if (!token) {
      return res.status(401).json({ error: "Falta configurar SCRAPINGBEE_API_KEY en Render o en tu .env" });
    }

    const equipoPrueba = req.query.equipo || 'Barcelona';
    const favObj = obtenerFavoritoSiCoincide(equipoPrueba) || EQUIPOS_FAVORITOS[0];
    const mainFavId = Array.isArray(favObj.idFootball) ? favObj.idFootball[0] : favObj.idFootball;

    // Buscamos si ya tenemos el partido en el calendario para usar los nombres y escudos reales
    const partidoCalendario = cacheProximosPartidos.find(p => p.equipoTrackedId === mainFavId) || null;
    const queryBusqueda = partidoCalendario && partidoCalendario.visitante !== 'Rival por definir'
      ? `${partidoCalendario.local} vs ${partidoCalendario.visitante} marcador en vivo`
      : `${favObj.nombre} partido marcador en vivo`;

    console.log(`🧪 Ejecutando prueba en Google vía ScrapingBee para: ${queryBusqueda}`);
    const resultado = await rasparPartidoGoogle(queryBusqueda, favObj, true, partidoCalendario);

    // ✨ Si la prueba tuvo éxito, lo inyectamos en la web principal para que lo veas en "Partidos en Vivo"
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
      detalles: error.response?.data || "Verifica tu SCRAPINGBEE_API_KEY y que tengas créditos disponibles" 
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

// 🧠 Algoritmo Calculador de Minutos (Respaldo si Google no devuelve el minuto exacto)
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

// 1️⃣ API #1: TheSportsDB (Próximos Partidos + Reloj Disparador)
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
    await esperar(1000);
  }
  cargandoProximos = false;
  buscarPartidosEnVivo();
}

// 🐝 FUNCIÓN NÚCLEO BLINDADA: Raspar Google Sports + Respaldo por Horario
async function rasparPartidoGoogle(queryBusqueda, equipoFav, modoDebug = false, partidoCalendario = null) {
  const token = process.env.SCRAPINGBEE_API_KEY;
  if (!token) return null;

  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(queryBusqueda)}&hl=es`;

  const reglasIA = JSON.stringify({
    local: "Nombre del equipo local en el marcador deportivo",
    visitante: "Nombre del equipo visitante en el marcador deportivo",
    golesLocal: { description: "Goles del equipo local (número entero, 0 si empatan a cero o no ha empezado)", type: "number" },
    golesVisitante: { description: "Goles del equipo visitante (número entero, 0 si empatan a cero o no ha empezado)", type: "number" },
    minuto: "Minuto actual del partido (ej. 34', 45+2', Medio Tiempo, Finalizado)",
    estado: "LIVE si está en juego, HT si está en descanso, FT si ya terminó, UPCOMING si no ha empezado",
    goleadores: {
      description: "Lista de goles anotados en formato 'Jugador Minuto (Equipo)'",
      type: "list"
    },
    tarjetasRojas: {
      description: "Lista de jugadores expulsados con tarjeta roja en formato 'Jugador Minuto (Equipo)'",
      type: "list"
    }
  });

  let datosIA = null;

  try {
    console.log(`🐝 [Intento 1 - Premium Proxy] Consultando en Google: "${queryBusqueda}"...`);
    const response = await axios.get('https://app.scrapingbee.com/api/v1/', {
      params: {
        api_key: token,
        url: googleUrl,
        custom_google: 'true',
        render_js: 'true',
        wait: '3000',             // Esperamos 3 segundos para que cargue el widget deportivo de Google
        block_resources: 'false',
        premium_proxy: 'true',
        country_code: 'us',
        ai_extract_rules: reglasIA
      },
      timeout: 50000
    });
    datosIA = response.data;
  } catch (errIntento1) {
    console.warn(`⚠️ Intento 1 bloqueado. Activando Modo Furtivo (Stealth Proxy)...`);
    try {
      const responseStealth = await axios.get('https://app.scrapingbee.com/api/v1/', {
        params: {
          api_key: token,
          url: googleUrl,
          custom_google: 'true',
          render_js: 'true',
          wait: '3000',
          block_resources: 'false',
          stealth_proxy: 'true',
          ai_extract_rules: reglasIA
        },
        timeout: 65000
      });
      datosIA = responseStealth.data;
    } catch (errStealth) {
      console.error(`❌ Error también en Stealth Proxy:`, errStealth.message);
      datosIA = {};
    }
  }

  if (typeof datosIA === 'string') {
    try { datosIA = JSON.parse(datosIA); } catch (e) { datosIA = {}; }
  }

  const estadoUpper = String(datosIA?.estado || '').toUpperCase();
  const minutoStr = String(datosIA?.minuto || '');
  
  const googleDiceEnVivo = estadoUpper.includes('LIVE') || 
                           estadoUpper.includes('HT') || 
                           estadoUpper.includes('VIVO') ||
                           minutoStr.includes("'");

  // Verificamos si según el calendario oficial ya arrancó el partido (entre 0 y 115 min desde el inicio)
  const ahora = Date.now();
  const enHorarioRealDeJuego = partidoCalendario?.timestampInicio && 
                               ahora >= partidoCalendario.timestampInicio && 
                               ahora <= (partidoCalendario.timestampInicio + (115 * 60 * 1000));

  if (!googleDiceEnVivo && !enHorarioRealDeJuego && !modoDebug) {
    return null;
  }

  const mainFavId = Array.isArray(equipoFav.idFootball) ? equipoFav.idFootball[0] : equipoFav.idFootball;

  // Si Google no leyó bien uno de los nombres, usamos los nombres exactos de nuestro calendario
  const nombreLocalFinal = partidoCalendario?.local || datosIA?.local || equipoFav.nombre;
  const nombreVisitanteFinal = (partidoCalendario?.visitante && partidoCalendario.visitante !== 'Rival por definir')
    ? partidoCalendario.visitante
    : (datosIA?.visitante || 'Rival');

  // Si Google nos dio el minuto en vivo lo usamos; si devolvió UPCOMING pero ya es hora del partido, lo calculamos por reloj
  let minutoFinal = 'En Vivo';
  if (googleDiceEnVivo && minutoStr && !minutoStr.toUpperCase().includes('UPCOMING')) {
    minutoFinal = minutoStr;
  } else if (enHorarioRealDeJuego) {
    minutoFinal = calcularMinutoPorReloj(partidoCalendario.timestampInicio);
  } else if (modoDebug) {
    minutoFinal = `45+' (Demo)`;
  }

  const anotadoresData = (datosIA?.goleadores || []).map(item => {
    const texto = String(item);
    const minMatch = texto.match(/(\d+)/);
    return {
      equipo: texto.toLowerCase().includes(nombreVisitanteFinal.toLowerCase()) ? nombreVisitanteFinal : nombreLocalFinal,
      jugador: texto.replace(/\(.*\)/, '').replace(/\d+'?/, '').trim() || texto,
      minuto: minMatch ? Number(minMatch[1]) : 0,
      tipo: texto.toLowerCase().includes('pen') ? 'Penal' : 'Gol'
    };
  });

  const tarjetasData = (datosIA?.tarjetasRojas || []).map(item => {
    const texto = String(item);
    const minMatch = texto.match(/(\d+)/);
    return {
      equipo: texto.toLowerCase().includes(nombreVisitanteFinal.toLowerCase()) ? nombreVisitanteFinal : nombreLocalFinal,
      jugador: texto.replace(/\(.*\)/, '').replace(/\d+'?/, '').trim() || texto,
      minuto: minMatch ? Number(minMatch[1]) : 0,
      tipo: 'Roja'
    };
  });

  return {
    id: partidoCalendario?.id || `sb-${mainFavId}`,
    equipoIdFiltro1: mainFavId,
    equipoIdFiltro2: mainFavId,
    local: nombreLocalFinal,
    logoLocal: partidoCalendario?.logoLocal || equipoFav.logoRespaldo || `https://media.api-sports.io/football/teams/${mainFavId}.png`,
    visitante: nombreVisitanteFinal,
    logoVisitante: partidoCalendario?.logoVisitante || null,
    golesLocal: datosIA?.golesLocal ?? 0,
    golesVisitante: datosIA?.golesVisitante ?? 0,
    minuto: minutoFinal,
    estado: minutoFinal === 'Medio Tiempo' ? 'HT' : 'LIVE',
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
    const margenAntes = 5 * 60 * 1000;           // 5 minutos antes del inicio
    const duracionMaxima = 115 * 60 * 1000;      // 1 hora y 55 minutos de duración del partido

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
          const query = `${partidoProg.local} vs ${partidoProg.visitante} marcador en vivo`;
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
server.listen(PORT, () => console.log(`🚀 Servidor Híbrido (TheSportsDB + ScrapingBee) corriendo en puerto ${PORT}`));