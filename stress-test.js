'use strict';

/**
 * stress-test.js — Prueba de carga EXTREMA para Bingoelus
 *
 * Simula clientes concurrentes con todos los tipos de acciones,
 * añadiendo simulaciones de caos real: estampidas, caídas de red y efecto rebaño.
 *
 * Uso:
 * node stress-test.js [url] [clientes] [duracion_s]
 */

const { io }  = require('socket.io-client');
const https   = require('https');
const http    = require('http');

// ── Configuración ───────────────────────────────────────────────
const TARGET_URL  = process.argv[2] || 'https://bingoelus.online';
const NUM_CLIENTS = parseInt(process.argv[3] || '500',  10);
const DURATION_S  = parseInt(process.argv[4] || '30',   10);
const RAMP_MS     = parseInt(process.argv[5] || '5000', 10);
const CONNECT_TIMEOUT_MS = parseInt(process.argv[6] || '30000', 10);
const JOIN_TIMEOUT_MS = parseInt(process.argv[7] || String(Math.max(8000, Math.floor(CONNECT_TIMEOUT_MS * 0.7))), 10);
const HTTP_WORKERS = parseInt(process.argv[8] || '20', 10); // hilos HTTP paralelos
const ENABLE_CHAOS = (process.argv[9] || '0') === '1';

// ── Métricas ────────────────────────────────────────────────────
const m = {
  http:  { ok: 0, err: 0, totalMs: 0, count: 0 },
  ws:    { ok: 0, err: 0 },
  join:  { ok: 0, err: 0 },
  game:  { err: 0 },
  marca: { sent: 0 },
  linea: { sent: 0 },
  bingo: { sent: 0 },
  dc:    { count: 0 },
  reasons: {
    connectError: Object.create(null),
    joinError: Object.create(null),
  },
};

let stopped = false;
const sockets = [];

// ── Helper HTTP ─────────────────────────────────────────────────
function httpGet(url) {
  return new Promise(resolve => {
    const t0  = Date.now();
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: 10_000 }, res => {
      res.resume();
      res.on('end', () => {
        m.http.ok++;
        m.http.totalMs += Date.now() - t0;
        m.http.count++;
        resolve();
      });
      res.on('error', () => { m.http.err++; resolve(); });
    });
    req.on('error',   () => { m.http.err++; resolve(); });
    req.on('timeout', () => { req.destroy(); m.http.err++; resolve(); });
  });
}

// ── Trabajador HTTP continuo ────────────────────────────────────
async function httpWorker() {
  while (!stopped) {
    const path = Math.random() < 0.7 ? '/' : '/auth/me';
    await httpGet(`${TARGET_URL}${path}`);
    await sleep(300 + Math.random() * 700);
  }
}

// ── Simular un cliente jugador vía Socket.io ────────────────────
function simularJugador(id) {
  const frasesDemo = Array.from({ length: 25 }, (_, i) => `frase-demo-${i}`);
  let joined = false;
  let joinResuelto = false;
  let iv = null;

  const sock = io(`${TARGET_URL}/jugador`, {
    transports: ['websocket'],
    reconnection: false,
    timeout:      CONNECT_TIMEOUT_MS,
    forceNew: true,
    multiplex: false,
  });
  sock.data = { joined: false };
  sockets.push(sock);

  function contarMapa(mapa, clave) {
    mapa[clave] = (mapa[clave] || 0) + 1;
  }

  function resolverJoin(ok, motivo) {
    if (joinResuelto) return;
    joinResuelto = true;
    if (ok) {
      m.join.ok++;
      joined = true;
      sock.data.joined = true;
      return;
    }
    sock.data.joined = false;
    m.join.err++;
    contarMapa(m.reasons.joinError, motivo || 'join_error_desconocido');
  }

  function iniciarAcciones() {
    if (iv) return;
    iv = setInterval(() => {
      if (stopped || !sock.connected || !joined) { clearInterval(iv); iv = null; return; }

      const r = Math.random();

      if (r < 0.60) {
        const n       = Math.floor(Math.random() * 15);
        const marcadas = frasesDemo.slice(0, n);
        sock.emit('jugador:actualizar-marcadas', { marcadas });
        m.marca.sent++;
      } else if (r < 0.82) {
        sock.emit('jugador:pedir-linea');
        m.linea.sent++;
      } else {
        sock.emit('jugador:pedir-bingo');
        m.bingo.sent++;
      }
    }, 1500 + Math.random() * 3500);
  }

  sock.on('connect', () => {
    m.ws.ok++;

    sock.emit('jugador:unirse', {
      nombre: `Bot${id}`,
      token:  `stress-token-${id}-${Math.random().toString(36).slice(2)}`,
    });

    // Si no responde join (ni ok ni error) lo contamos explícitamente.
    setTimeout(() => {
      if (!joinResuelto) {
        resolverJoin(false, 'join_timeout');
      }
    }, JOIN_TIMEOUT_MS);
  });

  sock.on('tu:carton', () => {
    resolverJoin(true);
    iniciarAcciones();
  });

  sock.on('partida:error', (p = {}) => {
    const motivo = typeof p.msg === 'string' && p.msg.trim() ? p.msg.trim() : 'partida_error_sin_msg';
    if (!joinResuelto) {
      resolverJoin(false, motivo);
      return;
    }
    m.game.err++;
  });

  sock.on('connect_error', (err) => {
    m.ws.err++;
    const motivo = (err && (err.message || err.description || err.type)) || 'connect_error_desconocido';
    contarMapa(m.reasons.connectError, String(motivo));
  });

  sock.on('disconnect', () => {
    joined = false;
    sock.data.joined = false;
    m.dc.count++;
  });
}

