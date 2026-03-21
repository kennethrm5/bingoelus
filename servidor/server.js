// server.js — servidor standalone de Bingoelus para la VM
// Express + Socket.io, sin Electron ni ngrok
// Arranca con: node server.js

'use strict';

const path   = require('path');
const fs     = require('fs');
const http   = require('http');
const express    = require('express');
const compression = require('compression');
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

// Debounce del broadcast de jugadores al gestor
// Con muchos jugadores se espera más para agrupar más actualizaciones
let gestorBroadcastTimer = null;
function scheduledGestorBroadcast() {
  if (gestorBroadcastTimer) return;
  const delay = Object.keys(estado.jugadores).length > 500 ? 2000 : 300;
  gestorBroadcastTimer = setTimeout(() => {
    gestorBroadcastTimer = null;
    nsGestor.emit('partida:jugador-unido', resumenJugadores());
  }, delay);
}

// ─── Twitch OAuth ─────────────────────────────────────────────

const twitchStates   = new Map();
const twitchSessions = new Map();

// Cola de tickets estricta para no disparar el WAF de Twitch
const authQueue = [];
const ticketResult = new Map();
let isProcessingQueue = false;

// Limpiar tickets viejos de la memoria para evitar fugas si los usuarios cierran el navegador
setInterval(() => {
  const ahora = Date.now();
  for (const [t, info] of ticketResult) {
    if (ahora - (info.ts || 0) > 900_000) ticketResult.delete(t);
  }
}, 300_000);

// Limpieza periódica de estados huérfanos cada minuto en lugar de en cada petición
setInterval(() => {
  const ahora = Date.now();
  for (const [s, t] of twitchStates) {
    if (ahora - t > 600_000) twitchStates.delete(s);
  }
}, 60000);

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

