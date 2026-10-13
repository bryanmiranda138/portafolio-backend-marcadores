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

// 🚀 Endpoint de Rayos X: Permite probar ScrapingBee en cualquier momento
// Ejemplo de uso en el navegador: tu-url.com/debug-live?equipo=Barcelona
app.get('/debug-live', async (req, res) => {
  try {
    const token = process.env.SCRAPINGBEE_API_KEY;
    if (!token) {
      return res.status(401).json({ error: "Falta configurar SCRAPINGBEE_API_KEY en Render o en tu .env" });
    }

    const equipoPrueba = req.query.equipo || 'Real Madrid';
    const favObj = obtenerFavoritoSiCoincide(equipoPrueba) || EQUIPOS_FAVORITOS[0];

    console.log(`🧪 Ejecutando prueba manual en Google vía ScrapingBee para: ${equipoPrueba}`);
    const resultado = await rasparPartidoGoogle( `${equipoPrueba} partido marcador`, favObj, true);

    res.json({
      mensaje: "✅ Consulta a Google Sports vía ScrapingBee completada",
      busqueda_realizada: `${equipoPrueba} partido marcador`,
      nota: "Puedes probar otro equipo cambiando la URL así: /debug-live?equipo=Aguila",
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

// ⏱️ Intervalo de verificación cada 3 minutos (Solo gasta créditos si hay un partido activo en horario)
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

// 1️⃣ API #1: TheSportsDB (Próximos Partidos + Reloj Disparador para ScrapingBee)
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
            if (ev.strTimestamp) fechaPartido = new Date(ev.strTimestamp).getTime();
            else if (ev.dateEvent) fechaPartido = new Date(`${ev.dateEvent}T${ev.strTime || '00:00:00'}+00:00`).getTime();
            if (!fechaPartido || isNaN(fechaPartido)) return true;
            return (fechaPartido + (2.5 * 60 * 60 * 1000)) > ahora;
          });

          if (eventosRealmenteFuturos.length > 0) {
            eventosRealmenteFuturos.sort((a, b) => {
              const timeA = a.strTimestamp ? new Date(a.strTimestamp).getTime() : new Date(`${a.dateEvent}T${a.strTime||'00:00:00'}+00:00`).getTime();
              const timeB = b.strTimestamp ? new Date(b.strTimestamp).getTime() : new Date(`${b.dateEvent}T${b.strTime||'00:00:00'}+00:00`).getTime();
              return timeA - timeB;
            });

            const fixtureFutu = eventosRealmenteFuturos[0];
            
            // Calculamos el timestamp exacto para que el "Smart Trigger" sepa cuándo activar ScrapingBee
            let timestampInicio = null;
            if (fixtureFutu.strTimestamp) {
              timestampInicio = new Date(fixtureFutu.strTimestamp).getTime();
            } else if (fixtureFutu.dateEvent && fixtureFutu.strTime) {
              timestampInicio = new Date(`${fixtureFutu.dateEvent}T${fixtureFutu.strTime}+00:00`).getTime();
            }

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
              timestampInicio: timestampInicio, // ⏰ Guardamos la hora exacta para el disparador
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
  // Al terminar de actualizar la agenda, verificamos si hay alguno jugando ahora mismo
  buscarPartidosEnVivo();
}

// 🐝 FUNCIÓN NÚCLEO BLINDADA: Raspar el bloque deportivo de Google evadiendo CAPTCHAs
async function rasparPartidoGoogle(queryBusqueda, equipoFav, modoDebug = false, partidoCalendario = null) {
  const token = process.env.SCRAPINGBEE_API_KEY;
  if (!token) return null;

  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(queryBusqueda)}&hl=es`;

  // Reglas de extracción con IA de ScrapingBee para leer el marcador de Google
  const reglasIA = JSON.stringify({
    local: "Nombre del equipo local en el marcador deportivo principal",
    visitante: "Nombre del equipo visitante en el marcador deportivo principal",
    golesLocal: { description: "Goles del equipo local (número entero, 0 si no ha empezado)", type: "number" },
    golesVisitante: { description: "Goles del equipo visitante (número entero, 0 si no ha empezado)", type: "number" },
    minuto: "Minuto actual del partido (ej. 34', 45+2', Medio Tiempo, Finalizado, o fecha si no ha empezado)",
    estado: "Estado del partido: LIVE si está en juego, HT si está en descanso, FT si ya terminó, UPCOMING si no ha empezado",
    goleadores: {
      description: "Lista de goles anotados en el partido en formato 'Jugador Minuto (Equipo)'",
      type: "list"
    },
    tarjetasRojas: {
      description: "Lista de jugadores expulsados con tarjeta roja en formato 'Jugador Minuto (Equipo)'",
      type: "list"
    }
  });

  let datosIA = null;

  // 🛡️ INTENTO 1: Con Premium Proxy y sin bloquear recursos (Evita el 90% de los CAPTCHAs)
  try {
    console.log(`🐝 [Intento 1 - Premium Proxy] Consultando en Google: "${queryBusqueda}"...`);
    const response = await axios.get('https://app.scrapingbee.com/api/v1/', {
      params: {
        api_key: token,
        url: googleUrl,
        custom_google: 'true',
        render_js: 'true',
        block_resources: 'false', // Recomendación #2 de ScrapingBee
        premium_proxy: 'true',    // Recomendación #3 de ScrapingBee
        country_code: 'us',
        ai_extract_rules: reglasIA
      },
      timeout: 45000
    });
    datosIA = response.data;
  } catch (errIntento1) {
    console.warn(`⚠️ Intento 1 bloqueado por CAPTCHA (0 créditos cobrados). Activando Modo Furtivo (Stealth Proxy)...`);
    
    // 🛡️ INTENTO 2 (Respaldo): Si Google pide CAPTCHA, activamos stealth_proxy=true
    const responseStealth = await axios.get('https://app.scrapingbee.com/api/v1/', {
      params: {
        api_key: token,
        url: googleUrl,
        custom_google: 'true',
        render_js: 'true',
        block_resources: 'false',
        stealth_proxy: 'true',    // Recomendación #4 de ScrapingBee (Máxima evasión anti-CAPTCHA)
        ai_extract_rules: reglasIA
      },
      timeout: 60000
    });
    datosIA = responseStealth.data;
  }

  // Si por si acaso ScrapingBee devuelve un string en vez de objeto JSON, lo parseamos
  if (typeof datosIA === 'string') {
    try { datosIA = JSON.parse(datosIA); } catch (e) { return null; }
  }

  if (!datosIA || (!datosIA.local && !datosIA.visitante)) return null;

  const estadoUpper = String(datosIA.estado || '').toUpperCase();
  const minutoStr = String(datosIA.minuto || '');
  
  // Determinamos si realmente está en vivo
  const estaEnVivo = estadoUpper.includes('LIVE') || 
                     estadoUpper.includes('HT') || 
                     estadoUpper.includes('VIVO') ||
                     minutoStr.includes("'") || 
                     minutoStr.toLowerCase().includes('medio tiempo') ||
                     minutoStr.toLowerCase().includes('descanso');

  if (!estaEnVivo && !modoDebug) {
    return null; // Si no está jugando ahora mismo y no es prueba manual, lo ignoramos
  }

  const mainFavId = Array.isArray(equipoFav.idFootball) ? equipoFav.idFootball[0] : equipoFav.idFootball;

  // Formateamos los goleadores para tu Frontend
  const anotadoresData = (datosIA.goleadores || []).map(item => {
    const texto = String(item);
    const minMatch = texto.match(/(\d+)/);
    return {
      equipo: texto.toLowerCase().includes((datosIA.visitante || '').toLowerCase()) ? datosIA.visitante : datosIA.local,
      jugador: texto.replace(/\(.*\)/, '').replace(/\d+'?/, '').trim() || texto,
      minuto: minMatch ? Number(minMatch[1]) : 0,
      tipo: texto.toLowerCase().includes('pen') ? 'Penal' : 'Gol'
    };
  });

  // Formateamos las tarjetas para tu Frontend
  const tarjetasData = (datosIA.tarjetasRojas || []).map(item => {
    const texto = String(item);
    const minMatch = texto.match(/(\d+)/);
    return {
      equipo: texto.toLowerCase().includes((datosIA.visitante || '').toLowerCase()) ? datosIA.visitante : datosIA.local,
      jugador: texto.replace(/\(.*\)/, '').replace(/\d+'?/, '').trim() || texto,
      minuto: minMatch ? Number(minMatch[1]) : 0,
      tipo: 'Roja'
    };
  });

  return {
    id: partidoCalendario?.id || `sb-${mainFavId}`,
    equipoIdFiltro1: mainFavId,
    equipoIdFiltro2: mainFavId,
    local: datosIA.local || partidoCalendario?.local || equipoFav.nombre,
    logoLocal: partidoCalendario?.logoLocal || equipoFav.logoRespaldo || `https://media.api-sports.io/football/teams/${mainFavId}.png`,
    visitante: datosIA.visitante || partidoCalendario?.visitante || 'Rival',
    logoVisitante: partidoCalendario?.logoVisitante || null,
    golesLocal: datosIA.golesLocal ?? 0,
    golesVisitante: datosIA.golesVisitante ?? 0,
    minuto: estaEnVivo ? (datosIA.minuto || 'En Vivo') : `${datosIA.minuto || datosIA.estado} (Prueba)`,
    estado: estadoUpper.includes('HT') ? 'HT' : 'LIVE',
    esEnVivo: true,
    anotadores: anotadoresData,
    tarjetas: tarjetasData
  };
}
// 2️⃣ API #2: ScrapingBee con "Smart Trigger" (Cero desperdicio de créditos)
async function buscarPartidosEnVivo() {
  try {
    const token = process.env.SCRAPINGBEE_API_KEY;
    if (!token) {
      console.error('🛑 ERROR: No se ha configurado la variable SCRAPINGBEE_API_KEY');
      return;
    }

    const ahora = Date.now();
    const margenAntes = 10 * 60 * 1000;      // 10 minutos antes de la hora de inicio
    const duracionMaxima = 2.5 * 60 * 60 * 1000; // Hasta 2.5 horas después del inicio

    // 🔍 Filtramos qué partidos de nuestro calendario están en horario de juego AHORA MISMO
    const partidosEnHorarioDeJuego = cacheProximosPartidos.filter(p => {
      if (!p.timestampInicio) return false;
      return ahora >= (p.timestampInicio - margenAntes) && ahora <= (p.timestampInicio + duracionMaxima);
    });

    if (partidosEnHorarioDeJuego.length === 0) {
      console.log('🛡️ Smart Trigger: Ningún equipo favorito está en horario de partido ahora. 0 créditos de ScrapingBee gastados.');
      partidosEnVivoCache = [];
      emitirDatosAlFrontend();
      return;
    }

    console.log(`🐝 ¡Horario de partido detectado! Consultando ${partidosEnHorarioDeJuego.length} partido(s) en Google vía ScrapingBee...`);
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