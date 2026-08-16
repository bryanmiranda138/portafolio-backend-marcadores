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

app.get('/', (req, res) =>
  res.send('⚽ Servidor de Marcadores en vivo (Multi-API) funcionando.')
);

app.get('/debug', (req, res) =>
  res.json({
    proximos: cacheProximosPartidos,
    enVivo: partidosEnVivoCache
  })
);

// ============================================================
// 📌 TUS EQUIPOS FAVORITOS
// ============================================================

const EQUIPOS_FAVORITOS = [
  {
    nombre: 'FC Barcelona',
    idFootball: 529,
    strSearch: 'Barcelona'
  },
  {
    nombre: 'Real Madrid',
    idFootball: 541,
    strSearch: 'Real Madrid'
  },
  {
    nombre: 'Boca Juniors',
    idFootball: 451,
    strSearch: 'Boca Juniors'
  },
  {
    nombre: 'River Plate',
    idFootball: 435,
    strSearch: 'River Plate'
  },
  {
    nombre: 'Liverpool',
    idFootball: 40,
    strSearch: 'Liverpool'
  },
  {
    nombre: 'Manchester City',
    idFootball: 50,
    strSearch: 'Manchester City'
  },
  {
    nombre: 'C.D. Águila',
    idFootball: 2307,
    strSearch: 'Aguila'
  },

  // ==========================================================
  // 🔥 INTER MIAMI
  // ==========================================================
  {
    nombre: 'Inter Miami',
    idFootball: 8984,
    strSearch: 'Inter Miami',

    // 🛡️ Logo de respaldo desde API-Football
    logo: 'https://media.api-sports.io/football/teams/8984.png'
  },

  {
    nombre: 'Argentina',
    idFootball: 26,
    strSearch: 'Argentina'
  },
  {
    nombre: 'Brasil',
    idFootball: 6,
    strSearch: 'Brazil'
  },
  {
    nombre: 'Inglaterra',
    idFootball: 10,
    strSearch: 'England'
  },
  {
    nombre: 'Francia',
    idFootball: 2,
    strSearch: 'France'
  },
  {
    nombre: 'España',
    idFootball: 9,
    strSearch: 'Spain'
  }
];

// ============================================================
// 🛡️ EXCLUSIONES CONOCIDAS
// ============================================================

const EXCLUSIONES = [
  'new england',
  'barcelona sc',
  'barcelona de guayaquil',
  'liverpool montevideo',
  'river plate montevideo',
  'real madrid b',
  'barcelona b'
];

// ============================================================
// ⏱️ INTERVALO DE CONSULTA
// ============================================================

const INTERVALO_CONSULTA = 3 * 60 * 1000;

// ============================================================
// 💾 CACHE
// ============================================================

let cacheProximosPartidos = [];
let cargandoProximos = false;
let partidosEnVivoCache = [];

// ============================================================
// ⏳ ESPERAR
// ============================================================

const esperar = (ms) =>
  new Promise(resolve => setTimeout(resolve, ms));

// ============================================================
// 📦 DATOS DE RESPALDO
// ============================================================

const DATOS_RESPALDO = [
  {
    id: 991,
    equipoTrackedId: 541,
    local: 'Real Madrid',
    logoLocal: 'https://media.api-sports.io/football/teams/541.png',
    visitante: 'AC Milan',
    logoVisitante: 'https://media.api-sports.io/football/teams/489.png',
    golesLocal: 0,
    golesVisitante: 0,
    minuto: 'Sábado, 13:00',
    estado: 'PROXIMO',
    esEnVivo: false,
    anotadores: []
  },
  {
    id: 992,
    equipoTrackedId: 529,
    local: 'FC Barcelona',
    logoLocal: 'https://media.api-sports.io/football/teams/529.png',
    visitante: 'Arsenal',
    logoVisitante: 'https://media.api-sports.io/football/teams/42.png',
    golesLocal: 0,
    golesVisitante: 0,
    minuto: 'Domingo, 10:00',
    estado: 'PROXIMO',
    esEnVivo: false,
    anotadores: []
  }
];

// ============================================================
// 🧠 OBTENER LOGO DE UN EQUIPO
// ============================================================

function obtenerLogo(team) {
  if (!team) return null;

  return (
    team.strBadge ||
    team.strTeamBadge ||
    team.strLogo ||
    team.strTeamLogo ||
    team.logo ||
    null
  );
}

