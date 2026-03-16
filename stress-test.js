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
const HTTP_WORKERS = 20; // hilos HTTP paralelos

// 🔥 ESCENARIO 1: LA ESTAMPIDA (Todos intentan entrar en menos de un segundo)
const RAMP_MS = 500; 

// ── Métricas ────────────────────────────────────────────────────
const m = {
  http:  { ok: 0, err: 0, totalMs: 0, count: 0 },
  ws:    { ok: 0, err: 0 },
  join:  { ok: 0, err: 0 },
  marca: { sent: 0 },
  linea: { sent: 0 },
  bingo: { sent: 0 },
  dc:    { count: 0 },
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

  const sock = io(`${TARGET_URL}/jugador`, {
    transports: ['websocket'],
    reconnection: false,
    timeout:      10_000,
  });
  sockets.push(sock);

  sock.on('connect', () => {
    m.ws.ok++;

    sock.emit('jugador:unirse', {
      nombre: `Bot${id}`,
      token:  `stress-token-${id}-${Math.random().toString(36).slice(2)}`,
    });

    const iv = setInterval(() => {
      if (stopped || !sock.connected) { clearInterval(iv); return; }

      const r = Math.random();

      // 🔥 ESCENARIO 3: LA CAÍDA DEL METRO (5% pierde la conexión)
      if (r < 0.05) {
        sock.disconnect();
        // Vuelve a intentar conectar en 3 segundos
        setTimeout(() => { if (!stopped) sock.connect(); }, 3000); 
        return;
      }

      if (r < 0.55) {
        const n       = Math.floor(Math.random() * 15);
        const marcadas = frasesDemo.slice(0, n);
        sock.emit('jugador:actualizar-marcadas', { marcadas });
        m.marca.sent++;
      } else if (r < 0.80) {
        sock.emit('jugador:pedir-linea');
        m.linea.sent++;
      } else {
        sock.emit('jugador:pedir-bingo');
        m.bingo.sent++;
      }
    }, 1500 + Math.random() * 3500);
  });

  sock.on('tu:carton',     () => { m.join.ok++; });
  sock.on('partida:error', () => { m.join.err++; });
  sock.on('connect_error', () => { m.ws.err++;  });
  sock.on('disconnect',    () => { m.dc.count++;  });
}

// 🔥 ESCENARIO 2: EL EFECTO REBAÑO (Todos envían datos a la vez)
function iniciarCaosSimultaneo() {
  setInterval(() => {
    if (stopped) return;
    console.log('\n🔥 [CAOS] Efecto Rebaño: ¡Todos los bots envían clics a la vez!');
    sockets.forEach(sock => {
      if (sock.connected) {
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
  console.log('\n🎱  Bingoelus Stress Test EXTREMO');
  console.log(`   Target   : ${TARGET_URL}`);
  console.log(`   Clientes WS  : ${NUM_CLIENTS}`);
  console.log(`   Workers HTTP : ${HTTP_WORKERS}`);
  console.log(`   Duración : ${DURATION_S}s`);
  console.log(`   Rampa    : ${(RAMP_MS / 1000).toFixed(1)}s (ESTAMPIDA)\n`);

  for (let i = 0; i < HTTP_WORKERS; i++) httpWorker();

  const delayPerClient = RAMP_MS / NUM_CLIENTS;
  for (let i = 0; i < NUM_CLIENTS; i++) {
    setTimeout(() => { if (!stopped) simularJugador(i); }, i * delayPerClient);
  }

  // Arrancar simulación de picos
  iniciarCaosSimultaneo();

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
  console.log(`  jugador:unirse              : ${m.ws.ok} intentos  (${m.join.ok} aceptados, ${m.join.err} rechazados)`);
  console.log(`  jugador:actualizar-marcadas : ${m.marca.sent}`);
  console.log(`  jugador:pedir-linea         : ${m.linea.sent}`);
  console.log(`  jugador:pedir-bingo         : ${m.bingo.sent}`);
  console.log('══════════════════════════════════════════════\n');

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });