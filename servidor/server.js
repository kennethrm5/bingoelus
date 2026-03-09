// server.js — servidor standalone de Bingoelus para la VM
// Express + Socket.io, sin Electron ni ngrok
// Arranca con: node server.js

'use strict';

const path   = require('path');
const fs     = require('fs');
const http   = require('http');
const express = require('express');
const { Server } = require('socket.io');
const crypto = require('crypto');

// ─── Configuración ────────────────────────────────────────────

let cfg = {
  gestorToken:   process.env.GESTOR_TOKEN   || '',
  clientId:      process.env.TWITCH_CLIENT_ID     || '',
  clientSecret:  process.env.TWITCH_CLIENT_SECRET || '',
  baseUrl:       process.env.BASE_URL       || '',  // URL pública del túnel (p.ej. https://xxx.trycloudflare.com)
};
try {
  const fileCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  if (fileCfg.gestorToken)  cfg.gestorToken  = fileCfg.gestorToken;
  if (fileCfg.clientId)     cfg.clientId     = fileCfg.clientId;
  if (fileCfg.clientSecret) cfg.clientSecret = fileCfg.clientSecret;
  if (fileCfg.baseUrl)      cfg.baseUrl      = fileCfg.baseUrl;
} catch { /* sin config.json, tiro de env vars */ }

if (!cfg.gestorToken) {
  console.error('[Servidor] ERROR: No hay gestorToken configurado. Crea config.json con "gestorToken".');
  process.exit(1);
}

const PORT        = parseInt(process.env.PORT, 10) || 3000;
const CARTON_COLS = 5;
const CARTON_ROWS = 5;
const CARTON_SIZE = CARTON_COLS * CARTON_ROWS;

// ─── Estado del juego ─────────────────────────────────────────

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
  umbralReclamo: 0,
};

const rateLimits = {};
const RATE_LIMIT_MS = 3000;

// ─── Twitch OAuth ─────────────────────────────────────────────

const twitchStates   = new Map();
const twitchSessions = new Map();

function parseCookies(str) {
  const out = {};
  String(str || '').split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq < 1) return;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  });
  return out;
}

function getCallbackUrl() {
  const base = cfg.baseUrl || `http://localhost:${PORT}`;
  return `${base}/auth/twitch/callback`;
}

// ─── Utilidades de juego ──────────────────────────────────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generarCarton(frases) {
  const seleccionadas = shuffle(frases).slice(0, CARTON_SIZE);
  const carton = [];
  for (let fila = 0; fila < CARTON_ROWS; fila++) {
    carton.push(seleccionadas.slice(fila * CARTON_COLS, (fila + 1) * CARTON_COLS));
  }
  return carton;
}

// línea = fila o columna donde todas las casillas están cantadas Y marcadas
function validarLinea(carton, cantadas, marcadas) {
  const cantadasSet = new Set(cantadas);
  const marcadasSet = new Set(marcadas);
  const valida = f => cantadasSet.has(f) && marcadasSet.has(f);
  for (let fila = 0; fila < CARTON_ROWS; fila++) {
    if (carton[fila].every(valida)) return true;
  }
  for (let col = 0; col < CARTON_COLS; col++) {
    if (carton.every(r => valida(r[col]))) return true;
  }
  return false;
}

// bingo = celdas sin cantar <= umbral
function validarBingo(carton, cantadas, umbral) {
  const cantadasSet = new Set(cantadas);
  const sinCantar = carton.flat().filter(f => !cantadasSet.has(f)).length;
  return sinCantar <= umbral;
}

// guarda un resumen de ganadores en ./resultados/YYYY-MM-DD_HH-MM-SS.txt
function guardarResultados(ganadoresLinea, ganadoresBingo) {
  const dir = path.join(__dirname, 'resultados');
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
  fs.writeFile(archivo, contenido, 'utf8', err => {
    if (err) console.error('[Servidor] Error al guardar resultados:', err);
    else console.log(`[Servidor] Resultados guardados en ${archivo}`);
  });
}

// ─── Resumen de jugadores (para el gestor) ───────────────────

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
const io = new Server(httpServer, {
  cors: {
    // Permite que el gestor (Electron, localhost) se conecte al namespace /gestor
    origin: true,
    credentials: true,
  },
});

expressApp.disable('x-powered-by');