// 🔥 ESCENARIO 2: EL EFECTO REBAÑO (Todos envían datos a la vez)
function iniciarCaosSimultaneo() {
  setInterval(() => {
    if (stopped) return;
    console.log('\n🔥 [CAOS] Efecto Rebaño: ¡Todos los bots envían clics a la vez!');
    sockets.forEach(sock => {
      const joined = sock && sock.data && sock.data.joined;
      if (sock.connected && joined) {
        sock.emit('jugador:actualizar-marcadas', { marcadas: ['frase-caos-1', 'frase-caos-2'] });
        m.marca.sent++;
      }
    });
  }, 12000); 
}

// ── Utilidad ────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Main ────────────────────────────────────────────────────────
async function main() {
  console.log('\n🎱  Bingoelus Stress Test');
  console.log(`   Target   : ${TARGET_URL}`);
  console.log(`   Clientes WS  : ${NUM_CLIENTS}`);
  console.log(`   Workers HTTP : ${HTTP_WORKERS}`);
  console.log(`   Duración : ${DURATION_S}s`);
  console.log(`   Rampa    : ${(RAMP_MS / 1000).toFixed(1)}s\n`);
  console.log(`   Timeout conexión : ${CONNECT_TIMEOUT_MS}ms`);
  console.log(`   Timeout join     : ${JOIN_TIMEOUT_MS}ms`);
  console.log(`   Modo caos        : ${ENABLE_CHAOS ? 'ON' : 'OFF'}\n`);

  for (let i = 0; i < HTTP_WORKERS; i++) httpWorker();

  const delayPerClient = RAMP_MS / NUM_CLIENTS;
  for (let i = 0; i < NUM_CLIENTS; i++) {
    setTimeout(() => { if (!stopped) simularJugador(i); }, i * delayPerClient);
  }

  // Arrancar simulación de picos solo cuando se solicita.
  if (ENABLE_CHAOS) iniciarCaosSimultaneo();

  let tick = 0;
  const progressIv = setInterval(() => {
    tick += 5;
    const wsOk  = m.ws.ok;
    const wsFail= m.ws.err;
    const httpOk= m.http.ok;
    const httpFail = m.http.err;
    const avgMs = m.http.count ? Math.round(m.http.totalMs / m.http.count) : 0;
    console.log(
      `[${String(tick).padStart(3)}s] ` +
      `WS ${wsOk}✅ ${wsFail}❌ | ` +
      `HTTP ${httpOk}✅ ${httpFail}❌ avg ${avgMs}ms | ` +
      `marca:${m.marca.sent} linea:${m.linea.sent} bingo:${m.bingo.sent}`
    );
  }, 5000);

  await sleep((DURATION_S + RAMP_MS / 1000 + 5) * 1000);
  stopped = true;
  clearInterval(progressIv);

  sockets.forEach(s => { try { s.disconnect(); } catch (_) {} });
  await sleep(1000);

  // ── Reporte final ──────────────────────────────────────────────
  const avgHttp = m.http.count ? Math.round(m.http.totalMs / m.http.count) : 0;
  const errRateWs   = m.ws.ok + m.ws.err > 0
    ? ((m.ws.err   / (m.ws.ok + m.ws.err)) * 100).toFixed(1) : '0.0';
  const errRateHttp = m.http.ok + m.http.err > 0
    ? ((m.http.err / (m.http.ok + m.http.err)) * 100).toFixed(1) : '0.0';

  console.log('\n══════════════════════════════════════════════');
  console.log('              RESULTADOS FINALES              ');
  console.log('══════════════════════════════════════════════');
  console.log('HTTP (GET / y /auth/me)');
  console.log(`  ✅ OK          : ${m.http.ok}`);
  console.log(`  ❌ Errores     : ${m.http.err}  (${errRateHttp}%)`);
  console.log(`  ⏱  Latencia avg : ${avgHttp} ms`);
  console.log('');
  console.log('WebSocket — conexiones');
  console.log(`  ✅ Conectados  : ${m.ws.ok}`);
  console.log(`  ❌ Fallidos    : ${m.ws.err}  (${errRateWs}%)`);
  console.log(`  🔌 Desconexiones: ${m.dc.count}`);
  console.log('');
  console.log('WebSocket — eventos emitidos');
  console.log(`  jugador:unirse              : ${m.ws.ok} conectados  (${m.join.ok} aceptados, ${m.join.err} rechazados)`);
  console.log(`  jugador:actualizar-marcadas : ${m.marca.sent}`);
  console.log(`  jugador:pedir-linea         : ${m.linea.sent}`);
  console.log(`  jugador:pedir-bingo         : ${m.bingo.sent}`);
  console.log(`  partida:error (post-join)   : ${m.game.err}`);

  const topConnectErrors = Object.entries(m.reasons.connectError)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const topJoinErrors = Object.entries(m.reasons.joinError)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  if (topConnectErrors.length) {
    console.log('');
    console.log('Top connect_error (hasta 5):');
    topConnectErrors.forEach(([motivo, count]) => {
      console.log(`  - ${motivo}: ${count}`);
    });
  }

  if (topJoinErrors.length) {
    console.log('');
    console.log('Top join errors (hasta 5):');
    topJoinErrors.forEach(([motivo, count]) => {
      console.log(`  - ${motivo}: ${count}`);
    });
  }

  console.log('══════════════════════════════════════════════\n');

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });