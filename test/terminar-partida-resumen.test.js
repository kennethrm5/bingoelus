const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { io } = require('socket.io-client');

const REPO_ROOT = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(REPO_ROOT, 'servidor', 'server.js');
const CONFIG_PATH = path.join(REPO_ROOT, 'servidor', 'config.json');

const sockets = new Set();
let serverProc = null;
let serverUrl = '';
let gestorToken = 'summary-test-token';
let tmpDir = '';
let webhookServer = null;
const webhookRequests = [];
const webhookWaiters = [];

function leerGestorToken() {
  try {
    const fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (fileCfg && typeof fileCfg.gestorToken === 'string' && fileCfg.gestorToken) {
      return fileCfg.gestorToken;
    }
  } catch {
    // Usar token de prueba si no existe config.json
  }
  return 'summary-test-token';
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

function waitFor(socket, event, predicate = () => true, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timeout waiting for "${event}"`));
    }, timeoutMs);
    const handler = (...args) => {
      if (!predicate(...args)) return;
      clearTimeout(timeout);
      socket.off(event, handler);
      resolve(args[0]);
    };
    socket.on(event, handler);
  });
}

function createSocket(namespace, auth) {
  const socket = io(`${serverUrl}${namespace}`, {
    auth,
    transports: ['websocket'],
    reconnection: false,
    timeout: 3000,
  });
  sockets.add(socket);
  return socket;
}

async function connectSocket(socket) {
  const connected = waitFor(socket, 'connect');
  await connected;
}

async function waitForHealthz(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${url}/healthz`);
      if (resp.ok) return await resp.json();
    } catch {
      // El servidor todavía arranca
    }
    await delay(50);
  }
  throw new Error('Timeout waiting for /healthz');
}

async function waitForOnlineCount(expected, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resp = await fetch(`${serverUrl}/healthz`);
    if (resp.ok) {
      const data = await resp.json();
      if (data.jugadoresOnline === expected) return;
    }
    await delay(25);
  }
  throw new Error(`Timeout waiting for jugadoresOnline=${expected}`);
}

function startWebhookMock() {
  webhookServer = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const rawBuffer = Buffer.concat(chunks);
      const parsedForm = await new Request('http://127.0.0.1/webhook', {
        method: 'POST',
        headers: req.headers,
        body: rawBuffer,
      }).formData();

      const payloadJson = JSON.parse(String(parsedForm.get('payload_json') || '{}'));
      const file = parsedForm.get('files[0]');
      const entry = {
        payload: payloadJson,
        fileName: file && typeof file.name === 'string' ? file.name : null,
        fileText: file && typeof file.text === 'function' ? await file.text() : null,
      };

      const waiter = webhookWaiters.shift();
      if (waiter) waiter.resolve(entry);
      else webhookRequests.push(entry);

      res.writeHead(204);
      res.end();
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });

  return new Promise((resolve, reject) => {
    webhookServer.once('error', reject);
    webhookServer.listen(0, '127.0.0.1', () => {
      const { port } = webhookServer.address();
      resolve(`http://127.0.0.1:${port}/webhook`);
    });
  });
}

function nextWebhook(timeoutMs = 5000) {
  if (webhookRequests.length > 0) {
    return Promise.resolve(webhookRequests.shift());
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = webhookWaiters.indexOf(waiter);
      if (idx !== -1) webhookWaiters.splice(idx, 1);
      reject(new Error('Timeout waiting for Discord webhook POST'));
    }, timeoutMs);
    const waiter = {
      resolve: (val) => {
        clearTimeout(timer);
        resolve(val);
      },
    };
    webhookWaiters.push(waiter);
  });
}

async function startGame(manager, count = 25) {
  const frases = Array.from({ length: count }, (_, idx) => `frase-${idx}`);
  const started = waitFor(manager, 'estado:actual', state => state.partidaActiva);
  manager.emit('gestor:iniciar-partida', { frases });
  await started;
  return new Set();
}

async function createPlayer(name, token) {
  const player = createSocket('/jugador');
  await connectSocket(player);
  const cardPromise = waitFor(player, 'tu:carton');
  player.emit('jugador:unirse', { nombre: name, token });
  return { player, card: await cardPromise, twitch: `stress_${token.slice(0, 16)}` };
}

