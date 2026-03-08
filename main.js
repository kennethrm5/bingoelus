// main.js — proceso principal de Electron
// arranca express + socket.io, abre el gestor y controla todo el estado del juego

'use strict';

const { app, BrowserWindow } = require('electron');
const path   = require('path');
const fs     = require('fs');
const http   = require('http');
const express = require('express');
const { Server } = require('socket.io');
const ngrok = require('@ngrok/ngrok');
const crypto = require('crypto');

// ─── Constantes ──────────────────────────────────────────────
const PORT        = 3000;
const CARTON_COLS = 5;
const CARTON_ROWS = 5;
const CARTON_SIZE = CARTON_COLS * CARTON_ROWS; // 25 celdas

// todo el estado vive aquí, el servidor es la única fuente de verdad

const estado = {
  frases: [],
  cantadas: [],
  jugadores: {},    // socketId → datos del jugador
  tokens: {},       // twitchLogin → cartón persistente entre sesiones
  ips: {},          // ip → twitchLogin (para evitar dos cuentas desde la misma red)
  lineaGanada: false,
  bingoGanado: false,
  partidaActiva: false,
  reclamacionesHabilitadas: false,
  umbralReclamo: 0, // casillas sin completar permitidas para reclamar bingo
};

const rateLimits = {};
const RATE_LIMIT_MS = 3000; // mínimo entre reclamaciones del mismo jugador

// credenciales de Twitch — van en twitch.config.json o en variables de entorno
let twitchCfg = {
  clientId:        process.env.TWITCH_CLIENT_ID     || '',
  clientSecret:    process.env.TWITCH_CLIENT_SECRET || '',
};
let ngrokCfg = {
  authToken: process.env.NGROK_AUTH_TOKEN || '',
  domain:    process.env.NGROK_DOMAIN     || '',
};
try {
  const fileCfg = require('./twitch.config.json');
  if (fileCfg.clientId)       twitchCfg.clientId     = fileCfg.clientId;
  if (fileCfg.clientSecret)   twitchCfg.clientSecret = fileCfg.clientSecret;
  if (fileCfg.ngrokAuthToken) ngrokCfg.authToken     = fileCfg.ngrokAuthToken;
  if (fileCfg.ngrokDomain)    ngrokCfg.domain        = fileCfg.ngrokDomain;
} catch { /* sin archivo de config, tiro de env vars */ }

// URL base que usamos en el callback de OAuth
let tunnelActualUrl = ngrokCfg.domain
  ? `https://${ngrokCfg.domain}`
  : `http://localhost:${PORT}`;

function getCallbackUrl() {
  if (ngrokCfg.domain) return `https://${ngrokCfg.domain}/auth/twitch/callback`;
  return `${tunnelActualUrl}/auth/twitch/callback`;
}

const twitchStates   = new Map(); // state CSRF → timestamp
const twitchSessions = new Map(); // sessionId → { login, displayName }
function parseCookies(str) {
  const out = {};
  String(str || '').split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq < 1) return;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  });
  return out;
}

// ─── Utilidades de juego ─────────────────────────────────────

// Fisher-Yates, nada del otro mundo
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// coge 25 frases al azar y monta la matriz 5×5
function generarCarton(frases) {
  const seleccionadas = shuffle(frases).slice(0, CARTON_SIZE);
  const carton = [];
  for (let fila = 0; fila < CARTON_ROWS; fila++) {
    carton.push(seleccionadas.slice(fila * CARTON_COLS, (fila + 1) * CARTON_COLS));
  }
  return carton;
}

// validación server-side — el cliente no decide nada, solo pide
// el servidor comprueba el cartón original contra su propio estado

// una línea completa = fila o columna donde TODAS las casillas están cantadas Y marcadas
// (si no está marcada no cuenta, evita que reclamen con casillas que no han tachado)
function validarLinea(carton, cantadas, marcadas) {
  const cantadasSet = new Set(cantadas); // O(1) lookup
  const marcadasSet = new Set(marcadas);
  const valida = f => cantadasSet.has(f) && marcadasSet.has(f);

  // Comprobar filas horizontales
  for (let fila = 0; fila < CARTON_ROWS; fila++) {
    if (carton[fila].every(valida)) {
      return true; // Línea horizontal completa
    }
  }

  // Comprobar columnas verticales
  for (let col = 0; col < CARTON_COLS; col++) {
    if (carton.every(fila => valida(fila[col]))) {
      return true; // Línea vertical completa
    }
  }

  return false; // Ninguna línea completa
}