// ============================================================
// 🛡️ OBTENER LOGO DE RESPALDO
// ============================================================

function obtenerLogoRespaldo(equipo) {
  if (!equipo) return null;

  return (
    equipo.logo ||
    `https://media.api-sports.io/football/teams/${equipo.idFootball}.png`
  );
}

// ============================================================
// 📡 EMITIR DATOS AL FRONTEND
// ============================================================

function emitirDatosAlFrontend(socketEspecifico = null) {

  const idsJugandoAhora = new Set();

  partidosEnVivoCache.forEach(p => {

    idsJugandoAhora.add(p.equipoIdFiltro1);
    idsJugandoAhora.add(p.equipoIdFiltro2);

  });

  const proximosFiltrados =
    cacheProximosPartidos.filter(
      p => !idsJugandoAhora.has(p.equipoTrackedId)
    );

  const listaBruta = [
    ...partidosEnVivoCache,
    ...proximosFiltrados
  ];

  const mapaDeduplicacion = new Map();

  listaBruta.forEach(partido => {

    if (!mapaDeduplicacion.has(partido.id)) {

      mapaDeduplicacion.set(
        partido.id,
        partido
      );

    }

  });

  const listaFinal =
    Array.from(mapaDeduplicacion.values());

  if (socketEspecifico) {

    socketEspecifico.emit(
      'marcadores_actualizados',
      listaFinal
    );

  } else {

    io.emit(
      'marcadores_actualizados',
      listaFinal
    );

  }
}

// ============================================================
// 🧠 VALIDACIÓN ESTRICTA DE EQUIPOS
// ============================================================

function obtenerFavoritoSiCoincide(nombreEquipoAPI) {

  if (!nombreEquipoAPI) {
    return null;
  }

  const nombreNorm =
    nombreEquipoAPI
      .toLowerCase()
      .trim();

  // ----------------------------------------------------------
  // 🛡️ EXCLUSIONES
  // ----------------------------------------------------------

  if (
    EXCLUSIONES.some(
      ex => nombreNorm.includes(ex)
    )
  ) {
    return null;
  }

  // ----------------------------------------------------------
  // 🔎 BÚSQUEDA
  // ----------------------------------------------------------

  for (const fav of EQUIPOS_FAVORITOS) {

    const searchNorm =
      fav.strSearch
        .toLowerCase()
        .trim();

    const nombreFavNorm =
      fav.nombre
        .toLowerCase()
        .trim();

    // Coincidencia exacta

    if (
      nombreNorm === searchNorm ||
      nombreNorm === nombreFavNorm
    ) {
      return fav;
    }

    // Coincidencia por palabras completas

    const regex =
      new RegExp(
        `\\b${searchNorm}\\b`,
        'i'
      );

    if (regex.test(nombreNorm)) {
      return fav;
    }

  }

  return null;
}

// ============================================================
// 1️⃣ API #1: THESPORTSDB
// ============================================================