async function singPhrases(manager, sungSet, phrases) {
  for (const frase of phrases) {
    if (sungSet.has(frase)) continue;
    const sung = waitFor(manager, 'partida:frase-cantada', data => data.frase === frase);
    manager.emit('gestor:cantar-frase', { frase });
    await sung;
    sungSet.add(frase);
  }
}

async function enableClaims(manager) {
  const enabled = waitFor(manager, 'partida:reclamaciones-actualizadas', data => data.habilitadas === true);
  manager.emit('gestor:habilitar-reclamaciones');
  await enabled;
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bingoelus-summary-'));
  gestorToken = leerGestorToken();
  const webhookUrl = await startWebhookMock();
  const port = await getFreePort();
  serverUrl = `http://127.0.0.1:${port}`;

  serverProc = spawn(process.execPath, [SERVER_PATH], {
    cwd: path.join(REPO_ROOT, 'servidor'),
    env: {
      ...process.env,
      PORT: String(port),
      GESTOR_TOKEN: gestorToken,
      ALLOW_STRESS_BOTS: '1',
      DISCORD_WEBHOOK_URL: webhookUrl,
      DISCORD_NOTIFY_ON_END: '1',
      DISCORD_ATTACH_RESULTS: '1',
      RESULTS_DIR: path.join(tmpDir, 'resultados'),
      TWITCH_BANS_FILE: path.join(tmpDir, 'cuentas-baneadas.json'),
      GAME_STATE_FILE: path.join(tmpDir, 'estado-partida.json'),
    },
    stdio: 'pipe',
  });

  await waitForHealthz(serverUrl);
});