// bingo = celdas sin cantar/sin marcar <= umbral
function validarBingo(carton, cantadas, marcadas, umbral) {
  const cantadasSet = new Set(cantadas);
  const marcadasSet = new Set(marcadas);
  const sinCompletar = carton.flat().filter(f => !(cantadasSet.has(f) && marcadasSet.has(f))).length;
  return sinCompletar <= umbral;
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

// Con pocos jugadores manda el listado completo.
// Con muchos (>300) manda solo estadísticas + ganadores para no saturar.
const GESTOR_FULL_THRESHOLD = 300;

function resumenJugadores() {
  const jugadoresArr = Object.values(estado.jugadores);
  const onlineLogins = new Set(jugadoresArr.map(j => j.twitch));

  const offlineArr = Object.entries(estado.tokens)
    .filter(([login, datos]) => !onlineLogins.has(login) && datos.nombre);

  const total  = jugadoresArr.length + offlineArr.length;
  const online = jugadoresArr.length;

  // Ganadores siempre se incluyen (pocos en cualquier caso)
  const ganadoresLinea = jugadoresArr
    .filter(j => j.cantadoLinea)
    .map(j => ({ socketId: j.socketId, nombre: j.nombre, twitch: j.twitch, cantadoLinea: true, cantadoBingo: j.cantadoBingo, online: true }));
  const ganadoresBingo = jugadoresArr
    .filter(j => j.cantadoBingo)
    .map(j => ({ socketId: j.socketId, nombre: j.nombre, twitch: j.twitch, cantadoLinea: j.cantadoLinea, cantadoBingo: true, online: true }));

  if (total > GESTOR_FULL_THRESHOLD) {
    // Modo compacto: el gestor recibe estadísticas + ganadores, no todos los cartones
    return {
      modo:           'compacto',
      totalJugadores: total,
      online,
      ganadores:      [...new Map([...ganadoresLinea, ...ganadoresBingo].map(g => [g.twitch, g])).values()],
    };
  }

  // Modo completo (<=300 jugadores)
  const listaOnline = jugadoresArr.map(j => ({
    socketId:       j.socketId,
    nombre:         j.nombre,
    twitch:         j.twitch || '',
    twitchVerified: j.twitchVerified || false,
    carton:         j.carton,
    cantadoLinea:   j.cantadoLinea,
    cantadoBingo:   j.cantadoBingo,
    marcadas:       j.marcadas || [],
    online:         true,
  }));

  const listaOffline = offlineArr.map(([login, datos]) => ({
    socketId:       `offline-${login}`,
    nombre:         datos.nombre,
    twitch:         login,
    twitchVerified: true,
    carton:         datos.carton,
    cantadoLinea:   datos.cantadoLinea || false,
    cantadoBingo:   datos.cantadoBingo || false,
    marcadas:       datos.marcadas || [],
    online:         false,
  }));

  return { modo: 'completo', totalJugadores: total, online, jugadores: [...listaOnline, ...listaOffline] };
}

// ─── Express + Socket.io ──────────────────────────────────────

const expressApp = express();
const httpServer = http.createServer(expressApp);
const io = new Server(httpServer, {
  cors: {
    origin: true,
    credentials: true,
  },
  // Preferir WebSocket: evita el doble round-trip de polling
  transports: ['websocket', 'polling'],
  // Reduce overhead de paquetes
  pingInterval: 25000,
  pingTimeout: 20000,
});

expressApp.disable('x-powered-by');
// Gzip en todas las respuestas HTTP (reduce ancho de banda ~70%)
expressApp.use(compression());

// Twitch OAuth
expressApp.get('/auth/twitch', (_req, res) => {
  if (!cfg.clientId) {
    res.status(503).send('Twitch OAuth no configurado. Añade clientId y clientSecret en config.json.');
    return;
  }
  const ahora = Date.now();

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

expressApp.get('/auth/twitch/callback', (req, res) => {
  const code  = typeof req.query.code  === 'string' ? req.query.code  : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const error = typeof req.query.error === 'string' ? req.query.error : '';

  if (error || !code || !state) { res.redirect('/?twitch_error=cancelado'); return; }

  const stateTs = twitchStates.get(state);
  if (!stateTs || Date.now() - stateTs > 600_000) { res.redirect('/?twitch_error=estado_invalido'); return; }
  twitchStates.delete(state);

  // En lugar de una conexión HTTP suspendida (que fallaría con demasiada gente),
  // emitimos un ID de ticket e insertamos al usuario en la cola. 
  // La página de espera hará "polling" de su ticket.
  const ticket = crypto.randomBytes(16).toString('hex');
  ticketResult.set(ticket, { status: 'waiting', ts: Date.now() });
  authQueue.push({ ticket, code, state });
  
  // Arrancamos el procesador de cola si no estaba andando
  processAuthQueue();

  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Autenticando... | Bingoelus</title>
      <style>
        body { background: #18181b; color: #efeff1; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; padding: 20px; }
        .spinner { width: 50px; height: 50px; border: 5px solid rgba(145, 70, 255, 0.2); border-top-color: #9146FF; border-radius: 50%; animation: spin 1s ease-in-out infinite; margin-bottom: 20px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        h2 { margin: 0 0 10px 0; font-size: 24px; }
        #cola { color: #fbbf24; background: rgba(251, 191, 36, 0.1); padding: 15px 20px; border-radius: 8px; max-width: 400px; font-weight: 500; font-size: 15px; border: 1px solid rgba(251, 191, 36, 0.2); margin-top: 20px; display: none; }
        #cola.visible { display: block; }
        .pos-resaltada { font-size: 1.2em; font-weight: bold; color: #fff; }
      </style>
    </head>
    <body>
      <div class="spinner"></div>
      <h2 id="titulo">Conectando con Twitch...</h2>
      <div id="cola">⏳ Hay un pico de jugadores simultáneos.<br><br>Estás en la posición <span id="pos" class="pos-resaltada">-</span> de la sala de espera.<br><br>No cierres ni recargues la ventana, entrarás automáticamente.</div>
      
      <script>
        const ticket = "${ticket}";
        function poll() {
          fetch('/auth/twitch/status?ticket=' + ticket)
            .then(r => r.json())
            .then(data => {
              if (data.status === 'done') {
                document.getElementById('titulo').innerText = "¡Listo! Redirigiendo...";
                window.location.href = '/';
              } else if (data.status === 'error') {
                window.location.href = '/?twitch_error=' + (data.error || 'error_servidor');
              } else if (data.status === 'waiting') {
                if (data.pos > 1) {
                  document.getElementById('cola').classList.add('visible');
                  document.getElementById('pos').innerText = data.pos;
                }
                setTimeout(poll, 2500); 
              }
            })
            .catch(() => setTimeout(poll, 3000));
        }
        setTimeout(poll, 800);
      </script>
    </body>
    </html>
  `);
});

async function processAuthQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  const fetchConReintento = async (url, options, maxReintentos = 3) => {
    for (let i = 0; i < maxReintentos; i++) {
      const resp = await fetch(url, options);
      if (resp.status === 429 || resp.status >= 500) {
        const delay = 1000 + (i * 1000) + Math.random() * 1000;
        console.warn(`[Twitch] Reteniendo (status ${resp.status})... Reintento ${i + 1}/${maxReintentos} en ${Math.round(delay)}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return resp;
    }
    return fetch(url, options);
  };

  while (authQueue.length > 0) {
    // EL TRUCO: Sacamos a los usuarios de 3 en 3 (Abrimos 3 cajeros)
    const lote = authQueue.splice(0, 3);

    // Promise.all hace que las peticiones del lote viajen al mismo tiempo
    await Promise.all(lote.map(async ({ ticket, code, state }) => {
      try {
        const tokenRes = await fetchConReintento('https://id.twitch.tv/oauth2/token', {
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

        const userRes = await fetchConReintento('https://api.twitch.tv/helix/users', {
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
        console.log(`[Twitch] sesión creada para @${user.login} (Cola restante: ${authQueue.length})`);

        ticketResult.set(ticket, { status: 'done', sessionId, ts: Date.now() });
      } catch (err) {
        console.error('[Twitch] Error en callback OAuth (authQueue):', err.message);
        ticketResult.set(ticket, { status: 'error', error: 'error_servidor', ts: Date.now() });
      }
    }));

    // Pausa de seguridad después de cada lote de 3.
    // Garantiza un máximo matemático de ~720 usuarios/minuto (por debajo del límite de 800 de Twitch)
    await new Promise(r => setTimeout(r, 250));
  }
  isProcessingQueue = false;
}

// Endpoint donde la sala de espera consulta si ya entró
expressApp.get('/auth/twitch/status', (req, res) => {
  const ticket = req.query.ticket;
  if (!ticket) return res.json({ status: 'error', error: 'estado_invalido' });
  
  const info = ticketResult.get(ticket);
  if (!info) return res.json({ status: 'error', error: 'estado_invalido' });

  if (info.status === 'done') {
    // Clavamos la cookie válida cuando responde 'done'
    res.setHeader('Set-Cookie', `twitch_sid=${info.sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7200`);
    res.json({ status: 'done' });
  } else if (info.status === 'error') {
    res.json({ status: 'error', error: info.error });
  } else {
    // Calculamos qué posición tiene en la array 'authQueue'
    const posIndex = authQueue.findIndex(q => q.ticket === ticket);
    // Si no está en la cola pero es 'waiting', puede que esté en proceso en el lote de 3 (devolvemos 0 para ocultarlo y no haya parpadeo en html)
    const pos = posIndex === -1 ? 0 : posIndex + 1;
    res.json({ status: 'waiting', pos });
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

  expressApp.get('/api/casillas', (req, res) => {
    res.sendFile(require('path').join(__dirname, 'casillas.json'), err => { if(err) res.status(404).json({}); });
  });

expressApp.get('/', (req, res, next) => {
  if (!cfg.clientId) return next();
  if (req.query.twitch_error) return next();
  const sid = parseCookies(req.headers.cookie || '')['twitch_sid'];
  if (sid && twitchSessions.has(sid)) return next();
  res.redirect('/auth/twitch');
});

// Cache agresivo en assets estáticos: el navegador no vuelve a pedirlos si ya los tiene
expressApp.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0, // Desactivado para forzar recarga
  etag: true,
  lastModified: true,
}));
expressApp.use('/media', express.static(path.join(__dirname, 'media'), {
  maxAge: '7d',   // las imágenes no cambian durante el directo
  etag: true,
  immutable: true,
}));

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
    jugadores:    resumenJugadores().jugadores || [],
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
    /*
    const ipOcupada = estado.ips[ip];
    if (ipOcupada && ipOcupada !== twitchLogin) {
      socket.emit('partida:error', { msg: 'Ya hay un jugador conectado desde tu red. Solo se permite una cuenta por IP.' });
      return;
    }
    */
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
    nsGestor.emit('partida:jugador-unido', resumenJugadores());
  });

  socket.on('jugador:actualizar-marcadas', ({ marcadas } = {}) => {
    const jugador = estado.jugadores[socket.id];
    const ahora = Date.now();
    if (!jugador || !Array.isArray(marcadas)) return;

    // Rate limit: 400ms máximo entre actualizaciones de marcadas por jugador
    const rl = rateLimits[socket.id] || { lastLinea: 0, lastBingo: 0, lastMarcadas: 0 };
    if (ahora - (rl.lastMarcadas || 0) < 400) return;
    rl.lastMarcadas = ahora;
    rateLimits[socket.id] = rl;

    const cartonSet   = new Set(jugador.carton.flat());
    jugador.marcadas = marcadas
      .filter(f => typeof f === 'string' && cartonSet.has(f))
      .slice(0, 25);
    if (estado.tokens[jugador.twitch]) {
      estado.tokens[jugador.twitch].marcadas = jugador.marcadas;
    }
    // Delta ligero: solo manda las marcadas actualizadas de este jugador
    nsGestor.emit('partida:marcadas-actualizadas', { socketId: socket.id, marcadas: jugador.marcadas });
  });

// Guarda el num de huelgas global, no solo temporales
const STRIKES_MAX = 3;
const STRIKE_COOLDOWN_SEG = 20;

function sanitizarMarcadasCarton(jugador, frescas) {
  if (Array.isArray(frescas)) {
    const cartonSet = new Set(jugador.carton.flat());
    jugador.marcadas = frescas.filter(f => typeof f === 'string' && cartonSet.has(f)).slice(0, 25);
    nsGestor.emit('partida:marcadas-actualizadas', { socketId: jugador.socketId, marcadas: jugador.marcadas });
  }
}

function frasePendienteParaLinea(jugador) {
  const cantadasSet = new Set(estado.cantadas);
  // Primero: ¿Han marcado alguna mentira?
  const falsa = jugador.marcadas.find(f => !cantadasSet.has(f));
  if (falsa) return falsa;
  // Si no, cogemos la primera que le falte de su cartón para rellenar (una que no esté cantada)
  const noCantada = jugador.carton.flat().find(f => !cantadasSet.has(f));
  return noCantada || 'Alguna casilla';
}

function frasePendienteParaBingo(jugador) {
  const cantadasSet = new Set(estado.cantadas);
  const falsa = jugador.marcadas.find(f => !cantadasSet.has(f));
  if (falsa) return falsa;
  const noCantada = jugador.carton.flat().find(f => !cantadasSet.has(f));
  return noCantada || 'Alguna casilla';
}

function registrarFalloReclamo(jugador, socket, frasePendiente) {
  jugador.huelgas = (jugador.huelgas || 0) + 1;
  const errorMsg = `"${frasePendiente}" no ha salido, espabila!`;
  
  if (jugador.huelgas >= STRIKES_MAX) {
    jugador.huelgas = 0;
    socket.emit('tu:bloqueado', { segs: STRIKE_COOLDOWN_SEG, msg: `Demasiados intentos falsos. Espabila y espera ${STRIKE_COOLDOWN_SEG}s.` });
  } else {
    socket.emit('partida:error', { msg: `${errorMsg} (${jugador.huelgas}/${STRIKES_MAX})` });
  }
}

  socket.on('jugador:pedir-linea', ({ marcadas: marcadasFrescas } = {}) => {
    const jugador = estado.jugadores[socket.id];
    const ahora   = Date.now();
    if (!jugador) { socket.emit('partida:error', { msg: 'No estás registrado en esta partida.' }); return; }
    const rl = rateLimits[socket.id] || { lastLinea: 0, lastBingo: 0 };
    if (ahora - rl.lastLinea < RATE_LIMIT_MS) return;
    rl.lastLinea = ahora; rateLimits[socket.id] = rl;
    
    // Actualizar marcadas con las frescas del cliente antes de validar
    sanitizarMarcadasCarton(jugador, marcadasFrescas);
    
    if (!estado.reclamacionesHabilitadas) { socket.emit('partida:error', { msg: 'El gestor aún no ha habilitado las reclamaciones.' }); return; }
    if (estado.lineaGanada) { socket.emit('partida:error', { msg: 'La línea ya fue cantada por otro jugador.' }); return; }
    if (jugador.cantadoLinea) { socket.emit('partida:error', { msg: 'Ya reclamaste una línea en esta partida.' }); return; }
    
    if (!validarLinea(jugador.carton, estado.cantadas, jugador.marcadas || [])) {
      const frase = frasePendienteParaLinea(jugador);
      registrarFalloReclamo(jugador, socket, frase);
      console.log(`[Servidor] ${jugador.nombre} reclamó Línea INCORRECTAMENTE. Le falta/falso: ${frase}`);
      return;
    }
    
    jugador.huelgas = 0; // reset al acertar
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

  socket.on('jugador:pedir-bingo', ({ marcadas: marcadasFrescas } = {}) => {
    const jugador = estado.jugadores[socket.id];
    const ahora   = Date.now();
    if (!jugador) { socket.emit('partida:error', { msg: 'No estás registrado en esta partida.' }); return; }
    const rl = rateLimits[socket.id] || { lastLinea: 0, lastBingo: 0 };
    if (ahora - rl.lastBingo < RATE_LIMIT_MS) return;
    rl.lastBingo = ahora; rateLimits[socket.id] = rl;
    
    // Actualizar marcadas con las frescas del cliente antes de validar
    sanitizarMarcadasCarton(jugador, marcadasFrescas);
    
    if (!estado.reclamacionesHabilitadas) { socket.emit('partida:error', { msg: 'El gestor aún no ha habilitado las reclamaciones.' }); return; }
    if (estado.bingoGanado) { socket.emit('partida:error', { msg: 'El bingo ya fue cantado por otro jugador.' }); return; }
    if (jugador.cantadoBingo) { socket.emit('partida:error', { msg: 'Ya reclamaste bingo en esta partida.' }); return; }
    
    // Validar bingo solo requiere umbral según lógica previa, pero también las marcadas deben estar ok
    if (!validarBingo(jugador.carton, estado.cantadas, jugador.marcadas || [], estado.umbralReclamo)) {
      const frase = frasePendienteParaBingo(jugador);
      registrarFalloReclamo(jugador, socket, frase);
      console.log(`[Servidor] ${jugador.nombre} reclamó Bingo INCORRECTAMENTE. Le falta/falso: ${frase}`);
      return;
    }
    
    jugador.huelgas = 0; // reset al acertar
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
      scheduledGestorBroadcast();
    }
  });
});

// ─── Arrancar ─────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`[Servidor] Escuchando en http://localhost:${PORT}`);
  if (cfg.baseUrl) console.log(`[Servidor] URL pública configurada: ${cfg.baseUrl}`);
  else console.log('[Servidor] Sin baseUrl configurada (Twitch OAuth no funcionará). Añade baseUrl en config.json.');
});