// bingo = celdas sin cantar <= umbral (si umbral es 0 deben estar todas cantadas)
function validarBingo(carton, cantadas, umbral) {
  const cantadasSet = new Set(cantadas);
  const sinCantar = carton.flat().filter(f => !cantadasSet.has(f)).length;
  return sinCantar <= umbral;
}

// guarda un resumen de ganadores en <userData>/resultados/YYYY-MM-DD_HH-MM-SS.txt
function guardarResultados(ganadoresLinea, ganadoresBingo) {
  const dir = path.join(app.getPath('userData'), 'resultados');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const ahora = new Date();
  const pad = n => String(n).padStart(2, '0');
  const fecha = `${ahora.getFullYear()}-${pad(ahora.getMonth()+1)}-${pad(ahora.getDate())}`;
  const hora  = `${pad(ahora.getHours())}-${pad(ahora.getMinutes())}-${pad(ahora.getSeconds())}`;

  const contenido = [
    `=== RESULTADOS DE BINGO — ${fecha.replace(/-/g,'/')} ${hora.replace(/-/g,':')} ===`,
    '',
    'GANADORES DE LÍNEA:',
    ganadoresLinea.length ? ganadoresLinea.join('\n') : '  (ninguno)',
    '',
    'GANADORES DE BINGO:',
    ganadoresBingo.length ? ganadoresBingo.join('\n') : '  (ninguno)',
    '',
  ].join('\n');

  const archivo = path.join(dir, `${fecha}_${hora}.txt`);
  fs.writeFile(archivo, contenido, 'utf8', (err) => {
    if (err) console.error('[Servidor] Error al guardar resultados:', err);
    else console.log(`[Servidor] Resultados guardados en ${archivo}`);
  });
}

// ─── Resumen de jugadores (para enviar al gestor) ─────────────

// jugadores online + los que se desconectaron pero tienen partida guardada
function resumenJugadores() {
  const online = Object.values(estado.jugadores).map(j => ({
    socketId:      j.socketId,
    nombre:        j.nombre,
    twitch:        j.twitch || '',
    twitchVerified: j.twitchVerified || false,
    carton:        j.carton,
    cantadoLinea:  j.cantadoLinea,
    cantadoBingo:  j.cantadoBingo,
    marcadas:      j.marcadas || [],
    online:        true,
  }));

  const onlineLogins = new Set(Object.values(estado.jugadores).map(j => j.twitch));
  const offline = Object.entries(estado.tokens)
    .filter(([login, datos]) => !onlineLogins.has(login) && datos.nombre)
    .map(([login, datos]) => ({
      socketId:      `offline-${login}`,
      nombre:        datos.nombre,
      twitch:        login,
      twitchVerified: true,
      carton:        datos.carton,
      cantadoLinea:  datos.cantadoLinea || false,
      cantadoBingo:  datos.cantadoBingo || false,
      marcadas:      datos.marcadas || [],
      online:        false,
    }));

  return [...online, ...offline];
}

// ─── Express + Socket.io ──────────────────────────────────────

const expressApp = express();
const httpServer = http.createServer(expressApp);
const io = new Server(httpServer);

// quito el header X-Powered-By para no revelar que es Express
expressApp.disable('x-powered-by');

// el gestor solo puede abrirse desde localhost (Electron)
// si la petición lleva x-forwarded-for es porque pasó por ngrok desde fuera
function soloLocalhost(req, res, next) {
  if (req.headers['x-forwarded-for']) {
    res.status(403).end();
    return;
  }
  const addr = req.socket.remoteAddress || '';
  const esLocal = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  if (esLocal) return next();
  res.status(403).end();
}

// inicio OAuth → mando al usuario a Twitch
expressApp.get('/auth/twitch', (_req, res) => {
  if (!twitchCfg.clientId) {
    res.status(503).send('Twitch OAuth no configurado. Crea twitch.config.json con clientId y clientSecret.');
    return;
  }
  // limpio states viejos para no acumular basura
  const ahora = Date.now();
  for (const [s, t] of twitchStates) if (ahora - t > 600_000) twitchStates.delete(s);

  const state = crypto.randomBytes(16).toString('hex');
  twitchStates.set(state, ahora);

  const qs = new URLSearchParams({
    client_id:     twitchCfg.clientId,
    redirect_uri:  getCallbackUrl(),
    response_type: 'code',
    scope:         'user:read:email',
    state,
  });
  res.redirect(`https://id.twitch.tv/oauth2/authorize?${qs}`);
});