after(async () => {
  for (const socket of sockets) socket.disconnect();
  if (serverProc && !serverProc.killed) {
    serverProc.kill();
    await new Promise(resolve => serverProc.once('exit', resolve));
  }
  if (webhookServer) {
    await new Promise(resolve => webhookServer.close(resolve));
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('end-of-game summary includes disconnected Linea and Bingo winners', async () => {
  const manager = createSocket('/gestor', { token: gestorToken });
  await connectSocket(manager);
  const sungSet = await startGame(manager, 25);

  const { player: playerA, card: cardA, twitch: twitchA } = await createPlayer('Lylo', 'lylo-winner-token-001');
  const { player: playerB, card: cardB, twitch: twitchB } = await createPlayer('@Joselu™', 'joselu-winner-token1');
  const { player: playerC } = await createPlayer('Espectador', 'viewer-online-token1');

  const row0 = cardA.carton[0];
  await singPhrases(manager, sungSet, row0);
  await enableClaims(manager);

  const lineaPlayerAck = waitFor(playerA, 'tu:linea-valida');
  const lineaGestorEvt = waitFor(manager, 'partida:linea-valida');
  playerA.emit('jugador:pedir-linea', { marcadas: row0 });
  await Promise.all([lineaPlayerAck, lineaGestorEvt]);

  playerA.disconnect();
  await waitForOnlineCount(2);

  const allB = cardB.carton.flat();
  await singPhrases(manager, sungSet, allB);
  await enableClaims(manager);

  const bingoPlayerAck = waitFor(playerB, 'tu:bingo-valido');
  const bingoGestorEvt = waitFor(manager, 'partida:bingo-valido');
  playerB.emit('jugador:pedir-bingo', { marcadas: allB });
  await Promise.all([bingoPlayerAck, bingoGestorEvt]);

  playerB.disconnect();
  await waitForOnlineCount(1);

  const endedPromise = waitFor(manager, 'partida:juego-terminado');
  const webhookPromise = nextWebhook();
  manager.emit('gestor:terminar-partida');
  const [ended, webhook] = await Promise.all([endedPromise, webhookPromise]);

  assert.deepEqual(ended.ganadores, ['@Joselu™']);

  const content = webhook.payload.content;
  assert.match(content, /Jugadores: 1 online \/ 3 totales/);
  assert.doesNotMatch(content, /\(ninguno\)/);
  assert.match(content, new RegExp(`\\*\\*Ganadores de Línea\\*\\*\\n- Lylo \\(@${twitchA}\\)`));
  assert.match(content, new RegExp(`\\*\\*Ganadores de Bingo\\*\\*\\n- @Joselu™ \\(@${twitchB}\\)`));

  assert.ok(webhook.fileName && webhook.fileName.endsWith('.txt'));
  assert.doesNotMatch(webhook.fileText, /\(ninguno\)/);
  assert.match(webhook.fileText, new RegExp(`GANADORES DE LÍNEA:\\n  - Lylo \\(@${twitchA}\\)`));
  assert.match(webhook.fileText, new RegExp(`GANADORES DE BINGO:\\n  - @Joselu™ \\(@${twitchB}\\)`));

  playerC.disconnect();
  manager.disconnect();
});

test('multi-tab and reconnect before old socket disconnects neither drops nor duplicates winners', async () => {
  const manager = createSocket('/gestor', { token: gestorToken });
  await connectSocket(manager);
  const sungSet = await startGame(manager, 25);

  const tokenD = 'multitab-player-token';
  const { player: socket1, card: cardD, twitch: twitchD } = await createPlayer('MultiTab', tokenD);
  await waitForOnlineCount(1);

  const socket1Disconnected = waitFor(socket1, 'disconnect');
  const { player: socket2 } = await createPlayer('MultiTab', tokenD);
  await socket1Disconnected;
  await waitForOnlineCount(1);

  const row0 = cardD.carton[0];
  await singPhrases(manager, sungSet, row0);
  await enableClaims(manager);

  const lineaAck = waitFor(socket2, 'tu:linea-valida');
  socket2.emit('jugador:pedir-linea', { marcadas: row0 });
  await lineaAck;

  const socket2Disconnected = waitFor(socket2, 'disconnect');
  const { player: socket3 } = await createPlayer('MultiTab', tokenD);
  await socket2Disconnected;
  await waitForOnlineCount(1);

  const endedPromise = waitFor(manager, 'partida:juego-terminado');
  const webhookPromise = nextWebhook();
  manager.emit('gestor:terminar-partida');
  await Promise.all([endedPromise, webhookPromise.then(async (webhook) => {
    const content = webhook.payload.content;
    assert.match(content, /Jugadores: 1 online \/ 1 totales/);

    const lineaSection = content.split('**Ganadores de Bingo**')[0];
    const matchesPayload = lineaSection.match(new RegExp(`- MultiTab \\(@${twitchD}\\)`, 'g')) || [];
    assert.equal(matchesPayload.length, 1);

    const txtLineaSection = webhook.fileText.split('GANADORES DE BINGO:')[0];
    const matchesTxt = txtLineaSection.match(new RegExp(`  - MultiTab \\(@${twitchD}\\)`, 'g')) || [];
    assert.equal(matchesTxt.length, 1);
  })]);

  socket3.disconnect();
  manager.disconnect();
});

test('manual Linea and Bingo declarations on offline players appear in end-of-game summary', async () => {
  const manager = createSocket('/gestor', { token: gestorToken });
  await connectSocket(manager);
  await startGame(manager, 25);

  const tokenE = 'player-e-offline-0001';
  const { player: playerE, twitch: twitchE } = await createPlayer('OfflineWinner', tokenE);
  playerE.disconnect();
  await waitForOnlineCount(0);

  const offlineSocketId = `offline-${twitchE}`;
  const manualLineaEvt = waitFor(manager, 'partida:linea-valida', p => p.socketId === offlineSocketId);
  manager.emit('gestor:declarar-linea', { socketId: offlineSocketId });
  await manualLineaEvt;

  const manualBingoEvt = waitFor(manager, 'partida:bingo-valido', p => p.socketId === offlineSocketId);
  manager.emit('gestor:declarar-bingo', { socketId: offlineSocketId });
  await manualBingoEvt;

  const endedPromise = waitFor(manager, 'partida:juego-terminado');
  const webhookPromise = nextWebhook();
  manager.emit('gestor:terminar-partida');
  const [ended, webhook] = await Promise.all([endedPromise, webhookPromise]);

  assert.deepEqual(ended.ganadores, ['OfflineWinner']);
  assert.match(webhook.payload.content, /Jugadores: 0 online \/ 1 totales/);
  assert.match(webhook.payload.content, new RegExp(`\\*\\*Ganadores de Línea\\*\\*\\n- OfflineWinner \\(@${twitchE}\\)`));
  assert.match(webhook.payload.content, new RegExp(`\\*\\*Ganadores de Bingo\\*\\*\\n- OfflineWinner \\(@${twitchE}\\)`));
  assert.match(webhook.fileText, new RegExp(`GANADORES DE LÍNEA:\\n  - OfflineWinner \\(@${twitchE}\\)`));
  assert.match(webhook.fileText, new RegExp(`GANADORES DE BINGO:\\n  - OfflineWinner \\(@${twitchE}\\)`));

  manager.disconnect();
});