async function cargarProximosPartidosProgresivamente() {

  if (cargandoProximos) {
    return;
  }

  cargandoProximos = true;

  console.log(
    '⏳ Iniciando buscador dinámico de próximos partidos...'
  );

  let listaTemporal = [];

  for (const equipo of EQUIPOS_FAVORITOS) {

    try {

      // ------------------------------------------------------
      // 🔎 BUSCAR EQUIPO
      // ------------------------------------------------------

      const urlBusqueda =
        `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(
          equipo.strSearch
        )}`;

      const resBusqueda =
        await axios.get(urlBusqueda);

      // ------------------------------------------------------
      // 🧠 IDENTIFICACIÓN ESTRICTA
      // ------------------------------------------------------

      const nombreFavoritoNorm =
        equipo.nombre
          .toLowerCase()
          .trim();

      const searchNorm =
        equipo.strSearch
          .toLowerCase()
          .trim();

      const equipoEncontrado =
        resBusqueda.data?.teams?.find(t => {

          // Solo Soccer
          if (
            String(t.strSport || '')
              .toLowerCase() !== 'soccer'
          ) {
            return false;
          }

          // Posibles nombres
          const nombres = [
            t.strTeam,
            t.strTeamAlternate,
            t.strTeamShort,
            t.strAlternate
          ]
            .filter(Boolean)
            .map(
              nombre =>
                String(nombre)
                  .toLowerCase()
                  .trim()
            );

          // Coincidencia exacta
          return (
            nombres.includes(nombreFavoritoNorm) ||
            nombres.includes(searchNorm)
          );

        });

      // ------------------------------------------------------
      // 🚨 EQUIPO NO ENCONTRADO
      // ------------------------------------------------------

      if (!equipoEncontrado) {

        throw new Error(
          `Equipo no encontrado en TheSportsDB: ${equipo.nombre}`
        );

      }

      console.log(
        `✅ Equipo encontrado: ${equipo.nombre} -> ${equipoEncontrado.strTeam} (ID ${equipoEncontrado.idTeam})`
      );

      // ------------------------------------------------------
      // 📅 OBTENER PRÓXIMOS PARTIDOS
      // ------------------------------------------------------

      const urlPartidos =
        `https://www.thesportsdb.com/api/v1/json/3/eventsnext.php?id=${equipoEncontrado.idTeam}`;

      const resPartidos =
        await axios.get(urlPartidos);

      const proximosEventos =
        resPartidos.data?.events;

      if (
        !proximosEventos ||
        proximosEventos.length === 0
      ) {

        throw new Error(
          `Agenda vacía para ${equipo.nombre}`
        );

      }

      // ------------------------------------------------------
      // ⏰ SOLO EVENTOS FUTUROS
      // ------------------------------------------------------

      const ahora = Date.now();

      const eventosRealmenteFuturos =
        proximosEventos.filter(ev => {

          if (!ev.strTimestamp) {
            return false;
          }

          const fechaEv =
            new Date(
              ev.strTimestamp
            ).getTime();

          return fechaEv > ahora;

        });

      if (
        eventosRealmenteFuturos.length === 0
      ) {

        throw new Error(
          `No hay partidos futuros para ${equipo.nombre}`
        );

      }

      // ------------------------------------------------------
      // 🎯 TOMAMOS EL PRÓXIMO
      // ------------------------------------------------------

      const fixtureFutu =
        eventosRealmenteFuturos[0];

      // ------------------------------------------------------
      // 📅 FORMATEAR FECHA
      // ------------------------------------------------------

      const fechaUTC =
        new Date(
          fixtureFutu.strTimestamp
        );

      const fechaElSalvador =
        new Date(
          fechaUTC.getTime() -
          (6 * 60 * 60 * 1000)
        );

      const fechaFormateada =
        fechaElSalvador.toLocaleDateString(
          'es-ES',
          {
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'UTC'
          }
        );

      // ------------------------------------------------------
      // 🏠 LOCAL / VISITANTE
      // ------------------------------------------------------

      const esLocal =
        String(
          fixtureFutu.idHomeTeam
        ) ===
        String(
          equipoEncontrado.idTeam
        );

      // ------------------------------------------------------
      // 🛡️ LOGOS
      // ------------------------------------------------------

      const logoEquipoEncontrado =
        obtenerLogo(
          equipoEncontrado
        );

      const logoLocalEvento =
        obtenerLogo({
          strBadge:
            fixtureFutu.strHomeTeamBadge,

          strTeamBadge:
            fixtureFutu.strHomeTeamBadge,

          strLogo:
            fixtureFutu.strHomeTeamLogo,

          strTeamLogo:
            fixtureFutu.strHomeTeamLogo
        });

      const logoVisitanteEvento =
        obtenerLogo({
          strBadge:
            fixtureFutu.strAwayTeamBadge,

          strTeamBadge:
            fixtureFutu.strAwayTeamBadge,

          strLogo:
            fixtureFutu.strAwayTeamLogo,

          strTeamLogo:
            fixtureFutu.strAwayTeamLogo
        });

      // ------------------------------------------------------
      // 🔥 LOGO FINAL LOCAL
      // ------------------------------------------------------

      let logoLocal =
        logoLocalEvento;

      if (
        !logoLocal &&
        esLocal
      ) {

        logoLocal =
          logoEquipoEncontrado;

      }

      if (
        !logoLocal &&
        esLocal
      ) {

        logoLocal =
          obtenerLogoRespaldo(
            equipo
          );

      }

      // ------------------------------------------------------
      // 🔥 LOGO FINAL VISITANTE
      // ------------------------------------------------------

      let logoVisitante =
        logoVisitanteEvento;

      if (
        !logoVisitante &&
        !esLocal
      ) {

        logoVisitante =
          logoEquipoEncontrado;

      }

      if (
        !logoVisitante &&
        !esLocal
      ) {

        logoVisitante =
          obtenerLogoRespaldo(
            equipo
          );

      }

      // ------------------------------------------------------
      // 📦 GUARDAR PARTIDO
      // ------------------------------------------------------

      listaTemporal.push({

        id:
          fixtureFutu.idEvent,

        equipoTrackedId:
          equipo.idFootball,

        local:
          fixtureFutu.strHomeTeam,

        logoLocal:
          logoLocal,

        visitante:
          fixtureFutu.strAwayTeam,

        logoVisitante:
          logoVisitante,

        golesLocal:
          0,

        golesVisitante:
          0,

        minuto:
          fechaFormateada,

        estado:
          'PROXIMO',

        esEnVivo:
          false,

        anotadores:
          []

      });

    } catch (err) {

      console.error(
        `⚠️ Error procesando ${equipo.nombre}:`,
        err.message
      );

      // ------------------------------------------------------
      // 🛡️ RESPALDO
      // ------------------------------------------------------

      const urlEscudoRespaldo =
        obtenerLogoRespaldo(
          equipo
        );

      listaTemporal.push({

        id:
          `tbd-${equipo.idFootball}`,

        equipoTrackedId:
          equipo.idFootball,

        local:
          equipo.nombre,

        logoLocal:
          urlEscudoRespaldo,

        visitante:
          'Rival por definir',

        logoVisitante:
          null,

        golesLocal:
          0,

        golesVisitante:
          0,

        minuto:
          'Fecha por confirmar',

        estado:
          'PROXIMO',

        esEnVivo:
          false,

        anotadores:
          []

      });

    }

    // ------------------------------------------------------
    // 📡 ACTUALIZAR CACHE
    // ------------------------------------------------------

    cacheProximosPartidos =
      [...listaTemporal];

    emitirDatosAlFrontend();

    await esperar(1000);

  }

  cargandoProximos = false;

  console.log(
    '✅ Carga progresiva de próximos partidos terminada.'
  );
}