// callback de Twitch — canjeo el code y creo la sesión local
expressApp.get('/auth/twitch/callback', async (req, res) => {
  const code  = typeof req.query.code  === 'string' ? req.query.code  : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const error = typeof req.query.error === 'string' ? req.query.error : '';

  if (error || !code || !state) {
    res.redirect('/?twitch_error=cancelado');
    return;
  }
  const stateTs = twitchStates.get(state);
  if (!stateTs || Date.now() - stateTs > 600_000) {
    res.redirect('/?twitch_error=estado_invalido');
    return;
  }
  twitchStates.delete(state);

  try {
    const redirectUri = getCallbackUrl();

    // canjeo el code por el access token
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     twitchCfg.clientId,
        client_secret: twitchCfg.clientSecret,
        code,
        grant_type:    'authorization_code',
        redirect_uri:  redirectUri,
      }).toString(),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('No se recibió access_token');

    // pido los datos del canal
    const userRes = await fetch('https://api.twitch.tv/helix/users', {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Client-Id':     twitchCfg.clientId,
      },
    });
    const userData = await userRes.json();
    const user = userData?.data?.[0];
    if (!user) throw new Error('No se obtuvieron datos del usuario');

    // guardo la sesión en memoria, el cliente recibe una cookie httpOnly
    const sessionId = crypto.randomBytes(32).toString('hex');
    twitchSessions.set(sessionId, {
      login:       user.login,
      displayName: user.display_name,
    });
    console.log(`[Twitch] sesión creada para @${user.login}`);

    res.setHeader('Set-Cookie', `twitch_sid=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7200`);
    res.redirect('/');
  } catch (err) {
    console.error('[Twitch] Error en callback OAuth:', err.message);
    res.redirect('/?twitch_error=error_servidor');
  }
});

// devuelve la sesión activa al cliente (o null si no hay)
expressApp.get('/auth/me', (req, res) => {
  const sid  = parseCookies(req.headers.cookie || '')['twitch_sid'];
  const data = sid ? twitchSessions.get(sid) : null;
  res.json(data || null);
});

// cerrar sesión
expressApp.get('/auth/twitch/logout', (req, res) => {
  const sid = parseCookies(req.headers.cookie || '')['twitch_sid'];
  if (sid) twitchSessions.delete(sid);
  res.setHeader('Set-Cookie', 'twitch_sid=; Path=/; Max-Age=0');
  res.redirect('/');
});

// si Twitch está configurado, exijo sesión antes de servir /
expressApp.get('/', (req, res, next) => {
  if (!twitchCfg.clientId) return next(); // sin config → acceso libre (modo local)
  if (req.query.twitch_error) return next(); // dejo ver errores OAuth sin sesión
  const sid = parseCookies(req.headers.cookie || '')['twitch_sid'];
  if (sid && twitchSessions.has(sid)) return next();
  res.redirect('/auth/twitch');
});

expressApp.use(express.static(path.join(__dirname, 'public')));
expressApp.use('/media', express.static(path.join(__dirname, 'media')));

expressApp.get('/gestor', soloLocalhost, (req, res) => {
  // cabeceras de seguridad para la página del gestor
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'gestor.html'));
});

// namespaces separados para no mezclar eventos del gestor con los de los jugadores
const nsGestor  = io.of('/gestor');
const nsJugador = io.of('/jugador');

// el namespace del gestor solo acepta conexiones desde localhost
// mismo criterio que la ruta HTTP: si viene con x-forwarded-for es de fuera
nsGestor.use((socket, next) => {
  if (socket.handshake.headers['x-forwarded-for']) {
    return next(new Error('Forbidden'));
  }
  const addr = socket.handshake.address || '';
  const esLocal = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  if (esLocal) return next();
  console.warn(`[Gestor] Intento de acceso externo bloqueado desde ${addr}`);
  next(new Error('Forbidden'));
});

