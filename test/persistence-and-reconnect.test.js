const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { afterEach, test } = require('node:test');
const { io } = require('socket.io-client');

const REPO_ROOT = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(REPO_ROOT, 'servidor', 'server.js');
const CONFIG_PATH = path.join(REPO_ROOT, 'servidor', 'config.json');
const GESTOR_HTML_PATH = path.join(REPO_ROOT, 'gestor.html');
const MODERADOR_HTML_PATH = path.join(REPO_ROOT, 'servidor', 'public', 'moderador.html');

const activeSockets = new Set();
const activeServers = new Set();
const tempDirs = new Set();

function leerGestorToken() {
  try {
    const fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (fileCfg && typeof fileCfg.gestorToken === 'string' && fileCfg.gestorToken) {
      return fileCfg.gestorToken;
    }
  } catch {
    // Usar token de prueba si no existe config.json
  }
  return 'persistence-test-token';
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitFor(emitter, event, predicate = () => true, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`Timeout waiting for "${event}"`));
    }, timeoutMs);
    const handler = (...args) => {
      if (!predicate(...args)) return;
      clearTimeout(timeout);
      emitter.off(event, handler);
      resolve(args[0]);
    };
    emitter.on(event, handler);
  });
}

async function waitUntil(fn, description, timeoutMs = 5000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await delay(intervalMs);
  }
  throw new Error(`Timeout waiting for ${description}${lastErr ? `: ${lastErr.message}` : ''}`);
}

async function waitForHealthz(url, timeoutMs = 8000) {
  return waitUntil(async () => {
    const resp = await fetch(`${url}/healthz`);
    if (!resp.ok) return null;
    return await resp.json();
  }, '/healthz', timeoutMs, 40);
}

async function startServer({ port, tmpDir, envOverrides = {} }) {
  const gestorToken = leerGestorToken();
  const proc = spawn(process.execPath, [SERVER_PATH], {
    cwd: path.join(REPO_ROOT, 'servidor'),
    env: {
      ...process.env,
      PORT: String(port),
      GESTOR_TOKEN: gestorToken,
      GAME_STATE_FILE: path.join(tmpDir, 'estado-partida.json'),
      TWITCH_BANS_FILE: path.join(tmpDir, 'cuentas-baneadas.json'),
      RESULTS_DIR: path.join(tmpDir, 'resultados'),
      STATE_SAVE_CRITICAL_DEBOUNCE_MS: '20',
      STATE_SAVE_BATCH_DEBOUNCE_MS: '40',
      STATE_SAVE_MAX_WAIT_MS: '120',
      HEALTHZ_VERBOSE: '1',
      DISCORD_NOTIFY_ON_END: '0',
      ...envOverrides,
    },
    stdio: 'pipe',
  });
  activeServers.add(proc);
  const url = `http://127.0.0.1:${port}`;
  await waitForHealthz(url);
  return { proc, url, gestorToken };
}

async function stopServer(proc) {
  if (!proc) return;
  activeServers.delete(proc);
  if (proc.exitCode !== null || proc.killed) return;

  const exited = new Promise(resolve => proc.once('exit', resolve));
  proc.kill();
  const winner = await Promise.race([
    exited.then(() => true),
    delay(2500).then(() => false),
  ]);
  if (!winner && proc.exitCode === null) {
    proc.kill('SIGKILL');
    await exited;
  }
}

function trackSocket(socket) {
  activeSockets.add(socket);
  return socket;
}

function createTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

function signHmacSessionCookie(secret, payload) {
  const key = crypto
    .createHash('sha256')
    .update(`bingoelus:twitch-session:v1:${secret}`)
    .digest();
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', key)
    .update(payloadB64)
    .digest('base64url');
  return `v1.${payloadB64}.${sig}`;
}