// ============================================================
// 2️⃣ API #2: API-FOOTBALL
// ============================================================

async function buscarPartidosEnVivo() {

  try {

    console.log(
      '🔍 Consultando partidos en vivo en API-Football...'
    );

    const responseLive =
      await axios.get(
        'https://v3.football.api-sports.io/fixtures?live=all',
        {
          headers: {
            'x-apisports-key':
              process.env.FOOTBALL_API_KEY
          }
        }
      );

    // --------------------------------------------------------
    // ❌ ERRORES API
    // --------------------------------------------------------

    const errores =
      responseLive.data?.errors;

    if (
      errores &&
      Object.keys(errores).length > 0
    ) {

      console.error(
        '⚠️ API-Football devolvió un mensaje/error:',
        JSON.stringify(errores)
      );

      return;
    }

    // --------------------------------------------------------
    // 📦 PARTIDOS EN VIVO
    // --------------------------------------------------------

    const partidosLiveCrudos =
      responseLive.data?.response || [];

    partidosEnVivoCache = [];

    partidosLiveCrudos.forEach(
      fixture => {

        const homeName =
          fixture.teams.home.name;

        const awayName =
          fixture.teams.away.name;

        // ----------------------------------------------------
        // 🔎 BUSCAR FAVORITOS
        // ----------------------------------------------------

        const favHome =
          obtenerFavoritoSiCoincide(
            homeName
          );

        const favAway =
          obtenerFavoritoSiCoincide(
            awayName
          );

        const equipoFavoritoEncontrado =
          favHome || favAway;

        // ----------------------------------------------------
        // ✅ SI ENCONTRAMOS FAVORITO
        // ----------------------------------------------------

        if (
          equipoFavoritoEncontrado
        ) {

          // --------------------------------------------------
          // ⏱️ ESTADO
          // --------------------------------------------------

          const statusCorto =
            fixture.fixture.status.short;

          const elapsed =
            fixture.fixture.status.elapsed;

          const extra =
            fixture.fixture.status.extra;

          let tiempoAmostrar = '';

          if (
            statusCorto === 'HT'
          ) {

            tiempoAmostrar =
              'Medio Tiempo';

          } else if (
            ['FT', 'AET', 'PEN'].includes(
              statusCorto
            )
          ) {

            tiempoAmostrar =
              'Finalizado';

          } else if (
            extra
          ) {

            tiempoAmostrar =
              `${elapsed} + ${extra}'`;

          } else {

            tiempoAmostrar =
              `${elapsed}'`;

          }

          // --------------------------------------------------
          // ⚽ EVENTOS
          // --------------------------------------------------

          const eventos =
            fixture.events || [];

          // --------------------------------------------------
          // ⚽ GOLES
          // --------------------------------------------------

          const anotadoresData =
            eventos

              .filter(
                e =>
                  e.type === 'Goal' &&
                  e.detail !== 'Missed Penalty'
              )

              .map(
                e => ({

                  equipo:
                    e.team.name,

                  jugador:
                    e.player.name ||
                    'Desconocido',

                  minuto:
                    e.time.elapsed,

                  tipo:
                    e.detail === 'Own Goal'
                      ? 'Autogol'
                      : e.detail === 'Penalty'
                        ? 'Penal'
                        : 'Gol'

                })
              );

          // --------------------------------------------------
          // 🟨 🟥 TARJETAS
          // --------------------------------------------------

          const tarjetasData =
            eventos

              .filter(
                e =>
                  e.type === 'Card'
              )

              .map(
                e => ({

                  equipo:
                    e.team.name,

                  jugador:
                    e.player.name ||
                    'Desconocido',

                  minuto:
                    e.time.elapsed,

                  tipo:
                    e.detail
                      .toLowerCase()
                      .includes('yellow')
                      ? 'Amarilla'
                      : 'Roja'

                })
              );

          // --------------------------------------------------
          // 🛡️ LOGOS
          // --------------------------------------------------

          const logoHome =
            fixture.teams.home.logo ||
            (favHome
              ? obtenerLogoRespaldo(favHome)
              : null);

          const logoAway =
            fixture.teams.away.logo ||
            (favAway
              ? obtenerLogoRespaldo(favAway)
              : null);

          // --------------------------------------------------
          // 📦 GUARDAR PARTIDO
          // --------------------------------------------------

          partidosEnVivoCache.push({

            id:
              fixture.fixture.id,

            equipoIdFiltro1:
              equipoFavoritoEncontrado.idFootball,

            equipoIdFiltro2:
              equipoFavoritoEncontrado.idFootball,

            local:
              fixture.teams.home.name,

            logoLocal:
              logoHome,

            visitante:
              fixture.teams.away.name,

            logoVisitante:
              logoAway,

            golesLocal:
              fixture.goals.home ?? 0,

            golesVisitante:
              fixture.goals.away ?? 0,

            minuto:
              tiempoAmostrar,

            estado:
              statusCorto,

            esEnVivo:
              true,

            anotadores:
              anotadoresData,

            tarjetas:
              tarjetasData

          });

        }

      }
    );

    // --------------------------------------------------------
    // 📡 ENVIAR AL FRONTEND
    // --------------------------------------------------------

    emitirDatosAlFrontend();

  } catch (error) {

    console.error(
      '❌ Error de conexión con API-Football al buscar en vivo:',
      error.message
    );

  }

}

// ============================================================
// 🚀 ARRANQUE INMEDIATO
// ============================================================

buscarPartidosEnVivo();

setTimeout(
  cargarProximosPartidosProgresivamente,
  2000
);

// ============================================================
// 🔄 ACTUALIZACIÓN AUTOMÁTICA
// ============================================================

setInterval(
  buscarPartidosEnVivo,
  INTERVALO_CONSULTA
);

// ============================================================
// 🔌 SOCKET.IO
// ============================================================

io.on(
  'connection',
  socket => {

    console.log(
      '🟢 Cliente conectado:',
      socket.id
    );

    emitirDatosAlFrontend(
      socket
    );

    socket.on(
      'disconnect',
      () => {

        console.log(
          '🔴 Cliente desconectado:',
          socket.id
        );

      }
    );

  }
);

// ============================================================
// 🚀 SERVIDOR
// ============================================================

const PORT =
  process.env.PORT || 4000;

server.listen(
  PORT,
  () =>
    console.log(
      `🚀 Servidor Multi-API corriendo en puerto ${PORT}`
    )
);