// ── Namespace Gestor ──
nsGestor.on('connection', (socket) => {
  console.log('[Gestor] Conectado:', socket.id);

  // Si el dominio ngrok ya está configurado, enviar la redirect URI inmediatamente
  if (ngrokCfg.domain) {
    const baseUrl = `https://${ngrokCfg.domain}`;
    socket.emit('tunel:url', { url: baseUrl });
  } else if (tunnelActualUrl && !tunnelActualUrl.startsWith('http://localhost')) {
    socket.emit('tunel:url', { url: tunnelActualUrl });
  }

  // Enviar estado actual al gestor al conectar (por si recarga)
  socket.emit('estado:actual', {
    frases:       estado.frases,
    cantadas:     estado.cantadas,
    jugadores:    resumenJugadores(),
    lineaGanada:  estado.lineaGanada,
    bingoGanado:  estado.bingoGanado,
    partidaActiva: estado.partidaActiva,
    reclamacionesHabilitadas: estado.reclamacionesHabilitadas,
    umbralReclamo: estado.umbralReclamo,
  });

  // El gestor inicia una nueva partida con una lista de frases
  socket.on('gestor:iniciar-partida', (payload) => {
    const { frases } = payload || {};

    if (!Array.isArray(frases) || frases.length < CARTON_SIZE) {
      socket.emit('gestor:error', {
        msg: `Necesitas al menos ${CARTON_SIZE} frases para generar un cartón 5×5.`,
      });
      return;
    }

    // Resetear estado completamente
    estado.frases                   = frases.map(f => f.trim()).filter(Boolean);
    estado.cantadas                 = [];
    estado.jugadores                = {};
    estado.tokens                   = {};
    estado.ips                      = {};
    estado.lineaGanada              = false;
    estado.bingoGanado              = false;
    estado.partidaActiva            = true;
    estado.reclamacionesHabilitadas = false;
    estado.umbralReclamo            = 0;

    console.log(`[Servidor] Partida iniciada con ${estado.frases.length} frases.`);

    // Notificar a todos los jugadores que la partida arrancó
    nsJugador.emit('partida:nueva');
    nsJugador.emit('partida:reclamaciones-deshabilitadas');

    // Confirmar al gestor
    socket.emit('estado:actual', {
      frases:       estado.frases,
      cantadas:     [],
      jugadores:    [],
      lineaGanada:  false,
      bingoGanado:  false,
      partidaActiva: true,
      reclamacionesHabilitadas: false,
      umbralReclamo: 0,
    });
  });

  // El gestor desmarca una frase cantada (corrección de error)
  socket.on('gestor:desmarcar-frase', (payload) => {
    const { frase } = payload || {};
    if (!frase || !estado.cantadas.includes(frase)) return;

    estado.cantadas = estado.cantadas.filter(f => f !== frase);

    // Asegurar que ningún jugador tenga la frase marcada en el servidor
    Object.values(estado.jugadores).forEach(j => {
      j.marcadas = (j.marcadas || []).filter(m => m !== frase);
    });

    console.log(`[Servidor] Frase descantada: "${frase}"`);

    nsJugador.emit('partida:frase-descantada', { frase, cantadas: estado.cantadas });
    nsGestor.emit('partida:frase-descantada',  { frase, cantadas: estado.cantadas });
  });

  // El gestor canta una frase
  socket.on('gestor:cantar-frase', (payload) => {
    const { frase } = payload || {};

    if (!estado.partidaActiva) {
      socket.emit('gestor:error', { msg: 'No hay partida activa.' });
      return;
    }
    if (!frase || !estado.frases.includes(frase)) {
      socket.emit('gestor:error', { msg: 'Frase no válida.' });
      return;
    }
    if (estado.cantadas.includes(frase)) {
      socket.emit('gestor:error', { msg: 'Esa frase ya fue cantada.' });
      return;
    }

    estado.cantadas.push(frase);
    console.log(`[Servidor] Frase cantada: "${frase}" (${estado.cantadas.length}/${estado.frases.length})`);

    // Notificar a jugadores y al propio gestor
    nsJugador.emit('partida:frase-cantada', { frase, cantadas: estado.cantadas });
    nsGestor.emit('partida:frase-cantada',  { frase, cantadas: estado.cantadas });
  });

  // El gestor resetea la partida sin iniciar una nueva
  socket.on('gestor:resetear', () => {
    estado.cantadas                 = [];
    estado.jugadores                = {};
    estado.tokens                   = {};
    estado.ips                      = {};
    estado.lineaGanada              = false;
    estado.bingoGanado              = false;
    estado.partidaActiva            = false;
    estado.frases                   = [];
    estado.reclamacionesHabilitadas = false;
    estado.umbralReclamo            = 0;

    nsJugador.emit('partida:nueva');
    nsJugador.emit('partida:reclamaciones-deshabilitadas');
    socket.emit('estado:actual', {
      frases: [], cantadas: [], jugadores: [],
      lineaGanada: false, bingoGanado: false, partidaActiva: false,
      reclamacionesHabilitadas: false,
      umbralReclamo: 0,
    });
    console.log('[Servidor] Partida reseteada por el gestor.');
  });

  // El gestor habilita que los jugadores puedan reclamar Línea/Bingo
  socket.on('gestor:habilitar-reclamaciones', () => {
    if (!estado.partidaActiva) return;
    estado.reclamacionesHabilitadas = true;
    nsJugador.emit('partida:reclamaciones-habilitadas');
    nsGestor.emit('partida:reclamaciones-actualizadas', { habilitadas: true });
    console.log('[Servidor] Reclamaciones habilitadas por el gestor.');
  });

  // El gestor deshabilita las reclamaciones
  socket.on('gestor:deshabilitar-reclamaciones', () => {
    estado.reclamacionesHabilitadas = false;
    nsJugador.emit('partida:reclamaciones-deshabilitadas');
    nsGestor.emit('partida:reclamaciones-actualizadas', { habilitadas: false });
    console.log('[Servidor] Reclamaciones deshabilitadas por el gestor.');
  });

  // El gestor ajusta el umbral mínimo de casillas para poder reclamar
  socket.on('gestor:set-umbral', (payload) => {
    const raw = parseInt((payload || {}).umbral, 10);
    estado.umbralReclamo = Number.isFinite(raw) ? Math.max(0, Math.min(25, raw)) : 0;
    nsJugador.emit('partida:umbral-actualizado', { umbral: estado.umbralReclamo });
    nsGestor.emit('partida:umbral-actualizado',  { umbral: estado.umbralReclamo });
    console.log(`[Servidor] Umbral de reclamación: ${estado.umbralReclamo}`);
  });

  // El gestor decide continuar (tras Línea → para Bingo, o tras Bingo → para más ganadores)
  socket.on('gestor:continuar-bingo', () => {
    if (estado.bingoGanado || !estado.partidaActiva) return;
    estado.reclamacionesHabilitadas = true;
    nsJugador.emit('partida:reclamaciones-habilitadas');
    nsGestor.emit('partida:reclamaciones-actualizadas', { habilitadas: true });
    console.log('[Servidor] El gestor continúa la partida para más ganadores.');
  });

  // El gestor termina la partida definitivamente
  socket.on('gestor:terminar-partida', () => {
    if (estado.bingoGanado) return;
    estado.bingoGanado              = true;
    estado.partidaActiva            = false;
    estado.reclamacionesHabilitadas = false;

    const jugadores = Object.values(estado.jugadores);
    const ganadoresLinea = jugadores.filter(j => j.cantadoLinea)
      .map(j => `  - ${j.nombre} (@${j.twitch})`);
    const ganadoresBingo = jugadores.filter(j => j.cantadoBingo)
      .map(j => `  - ${j.nombre} (@${j.twitch})`);
    const ganadores = jugadores.filter(j => j.cantadoBingo).map(j => j.nombre);

    console.log(`[Servidor] Partida terminada. Ganadores de Bingo: ${ganadores.join(', ') || 'ninguno'}`);
    nsJugador.emit('partida:juego-terminado', { ganadores });
    nsGestor.emit('partida:juego-terminado',  { ganadores });
    nsGestor.emit('partida:reclamaciones-actualizadas', { habilitadas: false });

    // Guardar resultados en archivo de texto
    guardarResultados(ganadoresLinea, ganadoresBingo);
  });

  socket.on('disconnect', () => {
    console.log('[Gestor] Desconectado:', socket.id);
  });
});

// ── Namespace Jugador ──
nsJugador.on('connection', (socket) => {
  console.log('[Jugador] Conectado:', socket.id);

  // Leer sesión Twitch del handshake (si el jugador autenticó vía Twitch OAuth)
  const twCookies = parseCookies(socket.handshake.headers.cookie || '');
  const twUser    = twCookies.twitch_sid ? twitchSessions.get(twCookies.twitch_sid) : null;

  // El jugador se une con su nombre (y un token de localStorage para persistencia)
  socket.on('jugador:unirse', (payload) => {
    // si ya está registrado en esta conexión, ignoramos el intento
    if (estado.jugadores[socket.id]) {
      socket.emit('partida:error', { msg: 'Ya estás en la partida.' });
      return;
    }

    const { nombre, token, twitch } = payload || {};

    if (!nombre || typeof nombre !== 'string' || nombre.trim().length === 0) {
      socket.emit('partida:error', { msg: 'Nombre inválido.' });
      return;
    }
    // Validar token (necesario para evitar múltiples cartones con VPN)
    if (!token || typeof token !== 'string' || token.length < 8 || token.length > 128) {
      socket.emit('partida:error', { msg: 'Sesión inválida. Recarga la página.' });
      return;
    }
    if (!estado.partidaActiva) {
      socket.emit('partida:error', { msg: 'No hay ninguna partida activa. Espera al gestor.' });
      return;
    }
    if (estado.bingoGanado) {
      socket.emit('partida:error', { msg: 'La partida ya ha terminado.' });
      return;
    }

    // ── Opción 1: cuenta Twitch verificada es imprescindible ──────────
    if (!twUser) {
      socket.emit('partida:error', { msg: 'Debes iniciar sesión con Twitch para jugar.' });
      return;
    }
    const twitchLogin = twUser.login;

    // ── Opción 4: un login de Twitch por IP ───────────────────────────
    const ip = (socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '').split(',')[0].trim();
    const ipOcupada = estado.ips[ip];
    if (ipOcupada && ipOcupada !== twitchLogin) {
      socket.emit('partida:error', { msg: 'Ya hay un jugador conectado desde tu red. Solo se permite una cuenta por IP.' });
      return;
    }

    const nombreClean = nombre.trim().slice(0, 24);

    // Verificar que no hay otro jugador ACTIVO con el mismo nombre (distinto login Twitch)
    const nombreDuplicado = Object.values(estado.jugadores).some(
      j => j.nombre.toLowerCase() === nombreClean.toLowerCase() && j.twitch !== twitchLogin
    );
    if (nombreDuplicado) {
      socket.emit('partida:error', { msg: `El nombre "${nombreClean}" ya está en uso. Elige otro.` });
      return;
    }

    // Opción 1: cartón atado al login de Twitch (mismo cartón en cualquier dispositivo)
    // Si ya existía una entrada (reconexción), restaurar también marcadas y flags
    const datosGuardados = estado.tokens[twitchLogin];
    let carton;
    if (datosGuardados) {
      carton = datosGuardados.carton;
    } else {
      carton = generarCarton(estado.frases);
      estado.tokens[twitchLogin] = { carton, marcadas: [], cantadoLinea: false, cantadoBingo: false, nombre: nombreClean };
    }
    // Actualizar nombre siempre (puede cambiar entre sesiones)
    estado.tokens[twitchLogin].nombre = nombreClean;
    const marcadasGuardadas  = (datosGuardados && datosGuardados.marcadas)  || [];
    const cantadoLineaGuard  = (datosGuardados && datosGuardados.cantadoLinea)  || false;
    const cantadoBingoGuard  = (datosGuardados && datosGuardados.cantadoBingo)  || false;

    // Registrar IP → login
    estado.ips[ip] = twitchLogin;

    const jugador = {
      socketId:       socket.id,
      token,
      ip,
      nombre:         nombreClean,
      twitch:         twitchLogin,
      twitchVerified: true,
      carton,
      cantadoLinea:   cantadoLineaGuard,
      cantadoBingo:   cantadoBingoGuard,
      marcadas:       marcadasGuardadas,
    };
    estado.jugadores[socket.id] = jugador;

    console.log(`[Servidor] ${jugador.nombre} (@${twitchLogin}) se unió desde ${ip}.`);

    // Enviar al jugador su cartón y las frases ya cantadas (con estado restaurado)
    socket.emit('tu:carton', {
      carton,
      cantadas:                 estado.cantadas,
      marcadas:                 marcadasGuardadas,
      lineaGanada:              estado.lineaGanada,
      bingoGanado:              estado.bingoGanado,
      reclamacionesHabilitadas: estado.reclamacionesHabilitadas,
      umbralReclamo:            estado.umbralReclamo,
    });

    // Notificar al gestor que hay un nuevo jugador
    nsGestor.emit('partida:jugador-unido', { jugadores: resumenJugadores() });
  });

  // El jugador actualiza sus celdas marcadas (el gestor puede verlas)
  socket.on('jugador:actualizar-marcadas', ({ marcadas } = {}) => {
    const jugador = estado.jugadores[socket.id];
    if (!jugador || !Array.isArray(marcadas)) return;
    // solo frases que: (a) ya fueron cantadas Y (b) están en el cartón de este jugador
    const cantadasSet  = new Set(estado.cantadas);
    const cartonSet    = new Set(jugador.carton.flat());
    jugador.marcadas = marcadas
      .filter(f => typeof f === 'string' && cantadasSet.has(f) && cartonSet.has(f))
      .slice(0, 25);
    // Persistir en tokens para que sobreviva desconexiones
    if (estado.tokens[jugador.twitch]) {
      estado.tokens[jugador.twitch].marcadas = jugador.marcadas;
    }
    nsGestor.emit('partida:jugador-unido', { jugadores: resumenJugadores() });
  });

  // El jugador reclama una LÍNEA
  socket.on('jugador:pedir-linea', () => {
    const jugador = estado.jugadores[socket.id];
    const ahora   = Date.now();

    // Validaciones de estado
    if (!jugador) {
      socket.emit('partida:error', { msg: 'No estás registrado en esta partida.' });
      return;
    }

    // Rate limiting server-side: evita spam de clicks
    const rl = rateLimits[socket.id] || { lastLinea: 0, lastBingo: 0 };
    if (ahora - rl.lastLinea < RATE_LIMIT_MS) return; // ignorar silenciosamente
    rl.lastLinea = ahora;
    rateLimits[socket.id] = rl;

    if (!estado.reclamacionesHabilitadas) {
      socket.emit('partida:error', { msg: 'El gestor aún no ha habilitado las reclamaciones.' });
      return;
    }
    if (estado.lineaGanada) {
      socket.emit('partida:error', { msg: 'La línea ya fue cantada por otro jugador.' });
      return;
    }
    if (jugador.cantadoLinea) {
      socket.emit('partida:error', { msg: 'Ya reclamaste una línea en esta partida.' });
      return;
    }

    // VALIDACIÓN REAL: cruzar cartón original del servidor con cantadas Y marcadas del jugador
    if (!validarLinea(jugador.carton, estado.cantadas, jugador.marcadas || [])) {
      socket.emit('partida:error', { msg: '¡Línea incorrecta! Debes cantar Y marcar todas las casillas de una fila o columna.' });
      console.log(`[Servidor] ${jugador.nombre} reclamó Línea INCORRECTAMENTE.`);
      return;
    }

    // ¡Línea válida!
    jugador.cantadoLinea             = true;
    estado.lineaGanada               = true;
    // Deshabilitar reclamaciones hasta que el gestor decida si continuar para Bingo
    estado.reclamacionesHabilitadas  = false;
    console.log(`[Servidor] 🎉 ${jugador.nombre} cantó LÍNEA correctamente.`);

    const payload = { ganador: jugador.nombre, twitch: jugador.twitch, socketId: socket.id };
    socket.emit('tu:linea-valida', payload);           // Al ganador
    nsGestor.emit('partida:linea-valida', payload);    // Al gestor
    nsJugador.emit('partida:linea-anuncio', payload);  // A todos los jugadores
    // Notificar que reclamaciones quedan bloqueadas hasta que el gestor dé paso
    nsJugador.emit('partida:reclamaciones-deshabilitadas');
    nsGestor.emit('partida:reclamaciones-actualizadas', { habilitadas: false });
  });

  // El jugador reclama BINGO
  socket.on('jugador:pedir-bingo', () => {
    const jugador = estado.jugadores[socket.id];
    const ahora   = Date.now();

    if (!jugador) {
      socket.emit('partida:error', { msg: 'No estás registrado en esta partida.' });
      return;
    }

    // Rate limiting server-side
    const rl = rateLimits[socket.id] || { lastLinea: 0, lastBingo: 0 };
    if (ahora - rl.lastBingo < RATE_LIMIT_MS) return;
    rl.lastBingo = ahora;
    rateLimits[socket.id] = rl;

    if (!estado.reclamacionesHabilitadas) {
      socket.emit('partida:error', { msg: 'El gestor aún no ha habilitado las reclamaciones.' });
      return;
    }
    if (estado.bingoGanado) {
      socket.emit('partida:error', { msg: 'El bingo ya fue cantado por otro jugador.' });
      return;
    }
    if (jugador.cantadoBingo) {
      socket.emit('partida:error', { msg: 'Ya reclamaste bingo en esta partida.' });
      return;
    }

    // VALIDACIÓN REAL: celdas sin cantar no pueden superar el umbral
    if (!validarBingo(jugador.carton, estado.cantadas, estado.umbralReclamo)) {
      socket.emit('partida:error', { msg: '¡Bingo incorrecto! Faltan frases por cantar.' });
      console.log(`[Servidor] ${jugador.nombre} reclamó Bingo INCORRECTAMENTE.`);
      return;
    }

    // ¡Bingo válido!
    jugador.cantadoBingo = true;
    // No terminamos la partida aún: el gestor decide si permitir más ganadores
    estado.reclamacionesHabilitadas = false;
    console.log(`[Servidor] 🏆 ${jugador.nombre} cantó BINGO correctamente.`);

    const payload = { ganador: jugador.nombre, twitch: jugador.twitch, socketId: socket.id };
    socket.emit('tu:bingo-valido', payload);           // Al ganador
    nsGestor.emit('partida:bingo-valido', payload);    // Al gestor (decide si continuar)
    nsJugador.emit('partida:bingo-anuncio', payload);  // Aviso informativo a los demás
    nsJugador.emit('partida:reclamaciones-deshabilitadas');
    nsGestor.emit('partida:reclamaciones-actualizadas', { habilitadas: false });
  });

  // Limpiar jugador al desconectar
  socket.on('disconnect', () => {
    const jugador = estado.jugadores[socket.id];
    if (jugador) {
      console.log(`[Servidor] ${jugador.nombre} (@${jugador.twitch}) se desconectó.`);
      // Persistir estado actual en tokens antes de borrar al jugador
      if (estado.tokens[jugador.twitch]) {
        estado.tokens[jugador.twitch].marcadas     = jugador.marcadas;
        estado.tokens[jugador.twitch].cantadoLinea = jugador.cantadoLinea;
        estado.tokens[jugador.twitch].cantadoBingo = jugador.cantadoBingo;
      }
      // Liberar la IP solo si sigue siendo este mismo login quien la ocupa
      if (jugador.ip && estado.ips[jugador.ip] === jugador.twitch) {
        delete estado.ips[jugador.ip];
      }
      delete estado.jugadores[socket.id];
      delete rateLimits[socket.id];
      nsGestor.emit('partida:jugador-unido', { jugadores: resumenJugadores() });
    }
  });
});