// Twitch OAuth
expressApp.get('/auth/twitch', (_req, res) => {
  if (!cfg.clientId) {
    res.status(503).send('Twitch OAuth no configurado. Añade clientId y clientSecret en config.json.');
    return;
  }
  const ahora = Date.now();
  for (const [s, t] of twitchStates) if (ahora - t > 600_000) twitchStates.delete(s);

  const state = crypto.randomBytes(16).toString('hex');
  twitchStates.set(state, ahora);

  const qs = new URLSearchParams({
    client_id:     cfg.clientId,
    redirect_uri:  getCallbackUrl(),
    response_type: 'code',
    scope:         'user:read:email',
    state,
  });
  res.redirect(`https://id.twitch.tv/oauth2/authorize?${qs}`);
});

expressApp.get('/auth/twitch/callback', async (req, res) => {
  const code  = typeof req.query.code  === 'string' ? req.query.code  : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const error = typeof req.query.error === 'string' ? req.query.error : '';

  if (error || !code || !state) { res.redirect('/?twitch_error=cancelado'); return; }

  const stateTs = twitchStates.get(state);
  if (!stateTs || Date.now() - stateTs > 600_000) { res.redirect('/?twitch_error=estado_invalido'); return; }
  twitchStates.delete(state);

  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        grant_type:    'authorization_code',
        redirect_uri:  getCallbackUrl(),
      }).toString(),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('No se recibió access_token');

    const userRes = await fetch('https://api.twitch.tv/helix/users', {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Client-Id':     cfg.clientId,
      },
    });
    const userData = await userRes.json();
    const user = userData?.data?.[0];
    if (!user) throw new Error('No se obtuvieron datos del usuario');

    const sessionId = crypto.randomBytes(32).toString('hex');
    twitchSessions.set(sessionId, { login: user.login, displayName: user.display_name });
    console.log(`[Twitch] sesión creada para @${user.login}`);

    res.setHeader('Set-Cookie', `twitch_sid=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7200`);
    res.redirect('/');
  } catch (err) {
    console.error('[Twitch] Error en callback OAuth:', err.message);
    res.redirect('/?twitch_error=error_servidor');
  }
});

expressApp.get('/auth/me', (req, res) => {
  const sid  = parseCookies(req.headers.cookie || '')['twitch_sid'];
  const data = sid ? twitchSessions.get(sid) : null;
  res.json(data || null);
});

expressApp.get('/auth/twitch/logout', (req, res) => {
  const sid = parseCookies(req.headers.cookie || '')['twitch_sid'];
  if (sid) twitchSessions.delete(sid);
  res.setHeader('Set-Cookie', 'twitch_sid=; Path=/; Max-Age=0');
  res.redirect('/');
});

expressApp.get('/', (req, res, next) => {
  if (!cfg.clientId) return next();
  if (req.query.twitch_error) return next();
  const sid = parseCookies(req.headers.cookie || '')['twitch_sid'];
  if (sid && twitchSessions.has(sid)) return next();
  res.redirect('/auth/twitch');
});

expressApp.use(express.static(path.join(__dirname, 'public')));
expressApp.use('/media', express.static(path.join(__dirname, 'media')));

// ─── Namespaces Socket.io ─────────────────────────────────────

const nsGestor  = io.of('/gestor');
const nsJugador = io.of('/jugador');

// El gestor se autentica con un token secreto en lugar de comprobar localhost
nsGestor.use((socket, next) => {
  const token = (socket.handshake.auth || {}).token;
  if (token && token === cfg.gestorToken) return next();
  console.warn(`[Gestor] Intento de conexión con token inválido desde ${socket.handshake.address}`);
  next(new Error('Forbidden'));
});