afterEach(async () => {
  for (const sock of activeSockets) {
    sock.disconnect();
  }
  activeSockets.clear();

  for (const proc of [...activeServers]) {
    await stopServer(proc);
  }

  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

test('server crash recovery restores full game state and manager reconnects automatically', async () => {
  const tmpDir = createTempDir('bingoelus-persist-');
  const stateFile = path.join(tmpDir, 'estado-partida.json');
  const port = await getFreePort();
  const { proc: proc1, url, gestorToken } = await startServer({
    port,
    tmpDir,
    envOverrides: { ALLOW_STRESS_BOTS: '1' },
  });

  const manager = trackSocket(io(`${url}/gestor`, {
    auth: { token: gestorToken },
    transports: ['websocket', 'polling'],
    forceNew: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 80,
    reconnectionDelayMax: 250,
    randomizationFactor: 0,
  }));
  await waitFor(manager, 'estado:actual');

  const frases = Array.from({ length: 25 }, (_, i) => `frase-${i}`);
  const started = waitFor(manager, 'estado:actual', s => s.partidaActiva);
  manager.emit('gestor:iniciar-partida', { frases });
  await started;

  const umbralUpdated = waitFor(manager, 'partida:umbral-actualizado', d => d.umbral === 2);
  manager.emit('gestor:set-umbral', { umbral: 2 });
  await umbralUpdated;

  const verifUpdated = waitFor(manager, 'partida:verificaciones-actualizadas', d => d.verificadas.includes('frase-0'));
  manager.emit('gestor:toggle-verificacion', { frase: 'frase-0', estado: 'verificada' });
  await verifUpdated;

  const playerA = trackSocket(io(`${url}/jugador`, { transports: ['websocket'], reconnection: false, forceNew: true }));
  await waitFor(playerA, 'connect');
  const cardAPromise = waitFor(playerA, 'tu:carton');
  playerA.emit('jugador:unirse', { nombre: 'Lylo', token: 'token-lylo-0001' });
  const cardA = await cardAPromise;

  const playerB = trackSocket(io(`${url}/jugador`, { transports: ['websocket'], reconnection: false, forceNew: true }));
  await waitFor(playerB, 'connect');
  const cardBPromise = waitFor(playerB, 'tu:carton');
  playerB.emit('jugador:unirse', { nombre: 'Joselu', token: 'token-joselu-001' });
  const cardB = await cardBPromise;

  const row0A = cardA.carton[0];
  for (const frase of row0A) {
    const sung = waitFor(manager, 'partida:frase-cantada', d => d.frase === frase);
    manager.emit('gestor:cantar-frase', { frase });
    await sung;
  }

  const enabled = waitFor(manager, 'partida:reclamaciones-actualizadas', d => d.habilitadas === true);
  manager.emit('gestor:habilitar-reclamaciones');
  await enabled;

  const lineaAck = waitFor(playerA, 'tu:linea-valida');
  const lineaMgr = waitFor(manager, 'partida:linea-valida');
  playerA.emit('jugador:pedir-linea', { marcadas: row0A });
  await Promise.all([lineaAck, lineaMgr]);

  const marksB = cardB.carton[0].slice(0, 3);
  playerB.emit('jugador:actualizar-marcadas', { marcadas: marksB });

  const twitchA = 'stress_token-lylo-0001';
  const twitchB = 'stress_token-joselu-001';
  await waitUntil(() => {
    if (!fs.existsSync(stateFile)) return false;
    const snap = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return snap.partidaActiva === true &&
      Array.isArray(snap.cantadas) && snap.cantadas.length === 5 &&
      snap.lineaGanada === true &&
      snap.umbralReclamo === 2 &&
      Array.isArray(snap.verificadas) && snap.verificadas.includes('frase-0') &&
      snap.tokens?.[twitchA]?.cantadoLinea === true &&
      Array.isArray(snap.tokens?.[twitchB]?.marcadas) && snap.tokens[twitchB].marcadas.length === 3;
  }, 'persisted snapshot on disk');

  const managerDisconnected = waitFor(manager, 'disconnect');
  const managerSawConnectError = waitFor(manager, 'connect_error');
  await stopServer(proc1);
  await managerDisconnected;
  await managerSawConnectError;
  assert.equal(manager.active, true, 'manager socket must keep auto-reconnection active');

  const restoredStatePromise = waitFor(manager, 'estado:actual');
  await startServer({
    port,
    tmpDir,
    envOverrides: { ALLOW_STRESS_BOTS: '1' },
  });
  const restoredState = await restoredStatePromise;

  assert.equal(restoredState.partidaActiva, true);
  assert.deepEqual(restoredState.frases, frases);
  assert.deepEqual(restoredState.cantadas, row0A);
  assert.deepEqual(restoredState.verificadas, ['frase-0']);
  assert.equal(restoredState.umbralReclamo, 2);
  assert.equal(restoredState.lineaGanada, true);
  assert.equal(restoredState.jugadores.length, 2);

  const restoredA = restoredState.jugadores.find(j => j.twitch === twitchA);
  const restoredB = restoredState.jugadores.find(j => j.twitch === twitchB);
  assert.ok(restoredA && restoredB);
  assert.equal(restoredA.cantadoLinea, true);
  assert.equal(restoredA.online, false);
  assert.deepEqual(restoredB.marcadas, marksB);
  assert.equal(restoredB.online, false);

  const playerA2 = trackSocket(io(`${url}/jugador`, { transports: ['websocket'], reconnection: false, forceNew: true }));
  await waitFor(playerA2, 'connect');
  const cardA2Promise = waitFor(playerA2, 'tu:carton');
  playerA2.emit('jugador:unirse', { nombre: 'Lylo', token: 'token-lylo-0001' });
  const cardA2 = await cardA2Promise;
  assert.deepEqual(cardA2.carton, cardA.carton);
  assert.deepEqual(cardA2.marcadas, row0A);

  const playerB2 = trackSocket(io(`${url}/jugador`, { transports: ['websocket'], reconnection: false, forceNew: true }));
  await waitFor(playerB2, 'connect');
  const cardB2Promise = waitFor(playerB2, 'tu:carton');
  playerB2.emit('jugador:unirse', { nombre: 'Joselu', token: 'token-joselu-001' });
  const cardB2 = await cardB2Promise;
  assert.deepEqual(cardB2.carton, cardB.carton);
  assert.deepEqual(cardB2.marcadas, marksB);

  const health = await (await fetch(`${url}/healthz`)).json();
  assert.equal(health.metricas.persistencia.restauradoAlArrancar, true);
});

test('corrupted primary snapshot falls back to .bak backup and repairs primary file', async () => {
  const tmpDir = createTempDir('bingoelus-bak-');
  const stateFile = path.join(tmpDir, 'estado-partida.json');
  const bakFile = `${stateFile}.bak`;
  const port = await getFreePort();

  const { proc: proc1, url, gestorToken } = await startServer({
    port,
    tmpDir,
    envOverrides: { ALLOW_STRESS_BOTS: '1' },
  });

  const manager = trackSocket(io(`${url}/gestor`, {
    auth: { token: gestorToken },
    transports: ['websocket'],
    reconnection: false,
  }));
  await waitFor(manager, 'estado:actual');

  const frases = Array.from({ length: 25 }, (_, i) => `bak-frase-${i}`);
  const started = waitFor(manager, 'estado:actual', s => s.partidaActiva);
  manager.emit('gestor:iniciar-partida', { frases });
  await started;
  await waitUntil(() => fs.existsSync(stateFile) && JSON.parse(fs.readFileSync(stateFile, 'utf8')).cantadas.length === 0, 'save #1');

  const sung1 = waitFor(manager, 'partida:frase-cantada', d => d.frase === 'bak-frase-0');
  manager.emit('gestor:cantar-frase', { frase: 'bak-frase-0' });
  await sung1;
  await waitUntil(() => fs.existsSync(bakFile) && JSON.parse(fs.readFileSync(stateFile, 'utf8')).cantadas.length === 1, 'save #2');

  const sung2 = waitFor(manager, 'partida:frase-cantada', d => d.frase === 'bak-frase-1');
  manager.emit('gestor:cantar-frase', { frase: 'bak-frase-1' });
  await sung2;
  await waitUntil(() => {
    const mainSnap = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const bakSnap = JSON.parse(fs.readFileSync(bakFile, 'utf8'));
    return mainSnap.cantadas.length === 2 && bakSnap.cantadas.length === 1;
  }, 'save #3 rotating save #2 into .bak');

  manager.disconnect();
  await stopServer(proc1);

  fs.writeFileSync(stateFile, '{corrupt-snapshot', 'utf8');

  await startServer({
    port,
    tmpDir,
    envOverrides: { ALLOW_STRESS_BOTS: '1' },
  });

  const manager2 = trackSocket(io(`${url}/gestor`, {
    auth: { token: gestorToken },
    transports: ['websocket'],
    reconnection: false,
  }));
  const state2 = await waitFor(manager2, 'estado:actual');
  assert.equal(state2.partidaActiva, true);
  assert.deepEqual(state2.cantadas, ['bak-frase-0']);

  const repairedPrimary = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepEqual(repairedPrimary.cantadas, ['bak-frase-0']);
});

test('stateless HMAC twitch_sid cookie survives restart, rejects tamper/expiry, and supports logout revocation', async () => {
  const tmpDir = createTempDir('bingoelus-hmac-');
  const stateFile = path.join(tmpDir, 'estado-partida.json');
  const port = await getFreePort();
  const sessionSecret = 'test-hmac-secret-bingoelus';

  const validCookie = signHmacSessionCookie(sessionSecret, {
    login: 'joelus_user',
    displayName: 'JoelusUser',
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const expiredCookie = signHmacSessionCookie(sessionSecret, {
    login: 'joelus_user',
    displayName: 'JoelusUser',
    exp: Math.floor(Date.now() / 1000) - 60,
  });
  const tamperedCookie = `${validCookie}tampered`;

  const { proc: proc1, url, gestorToken } = await startServer({
    port,
    tmpDir,
    envOverrides: {
      ALLOW_STRESS_BOTS: '0',
      SESSION_SECRET: sessionSecret,
    },
  });

  const manager1 = trackSocket(io(`${url}/gestor`, {
    auth: { token: gestorToken },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  }));
  await waitFor(manager1, 'estado:actual');
  const started = waitFor(manager1, 'estado:actual', s => s.partidaActiva);
  manager1.emit('gestor:iniciar-partida', {
    frases: Array.from({ length: 25 }, (_, i) => `hmac-frase-${i}`),
  });
  await started;

  const authMe1 = await (await fetch(`${url}/auth/me`, {
    headers: { Cookie: `twitch_sid=${validCookie}` },
  })).json();
  assert.deepEqual(authMe1, { login: 'joelus_user', displayName: 'JoelusUser' });

  const player1 = trackSocket(io(`${url}/jugador`, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    extraHeaders: { Cookie: `twitch_sid=${validCookie}` },
  }));
  await waitFor(player1, 'connect');
  const card1Promise = waitFor(player1, 'tu:carton');
  player1.emit('jugador:unirse', { nombre: 'JoelusDiscord', token: 'browser-token-0001' });
  const card1 = await card1Promise;
  await waitUntil(() => fs.existsSync(stateFile) && Boolean(JSON.parse(fs.readFileSync(stateFile, 'utf8')).tokens?.joelus_user), 'player persisted');

  player1.disconnect();
  manager1.disconnect();
  await stopServer(proc1);

  await startServer({
    port,
    tmpDir,
    envOverrides: {
      ALLOW_STRESS_BOTS: '0',
      SESSION_SECRET: sessionSecret,
    },
  });

  const authMeAfterRestart = await (await fetch(`${url}/auth/me`, {
    headers: { Cookie: `twitch_sid=${validCookie}` },
  })).json();
  assert.deepEqual(authMeAfterRestart, { login: 'joelus_user', displayName: 'JoelusUser' });

  const player2 = trackSocket(io(`${url}/jugador`, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    extraHeaders: { Cookie: `twitch_sid=${validCookie}` },
  }));
  await waitFor(player2, 'connect');
  const card2Promise = waitFor(player2, 'tu:carton');
  player2.emit('jugador:unirse', { nombre: 'JoelusDiscord', token: 'browser-token-0001' });
  const card2 = await card2Promise;
  assert.deepEqual(card2.carton, card1.carton);

  assert.equal(await (await fetch(`${url}/auth/me`, {
    headers: { Cookie: `twitch_sid=${tamperedCookie}` },
  })).json(), null);

  assert.equal(await (await fetch(`${url}/auth/me`, {
    headers: { Cookie: `twitch_sid=${expiredCookie}` },
  })).json(), null);

  const rejectedPlayer = trackSocket(io(`${url}/jugador`, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    extraHeaders: { Cookie: `twitch_sid=${tamperedCookie}` },
  }));
  await waitFor(rejectedPlayer, 'connect');
  const rejectedErr = waitFor(rejectedPlayer, 'partida:error');
  rejectedPlayer.emit('jugador:unirse', { nombre: 'Intruder', token: 'browser-token-0002' });
  assert.match((await rejectedErr).msg, /Twitch/);

  const logoutResp = await fetch(`${url}/auth/twitch/logout`, {
    headers: { Cookie: `twitch_sid=${validCookie}` },
    redirect: 'manual',
  });
  assert.equal(logoutResp.status, 302);
  assert.match(logoutResp.headers.get('set-cookie') || '', /twitch_sid=;.*Max-Age=0/);

  const authMeAfterLogout = await (await fetch(`${url}/auth/me`, {
    headers: { Cookie: `twitch_sid=${validCookie}` },
  })).json();
  assert.equal(authMeAfterLogout, null);
});

test('gestor.html and moderador.html inline scripts compile cleanly and preserve resilient reconnection handlers', () => {
  for (const filePath of [GESTOR_HTML_PATH, MODERADOR_HTML_PATH]) {
    const html = fs.readFileSync(filePath, 'utf8');
    const matches = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
    assert.ok(matches.length > 0, `expected inline script in ${path.basename(filePath)}`);
    matches.forEach((match, index) => {
      new vm.Script(match[1], { filename: `${path.basename(filePath)}#script-${index}` });
    });

    assert.match(html, /id="banner-conexion"/);
    assert.match(html, /function reconectarAhora\(/);
    assert.match(html, /function esErrorAutenticacion\(/);
    assert.match(html, /function emitirAlServidor\(/);
    assert.match(html, /reconnectionAttempts:\s*Infinity/);
  }
});