// ─── Arrancar servidor HTTP ───────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`[Servidor] Escuchando en http://localhost:${PORT}`);
});

// ─── Electron ─────────────────────────────────────────────────

let mainWindow;
async function abrirTunel() {
  if (!ngrokCfg.authToken || !ngrokCfg.domain) {
    console.warn('[Túnel] ngrokAuthToken / ngrokDomain no configurados. Jugadores solo podrán conectarse en local.');
    nsGestor.emit('tunel:url', { url: `http://localhost:${PORT} (sin túnel)` });
    return;
  }
  // Con dominio fijo, ya tenemos la URL correcta desde el arranque
  const tunnelUrl = `https://${ngrokCfg.domain}`;
  try {
    const listener = await ngrok.forward({
      addr:      PORT,
      authtoken: ngrokCfg.authToken,
      domain:    ngrokCfg.domain,
    });
    tunnelActualUrl = listener.url() || tunnelUrl;
  } catch (err) {
    // ERR_NGROK_334: el túnel ya está activo (sesión anterior). Lo usamos igualmente.
    if (err.message && err.message.includes('already online')) {
      console.log('[Túnel] El túnel ngrok ya estaba activo. Reutilizando dominio fijo.');
    } else {
      console.error('[Túnel] Error al abrir túnel ngrok:', err.message);
    }
    // tunnelActualUrl ya apunta al dominio correcto desde la inicialización
  }
  console.log(`[Túnel] URL pública: ${tunnelActualUrl}`);
  nsGestor.emit('tunel:url', { url: tunnelActualUrl });
}

function crearVentana() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Bingoelus — Gestor',
    icon: path.join(__dirname, 'media', 'joelus.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // La ventana carga el gestor desde el propio servidor Express
  mainWindow.loadURL(`http://localhost:${PORT}/gestor`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  crearVentana();

  // Esperar un momento para que el gestor cargue antes de abrir el túnel
  setTimeout(abrirTunel, 1500);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) crearVentana();
  });
});

app.on('window-all-closed', () => {
  ngrok.disconnect().catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});