// ── Namespace Gestor ──────────────────────────────────────────
nsGestor.on('connection', (socket) => {
  console.log('[Gestor] Conectado:', socket.id);

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

  socket.on('gestor:iniciar-partida', (payload) => {
    const { frases } = payload || {};
    if (!Array.isArray(frases) || frases.length < CARTON_SIZE) {
      socket.emit('gestor:error', { msg: `Necesitas al menos ${CARTON_SIZE} frases para generar un cartón 5×5.` });
      return;
    }
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
    nsJugador.emit('partida:nueva');
    nsJugador.emit('partida:reclamaciones-deshabilitadas');
    socket.emit('estado:actual', {
      frases: estado.frases, cantadas: [], jugadores: [],
      lineaGanada: false, bingoGanado: false, partidaActiva: true,
      reclamacionesHabilitadas: false, umbralReclamo: 0,
    });
  });

  socket.on('gestor:desmarcar-frase', (payload) => {
    const { frase } = payload || {};
    if (!frase || !estado.cantadas.includes(frase)) return;
    estado.cantadas = estado.cantadas.filter(f => f !== frase);
    Object.values(estado.jugadores).forEach(j => {
      j.marcadas = (j.marcadas || []).filter(m => m !== frase);
    });
    console.log(`[Servidor] Frase descantada: "${frase}"`);
    nsJugador.emit('partida:frase-descantada', { frase, cantadas: estado.cantadas });
    nsGestor.emit('partida:frase-descantada',  { frase, cantadas: estado.cantadas });
  });

  socket.on('gestor:cantar-frase', (payload) => {
    const { frase } = payload || {};
    if (!estado.partidaActiva) { socket.emit('gestor:error', { msg: 'No hay partida activa.' }); return; }
    if (!frase || !estado.frases.includes(frase)) { socket.emit('gestor:error', { msg: 'Frase no válida.' }); return; }
    if (estado.cantadas.includes(frase)) { socket.emit('gestor:error', { msg: 'Esa frase ya fue cantada.' }); return; }
    estado.cantadas.push(frase);
    console.log(`[Servidor] Frase cantada: "${frase}" (${estado.cantadas.length}/${estado.frases.length})`);
    nsJugador.emit('partida:frase-cantada', { frase, cantadas: estado.cantadas });
    nsGestor.emit('partida:frase-cantada',  { frase, cantadas: estado.cantadas });
  });

  socket.on('gestor:resetear', () => {
    estado.cantadas = []; estado.jugadores = {}; estado.tokens = {}; estado.ips = {};
    estado.lineaGanada = false; estado.bingoGanado = false; estado.partidaActiva = false;
    estado.frases = []; estado.reclamacionesHabilitadas = false; estado.umbralReclamo = 0;
    nsJugador.emit('partida:nueva');
    nsJugador.emit('partida:reclamaciones-deshabilitadas');
    socket.emit('estado:actual', {
      frases: [], cantadas: [], jugadores: [],
      lineaGanada: false, bingoGanado: false, partidaActiva: false,
      reclamacionesHabilitadas: false, umbralReclamo: 0,
    });
    console.log('[Servidor] Partida reseteada por el gestor.');
  });

  socket.on('gestor:habilitar-reclamaciones', () => {
    if (!estado.partidaActiva) return;
    estado.reclamacionesHabilitadas = true;
    nsJugador.emit('partida:reclamaciones-habilitadas');
    nsGestor.emit('partida:reclamaciones-actualizadas', { habilitadas: true });
    console.log('[Servidor] Reclamaciones habilitadas.');
  });

  socket.on('gestor:deshabilitar-reclamaciones', () => {
    estado.reclamacionesHabilitadas = false;
    nsJugador.emit('partida:reclamaciones-deshabilitadas');
    nsGestor.emit('partida:reclamaciones-actualizadas', { habilitadas: false });
    console.log('[Servidor] Reclamaciones deshabilitadas.');
  });

  socket.on('gestor:set-umbral', (payload) => {
    const raw = parseInt((payload || {}).umbral, 10);
    estado.umbralReclamo = Number.isFinite(raw) ? Math.max(0, Math.min(25, raw)) : 0;
    nsJugador.emit('partida:umbral-actualizado', { umbral: estado.umbralReclamo });
    nsGestor.emit('partida:umbral-actualizado',  { umbral: estado.umbralReclamo });
    console.log(`[Servidor] Umbral de reclamación: ${estado.umbralReclamo}`);
  });

  socket.on('gestor:continuar-bingo', () => {
    if (estado.bingoGanado || !estado.partidaActiva) return;
    estado.reclamacionesHabilitadas = true;
    nsJugador.emit('partida:reclamaciones-habilitadas');
    nsGestor.emit('partida:reclamaciones-actualizadas', { habilitadas: true });
    console.log('[Servidor] El gestor continúa la partida para más ganadores.');
  });

  socket.on('gestor:terminar-partida', () => {
    if (estado.bingoGanado) return;
    estado.bingoGanado              = true;
    estado.partidaActiva            = false;
    estado.reclamacionesHabilitadas = false;

    const jugadores = Object.values(estado.jugadores);
    const ganadoresLinea = jugadores.filter(j => j.cantadoLinea).map(j => `  - ${j.nombre} (@${j.twitch})`);
    const ganadoresBingo = jugadores.filter(j => j.cantadoBingo).map(j => `  - ${j.nombre} (@${j.twitch})`);
    const ganadores = jugadores.filter(j => j.cantadoBingo).map(j => j.nombre);

    console.log(`[Servidor] Partida terminada. Ganadores de Bingo: ${ganadores.join(', ') || 'ninguno'}`);
    nsJugador.emit('partida:juego-terminado', { ganadores });
    nsGestor.emit('partida:juego-terminado',  { ganadores });
    nsGestor.emit('partida:reclamaciones-actualizadas', { habilitadas: false });
    guardarResultados(ganadoresLinea, ganadoresBingo);
  });

  socket.on('disconnect', () => {
    console.log('[Gestor] Desconectado:', socket.id);
  });
});

