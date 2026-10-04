const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const { io } = require('socket.io-client');

const BASE_URL = process.env.SYNC_TEST_URL || 'http://127.0.0.1:3101';
const GESTOR_TOKEN = process.env.SYNC_TEST_GESTOR_TOKEN || 'sync-test-token';
const sockets = new Set();

function waitFor(socket, event, predicate = () => true, timeoutMs = 3000) {
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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createSocket(namespace, auth) {
  const socket = io(`${BASE_URL}${namespace}`, {
    auth,
    transports: ['websocket'],
    reconnection: false,
    timeout: 3000,
  });
  sockets.add(socket);
  return socket;
}

async function connect(socket) {
  const connected = waitFor(socket, 'connect');
  await connected;
}

async function startGame(manager) {
  const active = waitFor(manager, 'estado:actual', state => state.partidaActiva);
  manager.emit('gestor:iniciar-partida', {
    frases: Array.from({ length: 60 }, (_, index) => `frase-${index}`),
  });
  await active;
}

async function createPlayer(name, token) {
  const player = createSocket('/jugador');
  await connect(player);
  const card = waitFor(player, 'tu:carton');
  player.emit('jugador:unirse', { nombre: name, token });
  return { player, card: await card };
}

async function createGame() {
  const manager = createSocket('/gestor', { token: GESTOR_TOKEN });
  await connect(manager);
  await startGame(manager);
  return manager;
}

after(() => {
  for (const socket of sockets) socket.disconnect();
});

test('disconnect and transport reconnect leave the mobile player offline without an application rejoin', async () => {
  const manager = await createGame();
  const token = 'mobile-reconnect-test-0001';
  const { player, card } = await createPlayer('Offline mobile', token);
  const originalSocketId = player.id;
  const firstMark = card.carton[0][0];
  const secondMark = card.carton[0][1];
  const unsentMark = card.carton[1][0];

  player.emit('jugador:actualizar-marcadas', { marcadas: [firstMark] });
  await delay(20);
  player.emit('jugador:actualizar-marcadas', { marcadas: [firstMark, secondMark] });

  const wentOffline = waitFor(
    manager,
    'partida:jugador-unido',
    summary => summary.jugadores.some(
      playerInfo => playerInfo.nombre === 'Offline mobile' &&
        !playerInfo.online &&
        playerInfo.marcadas.includes(secondMark),
    ),
  );
  player.disconnect();
  const offlineSummary = await wentOffline;
  const offlinePlayer = offlineSummary.jugadores.find(playerInfo => playerInfo.nombre === 'Offline mobile');
  assert.deepEqual(offlinePlayer.marcadas, [firstMark, secondMark]);

  const nextConnection = waitFor(player, 'connect');
  player.connect();
  await nextConnection;
  const reconnectedSocketId = player.id;
  const unexpectedCard = waitFor(player, 'tu:carton', () => true, 250).catch(() => null);
  const ignoredMark = waitFor(
    manager,
    'partida:marcadas-actualizadas',
    update => update.socketId === reconnectedSocketId && update.marcadas.includes(unsentMark),
    250,
  ).catch(() => null);
  player.emit('jugador:actualizar-marcadas', { marcadas: [firstMark, secondMark, unsentMark] });
  assert.equal(await unexpectedCard, null, 'the server should expose that the app did not rejoin');
  assert.equal(await ignoredMark, null, 'an unregistered socket must not update the manager');

  const stateManager = createSocket('/gestor', { token: GESTOR_TOKEN });
  const currentState = waitFor(stateManager, 'estado:actual');
  await connect(stateManager);
  const state = await currentState;
  const savedPlayer = state.jugadores.find(playerInfo => playerInfo.nombre === 'Offline mobile');

  assert.equal(state.online, 0);
  assert.equal(savedPlayer.online, false);
  assert.deepEqual(savedPlayer.marcadas, [firstMark, secondMark]);
  assert.notEqual(reconnectedSocketId, originalSocketId);
});

test('an explicit application rejoin restores the same card and saved marks', async () => {
  const manager = await createGame();
  const token = 'mobile-rejoin-test-0002';
  const { player, card } = await createPlayer('Rejoined mobile', token);
  const firstMark = card.carton[0][0];
  const saved = waitFor(
    manager,
    'partida:marcadas-actualizadas',
    update => update.marcadas.includes(firstMark),
  );
  player.emit('jugador:actualizar-marcadas', { marcadas: [firstMark] });
  await saved;

  player.disconnect();
  const nextConnection = waitFor(player, 'connect');
  player.connect();
  await nextConnection;

  const restoredCard = waitFor(player, 'tu:carton');
  const onlineAgain = waitFor(
    manager,
    'partida:jugador-unido',
    summary => summary.jugadores.some(playerInfo => playerInfo.nombre === 'Rejoined mobile' && playerInfo.online),
  );
  player.emit('jugador:unirse', { nombre: 'Rejoined mobile', token });
  const restored = await restoredCard;
  await onlineAgain;

  assert.deepEqual(restored.carton, card.carton);
  assert.deepEqual(restored.marcadas, [firstMark]);
});

test('the final mark snapshot is delivered when marks arrive 125 ms apart at the adaptive rate threshold', async () => {
  const manager = await createGame();
  const { player, card } = await createPlayer('Rate limited mobile', 'mobile-rate-test-0003');
  const allPlayersOnline = waitFor(manager, 'partida:jugador-unido', summary => summary.online === 100, 10000);
  const bots = await Promise.all(Array.from({ length: 99 }, async (_, index) => {
    const { player: bot } = await createPlayer(`Load bot ${index}`, `load-bot-${String(index).padStart(4, '0')}`);
    return bot;
  }));
  await allPlayersOnline;

  const [firstMark, finalMark] = [card.carton[0][0], card.carton[0][1]];
  const delivered = waitFor(
    manager,
    'partida:marcadas-actualizadas',
    update => update.marcadas.includes(finalMark),
    1200,
  ).catch(() => null);
  player.emit('jugador:actualizar-marcadas', { marcadas: [firstMark] });
  await delay(125);
  player.emit('jugador:actualizar-marcadas', { marcadas: [firstMark, finalMark] });

  assert.ok(
    await delivered,
    'the server dropped the latest snapshot because its adaptive 160 ms limit exceeds the client 120 ms interval',
  );
  for (const bot of bots) bot.disconnect();
});