// ── Namespace Jugador ─────────────────────────────────────────
nsJugador.on('connection', (socket) => {
  console.log('[Jugador] Conectado:', socket.id);

  const twCookies = parseCookies(socket.handshake.headers.cookie || '');
  const twUser    = twCookies.twitch_sid ? twitchSessions.get(twCookies.twitch_sid) : null;

  socket.on('jugador:unirse', (payload) => {
    if (estado.jugadores[socket.id]) {
      socket.emit('partida:error', { msg: 'Ya estás en la partida.' });
      return;
    }
    const { nombre, token } = payload || {};

    if (!nombre || typeof nombre !== 'string' || nombre.trim().length === 0) {
      socket.emit('partida:error', { msg: 'Nombre inválido.' });
      return;
    }
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
    if (!twUser) {
      socket.emit('partida:error', { msg: 'Debes iniciar sesión con Twitch para jugar.' });
      return;
    }
    const twitchLogin = twUser.login;

    const ip = (socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '').split(',')[0].trim();
    const ipOcupada = estado.ips[ip];
    if (ipOcupada && ipOcupada !== twitchLogin) {
      socket.emit('partida:error', { msg: 'Ya hay un jugador conectado desde tu red. Solo se permite una cuenta por IP.' });
      return;
    }

    const nombreClean = nombre.trim().slice(0, 24);
    const nombreDuplicado = Object.values(estado.jugadores).some(
      j => j.nombre.toLowerCase() === nombreClean.toLowerCase() && j.twitch !== twitchLogin
    );
    if (nombreDuplicado) {
      socket.emit('partida:error', { msg: `El nombre "${nombreClean}" ya está en uso. Elige otro.` });
      return;
    }

    const datosGuardados = estado.tokens[twitchLogin];
    let carton;
    if (datosGuardados) {
      carton = datosGuardados.carton;
    } else {
      carton = generarCarton(estado.frases);
      estado.tokens[twitchLogin] = { carton, marcadas: [], cantadoLinea: false, cantadoBingo: false, nombre: nombreClean };
    }
    estado.tokens[twitchLogin].nombre = nombreClean;
    const marcadasGuardadas = (datosGuardados && datosGuardados.marcadas)     || [];
    const cantadoLineaGuard = (datosGuardados && datosGuardados.cantadoLinea) || false;
    const cantadoBingoGuard = (datosGuardados && datosGuardados.cantadoBingo) || false;

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

    socket.emit('tu:carton', {
      carton,
      cantadas:                 estado.cantadas,
      marcadas:                 marcadasGuardadas,
      lineaGanada:              estado.lineaGanada,
      bingoGanado:              estado.bingoGanado,
      reclamacionesHabilitadas: estado.reclamacionesHabilitadas,
      umbralReclamo:            estado.umbralReclamo,
    });
    nsGestor.emit('partida:jugador-unido', { jugadores: resumenJugadores() });
  });

  socket.on('jugador:actualizar-marcadas', ({ marcadas } = {}) => {
    const jugador = estado.jugadores[socket.id];
    if (!jugador || !Array.isArray(marcadas)) return;
    const cantadasSet = new Set(estado.cantadas);
    const cartonSet   = new Set(jugador.carton.flat());
    jugador.marcadas = marcadas
      .filter(f => typeof f === 'string' && cantadasSet.has(f) && cartonSet.has(f))
      .slice(0, 25);
    if (estado.tokens[jugador.twitch]) {
      estado.tokens[jugador.twitch].marcadas = jugador.marcadas;
    }
    nsGestor.emit('partida:jugador-unido', { jugadores: resumenJugadores() });
  });

  socket.on('jugador:pedir-linea', () => {
    const jugador = estado.jugadores[socket.id];
    const ahora   = Date.now();
    if (!jugador) { socket.emit('partida:error', { msg: 'No estás registrado en esta partida.' }); return; }
    const rl = rateLimits[socket.id] || { lastLinea: 0, lastBingo: 0 };
    if (ahora - rl.lastLinea < RATE_LIMIT_MS) return;
    rl.lastLinea = ahora; rateLimits[socket.id] = rl;
    if (!estado.reclamacionesHabilitadas) { socket.emit('partida:error', { msg: 'El gestor aún no ha habilitado las reclamaciones.' }); return; }
    if (estado.lineaGanada) { socket.emit('partida:error', { msg: 'La línea ya fue cantada por otro jugador.' }); return; }
    if (jugador.cantadoLinea) { socket.emit('partida:error', { msg: 'Ya reclamaste una línea en esta partida.' }); return; }
    if (!validarLinea(jugador.carton, estado.cantadas, jugador.marcadas || [])) {
      socket.emit('partida:error', { msg: '¡Línea incorrecta! Debes cantar Y marcar todas las casillas de una fila o columna.' });
      console.log(`[Servidor] ${jugador.nombre} reclamó Línea INCORRECTAMENTE.`);
      return;
    }
    jugador.cantadoLinea = true;
    estado.lineaGanada   = true;
    estado.reclamacionesHabilitadas = false;
    console.log(`[Servidor] 🎉 ${jugador.nombre} cantó LÍNEA correctamente.`);
    const payload = { ganador: jugador.nombre, twitch: jugador.twitch, socketId: socket.id };
    socket.emit('tu:linea-valida', payload);
    nsGestor.emit('partida:linea-valida', payload);
    nsJugador.emit('partida:linea-anuncio', payload);
    nsJugador.emit('partida:reclamaciones-deshabilitadas');
    nsGestor.emit('partida:reclamaciones-actualizadas', { habilitadas: false });
  });

  socket.on('jugador:pedir-bingo', () => {
    const jugador = estado.jugadores[socket.id];
    const ahora   = Date.now();
    if (!jugador) { socket.emit('partida:error', { msg: 'No estás registrado en esta partida.' }); return; }
    const rl = rateLimits[socket.id] || { lastLinea: 0, lastBingo: 0 };
    if (ahora - rl.lastBingo < RATE_LIMIT_MS) return;
    rl.lastBingo = ahora; rateLimits[socket.id] = rl;
    if (!estado.reclamacionesHabilitadas) { socket.emit('partida:error', { msg: 'El gestor aún no ha habilitado las reclamaciones.' }); return; }
    if (estado.bingoGanado) { socket.emit('partida:error', { msg: 'El bingo ya fue cantado por otro jugador.' }); return; }
    if (jugador.cantadoBingo) { socket.emit('partida:error', { msg: 'Ya reclamaste bingo en esta partida.' }); return; }
    if (!validarBingo(jugador.carton, estado.cantadas, estado.umbralReclamo)) {
      socket.emit('partida:error', { msg: '¡Bingo incorrecto! Faltan frases por cantar.' });
      console.log(`[Servidor] ${jugador.nombre} reclamó Bingo INCORRECTAMENTE.`);
      return;
    }
    jugador.cantadoBingo = true;
    estado.reclamacionesHabilitadas = false;
    console.log(`[Servidor] 🏆 ${jugador.nombre} cantó BINGO correctamente.`);
    const payload = { ganador: jugador.nombre, twitch: jugador.twitch, socketId: socket.id };
    socket.emit('tu:bingo-valido', payload);
    nsGestor.emit('partida:bingo-valido', payload);
    nsJugador.emit('partida:bingo-anuncio', payload);
    nsJugador.emit('partida:reclamaciones-deshabilitadas');
    nsGestor.emit('partida:reclamaciones-actualizadas', { habilitadas: false });
  });

  socket.on('disconnect', () => {
    const jugador = estado.jugadores[socket.id];
    if (jugador) {
      console.log(`[Servidor] ${jugador.nombre} (@${jugador.twitch}) se desconectó.`);
      if (estado.tokens[jugador.twitch]) {
        estado.tokens[jugador.twitch].marcadas     = jugador.marcadas;
        estado.tokens[jugador.twitch].cantadoLinea = jugador.cantadoLinea;
        estado.tokens[jugador.twitch].cantadoBingo = jugador.cantadoBingo;
      }
      if (jugador.ip && estado.ips[jugador.ip] === jugador.twitch) delete estado.ips[jugador.ip];
      delete estado.jugadores[socket.id];
      delete rateLimits[socket.id];
      nsGestor.emit('partida:jugador-unido', { jugadores: resumenJugadores() });
    }
  });
});

// ─── Arrancar ─────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`[Servidor] Escuchando en http://localhost:${PORT}`);
  if (cfg.baseUrl) console.log(`[Servidor] URL pública configurada: ${cfg.baseUrl}`);
  else console.log('[Servidor] Sin baseUrl configurada (Twitch OAuth no funcionará). Añade baseUrl en config.json.');
});
