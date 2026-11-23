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
const CLIENT_JS_PATH = path.join(REPO_ROOT, 'servidor', 'public', 'cliente.js');
const INDEX_HTML_PATH = path.join(REPO_ROOT, 'servidor', 'public', 'index.html');
const MODERADOR_HTML_PATH = path.join(REPO_ROOT, 'servidor', 'public', 'moderador.html');
const GESTOR_HTML_PATH = path.join(REPO_ROOT, 'gestor.html');

function leerGestorToken() {
  try {
    const fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (fileCfg && typeof fileCfg.gestorToken === 'string' && fileCfg.gestorToken) {
      return fileCfg.gestorToken;
    }
  } catch {
    // Usar token de prueba si no existe config.json
  }
  return 'iphone-sync-test-token';
}

const activeSockets = new Set();
const activeServers = new Set();
const tempDirs = new Set();

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
      PERSIST_STATE: '0',
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
  const done = await Promise.race([
    exited.then(() => true),
    delay(2500).then(() => false),
  ]);
  if (!done && proc.exitCode === null) {
    proc.kill('SIGKILL');
    await exited;
  }
}

function trackSocket(sock) {
  activeSockets.add(sock);
  return sock;
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

function makeCard(prefix = 'f') {
  const rows = [];
  for (let r = 0; r < 5; r++) {
    const row = [];
    for (let c = 0; c < 5; c++) row.push(`${prefix}-${r}-${c}`);
    rows.push(row);
  }
  return rows;
}

class FakeClassList {
  constructor(owner) {
    this._owner = owner;
    this._set = new Set();
  }
  _syncFromString(str) {
    this._set = new Set(String(str || '').split(/\s+/).filter(Boolean));
  }
  _toString() {
    return [...this._set].join(' ');
  }
  add(...tokens) {
    tokens.filter(Boolean).forEach(t => this._set.add(t));
  }
  remove(...tokens) {
    tokens.forEach(t => this._set.delete(t));
  }
  contains(token) {
    return this._set.has(token);
  }
  toggle(token, force) {
    if (force === true) { this._set.add(token); return true; }
    if (force === false) { this._set.delete(token); return false; }
    if (this._set.has(token)) { this._set.delete(token); return false; }
    this._set.add(token);
    return true;
  }
}

class FakeElement {
  constructor(tagName = 'div', id = '') {
    this.tagName = String(tagName).toUpperCase();
    this.id = id;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = { cssText: '' };
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
    this._innerHTML = '';
    this._textContent = '';
    this.value = '';
    this.title = '';
    this.disabled = false;
    this.type = '';
    this.src = '';
    this.alt = '';
  }
  get className() {
    return this.classList._toString();
  }
  set className(val) {
    this.classList._syncFromString(val);
  }
  get innerHTML() {
    return this._innerHTML;
  }
  set innerHTML(val) {
    this._innerHTML = String(val || '');
    for (const child of this.children) child.parentNode = null;
    this.children = [];
  }
  get textContent() {
    if (this.children.length > 0 && !this._textContent) {
      return this.children.map(c => c.textContent).join('');
    }
    return this._textContent;
  }
  set textContent(val) {
    this._textContent = String(val ?? '');
    this.children = [];
  }
  get childElementCount() {
    return this.children.length;
  }
  get lastChild() {
    return this.children[this.children.length - 1] || null;
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
    if (k === 'data-frase') this.dataset.frase = String(v);
  }
  getAttribute(k) {
    return this.attributes.has(k) ? this.attributes.get(k) : null;
  }
  appendChild(child) {
    if (child.parentNode && child.parentNode !== this) {
      child.parentNode.removeChild(child);
    } else if (child.parentNode === this) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) this.children.splice(idx, 1);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  prepend(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.unshift(child);
    return child;
  }
  insertBefore(newNode, refNode) {
    if (!refNode) return this.appendChild(newNode);
    if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
    const idx = this.children.indexOf(refNode);
    if (idx === -1) return this.appendChild(newNode);
    newNode.parentNode = this;
    this.children.splice(idx, 0, newNode);
    return newNode;
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._textContent = '';
    for (const node of nodes) this.appendChild(node);
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatchEvent(ev) {
    const list = this.listeners.get(ev.type) || [];
    for (const fn of list) fn(ev);
  }
  click() {
    this.dispatchEvent({ type: 'click', target: this, stopPropagation() {} });
  }
  querySelectorAll(selector) {
    const results = [];
    const match = (el) => {
      if (selector.startsWith('.')) {
        const classes = selector.slice(1).split('.');
        return classes.every(cls => el.classList.contains(cls));
      }
      if (selector.startsWith('[data-id="') && selector.endsWith('"]')) {
        const expected = selector.slice(10, -2);
        return el.dataset && el.dataset.id === expected;
      }
      return el.tagName === selector.toUpperCase();
    };
    const walk = (node) => {
      for (const child of node.children) {
        if (match(child)) results.push(child);
        walk(child);
      }
    };
    walk(this);
    return results;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  focus() {}
}

function createFakeSocket() {
  const handlers = new Map();
  const ioHandlers = new Map();
  const emitted = [];
  const socket = {
    id: 'mock-sock-1',
    connected: true,
    disconnectCount: 0,
    connectCount: 0,
    io: {
      on(ev, fn) {
        if (!ioHandlers.has(ev)) ioHandlers.set(ev, []);
        ioHandlers.get(ev).push(fn);
      },
      emitLocal(ev, ...args) {
        for (const fn of ioHandlers.get(ev) || []) fn(...args);
      },
    },
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(fn);
    },
    emit(ev, payload, ack) {
      emitted.push({ ev, payload, ack });
    },
    disconnect() {
      socket.connected = false;
      socket.disconnectCount += 1;
    },
    connect() {
      socket.connected = true;
      socket.connectCount += 1;
    },
    removeAllListeners() {
      handlers.clear();
    },
    _trigger(ev, ...args) {
      for (const fn of handlers.get(ev) || []) fn(...args);
    },
    _emitted: emitted,
  };
  return socket;
}

afterEach(async () => {
  for (const sock of activeSockets) sock.disconnect();
  activeSockets.clear();
  for (const proc of [...activeServers]) await stopServer(proc);
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test('HTTP routes return Cache-Control: no-store and /jugador redirects unauthenticated users like /', async () => {
  const tmpDir = createTempDir('bingoelus-http-');
  const port = await getFreePort();
  const sessionSecret = 'http-test-secret';
  const validCookie = signHmacSessionCookie(sessionSecret, {
    login: 'joelus_player',
    displayName: 'JoelusPlayer',
    exp: Math.floor(Date.now() / 1000) + 3600,
  });

  const { url } = await startServer({
    port,
    tmpDir,
    envOverrides: {
      TWITCH_CLIENT_ID: 'dummy-twitch-client-id',
      TWITCH_CLIENT_SECRET: 'dummy-twitch-client-secret',
      SESSION_SECRET: sessionSecret,
      ALLOW_STRESS_BOTS: '0',
    },
  });

  for (const route of ['/', '/jugador', '/jugador.html']) {
    const resp = await fetch(`${url}${route}`, { redirect: 'manual' });
    assert.equal(resp.status, 302, `${route} without Twitch cookie must redirect`);
    assert.equal(resp.headers.get('location'), '/auth/twitch');
    assert.match(resp.headers.get('cache-control') || '', /no-store/);
    assert.equal(resp.headers.get('pragma'), 'no-cache');
  }

  for (const route of ['/', '/jugador', '/moderador', '/api/casillas', '/auth/me']) {
    const resp = await fetch(`${url}${route}`, {
      headers: { Cookie: `twitch_sid=${validCookie}` },
      redirect: 'manual',
    });
    assert.equal(resp.status, 200, `${route} should respond 200`);
    assert.match(resp.headers.get('cache-control') || '', /no-store/);
    if (route === '/auth/me') {
      const me = await resp.json();
      assert.deepEqual(me, { login: 'joelus_player', displayName: 'JoelusPlayer' });
    }
  }

  const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  assert.match(indexHtml, /\/cliente\.js\?v=2\.4/);
});

test('server validates cards against active phrases, increases partidaId, handles ping-estado and protects against zombie disconnects', async () => {
  const tmpDir = createTempDir('bingoelus-server-sync-');
  const port = await getFreePort();
  const sessionSecret = 'socket-sync-secret';
  const cookieHeader = `twitch_sid=${signHmacSessionCookie(sessionSecret, {
    login: 'iphone_user',
    displayName: 'iPhoneUser',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;

  const { url, gestorToken } = await startServer({
    port,
    tmpDir,
    envOverrides: {
      SESSION_SECRET: sessionSecret,
      ALLOW_STRESS_BOTS: '0',
    },
  });

  const manager = trackSocket(io(`${url}/gestor`, {
    auth: { token: gestorToken },
    transports: ['websocket'],
    reconnection: false,
  }));
  await waitFor(manager, 'estado:actual');

  // Unauthenticated / pre-game connection should receive servidor:estado-partida (partidaActiva: false)
  const playerPre = trackSocket(io(`${url}/jugador`, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    extraHeaders: { Cookie: cookieHeader },
  }));
  const initState = await waitFor(playerPre, 'servidor:estado-partida');
  assert.equal(initState.partidaActiva, false);
  assert.equal(initState.partidaId, 0);

  const errNoPartidaPromise = waitFor(playerPre, 'partida:error');
  playerPre.emit('jugador:unirse', { nombre: 'iPhoneUser', token: 'iphone-tok-0001' });
  const errNoPartida = await errNoPartidaPromise;
  assert.equal(errNoPartida.code, 'NO_PARTIDA');
  playerPre.disconnect();

  // Start Game 1
  const frases1 = Array.from({ length: 25 }, (_, i) => `g1-frase-${i}`);
  const started1 = waitFor(manager, 'estado:actual', s => s.partidaActiva);
  manager.emit('gestor:iniciar-partida', { frases: frases1 });
  await started1;

  const sock1 = trackSocket(io(`${url}/jugador`, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    extraHeaders: { Cookie: cookieHeader },
  }));
  const state1Promise = waitFor(sock1, 'servidor:estado-partida');
  await waitFor(sock1, 'connect');
  const state1 = await state1Promise;
  assert.equal(state1.partidaActiva, true);
  assert.ok(state1.partidaId > 0);

  const card1Promise = waitFor(sock1, 'tu:carton');
  sock1.emit('jugador:unirse', { nombre: 'iPhoneUser', token: 'iphone-tok-0001' });
  const card1 = await card1Promise;
  assert.equal(card1.partidaId, state1.partidaId);
  assert.ok(card1.carton.flat().every(f => frases1.includes(f)));

  // Mark phrase A on socket 1
  const markA = card1.carton[0][0];
  const markB = card1.carton[0][1];
  const mgrMarkA = waitFor(manager, 'partida:marcadas-actualizadas', d => d.marcadas.includes(markA));
  sock1.emit('jugador:actualizar-marcadas', { marcadas: [markA] });
  await mgrMarkA;

  // Ping state check on active socket
  const pingResp = await new Promise(resolve => sock1.emit('jugador:ping-estado', {}, resolve));
  assert.equal(pingResp.ok, true);
  assert.equal(pingResp.registrado, true);
  assert.equal(pingResp.sesionValida, true);
  assert.equal(pingResp.partidaId, state1.partidaId);
  assert.deepEqual(pingResp.marcadas, [markA]);

  // Duplicate / zombie replacement: connect sock2 for the SAME Twitch login while sock1 is still open
  const sock2 = trackSocket(io(`${url}/jugador`, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    extraHeaders: { Cookie: cookieHeader },
  }));
  await waitFor(sock2, 'connect');
  const sock1Disconnected = waitFor(sock1, 'disconnect');
  const card2Promise = waitFor(sock2, 'tu:carton');
  sock2.emit('jugador:unirse', { nombre: 'iPhoneUser', token: 'iphone-tok-0002' });
  const card2 = await card2Promise;
  await sock1Disconnected;
  assert.deepEqual(card2.carton, card1.carton);
  assert.deepEqual(card2.marcadas, [markA]);

  // sock2 adds markB; sock1's disconnect must NOT overwrite markB back to [markA]
  const mgrMarkB = waitFor(manager, 'partida:marcadas-actualizadas', d => d.marcadas.includes(markB));
  sock2.emit('jugador:actualizar-marcadas', { marcadas: [markA, markB] });
  await mgrMarkB;

  const sock3 = trackSocket(io(`${url}/jugador`, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    extraHeaders: { Cookie: cookieHeader },
  }));
  await waitFor(sock3, 'connect');
  const card3Promise = waitFor(sock3, 'tu:carton');
  sock3.emit('jugador:unirse', { nombre: 'iPhoneUser', token: 'iphone-tok-0003' });
  const card3 = await card3Promise;
  assert.deepEqual(card3.marcadas, [markA, markB]);

  // Start Game 2 with completely new phrases and verify strict partidaId increment & fresh card
  const frases2 = Array.from({ length: 25 }, (_, i) => `g2-frase-${i}`);
  const nuevaGame2 = waitFor(sock3, 'partida:nueva');
  const started2 = waitFor(manager, 'estado:actual', s => s.partidaActiva && s.frases[0] === 'g2-frase-0');
  manager.emit('gestor:iniciar-partida', { frases: frases2 });
  const [nuevaPayload] = await Promise.all([nuevaGame2, started2]);
  assert.ok(nuevaPayload.partidaId > state1.partidaId, 'partidaId must strictly increase on new game');
  assert.equal(nuevaPayload.partidaActiva, true);

  const cardNewGamePromise = waitFor(sock3, 'tu:carton');
  sock3.emit('jugador:unirse', { nombre: 'iPhoneUser', token: 'iphone-tok-0003' });
  const cardNewGame = await cardNewGamePromise;
  assert.equal(cardNewGame.partidaId, nuevaPayload.partidaId);
  assert.deepEqual(cardNewGame.marcadas, []);
  assert.ok(cardNewGame.carton.flat().every(f => frases2.includes(f)));

  // Reset game verifies partidaId: 0 and partidaActiva: false
  const resetNotif = waitFor(sock3, 'partida:nueva');
  manager.emit('gestor:resetear');
  const resetPayload = await resetNotif;
  assert.equal(resetPayload.partidaId, 0);
  assert.equal(resetPayload.partidaActiva, false);
});

async function runClientVmScenario({
  localSession = null,
  search = '',
  authMeResult = { login: 'tester', displayName: 'Tester' },
} = {}) {
  const store = new Map();
  if (localSession) {
    store.set('bingoelus-player-session', JSON.stringify(localSession));
  }

  const elements = new Map();
  const knownIds = [
    'pantalla-login', 'pantalla-reglas', 'pantalla-juego', 'btn-entrar', 'msg-espera',
    'nombre-display', 'estado-partida', 'carton', 'btn-linea', 'btn-bingo', 'acciones',
    'notificacion', 'banner-anuncio', 'modal-premio', 'modal-premio-img', 'modal-premio-msg',
    'modal-premio-btn', 'twitch-loading', 'twitch-card', 'twitch-avatar', 'twitch-card-name',
    'twitch-card-login', 'twitch-card-info', 'discord-step', 'input-discord', 'discord-error',
    'btn-aceptar-reglas',
  ];
  for (const id of knownIds) {
    elements.set(id, new FakeElement(id.startsWith('input') ? 'input' : 'div', id));
  }

  const docListeners = new Map();
  const winListeners = new Map();
  const mockLocation = { search, href: 'https://bingoelus.online/' };
  const mockSocket = createFakeSocket();

  const mockDocument = {
    visibilityState: 'visible',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement('div', id));
      return elements.get(id);
    },
    createElement(tag) {
      return new FakeElement(tag);
    },
    addEventListener(ev, fn) {
      if (!docListeners.has(ev)) docListeners.set(ev, []);
      docListeners.get(ev).push(fn);
    },
  };

  const mockWindow = {
    location: mockLocation,
    addEventListener(ev, fn) {
      if (!winListeners.has(ev)) winListeners.set(ev, []);
      winListeners.get(ev).push(fn);
    },
  };

  const sandbox = {
    window: mockWindow,
    document: mockDocument,
    location: mockLocation,
    history: { replaceState() {} },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    navigator: { onLine: true, vibrate: () => {} },
    URLSearchParams,
    fetch: async (url) => {
      if (String(url).startsWith('/api/casillas')) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (String(url).startsWith('/auth/me')) {
        return { ok: true, status: 200, json: async () => authMeResult };
      }
      return { ok: false, status: 404, json: async () => null };
    },
    io: () => mockSocket,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    Date,
    Set,
    Array,
    JSON,
  };
  sandbox.self = mockWindow;

  const src = fs.readFileSync(CLIENT_JS_PATH, 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'cliente.js' });
  await delay(20);

  return {
    sandbox,
    store,
    elements,
    mockSocket,
    mockLocation,
    mockDocument,
    triggerDoc(ev, payload = {}) {
      for (const fn of docListeners.get(ev) || []) fn(payload);
    },
    triggerWin(ev, payload = {}) {
      for (const fn of winListeners.get(ev) || []) fn(payload);
    },
  };
}

test('cliente.js redirects to /auth/twitch on missing session, clears stale local card on new game, and probes zombie sockets on wake-up', async () => {
  const oldCard = makeCard('old');
  const newCard = makeCard('new');

  // 1) Stale card saved in localStorage + expired Twitch session without twitch_error -> must redirect to /auth/twitch
  const noSess = await runClientVmScenario({
    localSession: { nombre: 'Lylo', carton: oldCard, marcadas: ['old-0-0'], partidaId: 100, twitch: 'lylo' },
    authMeResult: null,
    search: '',
  });
  assert.equal(noSess.mockLocation.href, '/auth/twitch');

  // 2) twitch_error in query string -> must display error and NOT auto-redirect in a loop
  const oauthErr = await runClientVmScenario({
    localSession: null,
    authMeResult: null,
    search: '?twitch_error=estado_invalido',
  });
  assert.equal(oauthErr.mockLocation.href, 'https://bingoelus.online/');
  assert.match(oauthErr.elements.get('twitch-loading').innerHTML, /Reintentar con Twitch/);

  // 3) Stale card from Game 100 restored locally -> servidor:estado-partida says Game 200 is active -> resets UI & localStorage
  const staleReset = await runClientVmScenario({
    localSession: { nombre: 'Lylo', carton: oldCard, marcadas: ['old-0-0'], partidaId: 100, twitch: 'tester' },
    authMeResult: { login: 'tester', displayName: 'Tester' },
  });
  assert.equal(staleReset.elements.get('pantalla-juego').style.display, 'flex');
  staleReset.mockSocket._trigger('servidor:estado-partida', { partidaActiva: true, partidaId: 200, bingoGanado: false });
  assert.equal(staleReset.elements.get('pantalla-juego').style.display, 'none');
  assert.equal(staleReset.elements.get('pantalla-login').style.display, 'flex');
  assert.equal(staleReset.elements.get('carton').innerHTML, '');
  assert.equal(staleReset.store.has('bingoelus-player-session'), false);
  assert.equal(staleReset.elements.get('input-discord').value, 'Lylo');

  // 4) tu:carton with a brand-new card while pantalla-juego was visible -> hides pantalla-juego and opens pantalla-reglas
  const newCardView = await runClientVmScenario({
    localSession: { nombre: 'Lylo', carton: oldCard, marcadas: ['old-0-0'], partidaId: 100, twitch: 'tester' },
    authMeResult: { login: 'tester', displayName: 'Tester' },
  });
  newCardView.mockSocket._trigger('tu:carton', {
    partidaId: 200,
    carton: newCard,
    cantadas: [],
    marcadas: [],
    lineaGanada: false,
    bingoGanado: false,
    reclamacionesHabilitadas: false,
    umbralReclamo: 0,
  });
  assert.equal(newCardView.elements.get('pantalla-juego').style.display, 'none');
  assert.equal(newCardView.elements.get('pantalla-reglas').style.display, 'flex');
  assert.equal(JSON.parse(newCardView.store.get('bingoelus-player-session')).partidaId, 200);

  // 5) partida:error unlocks retry, and NO_PARTIDA clears stale local card
  const errRetry = await runClientVmScenario({
    localSession: { nombre: 'Lylo', carton: oldCard, marcadas: ['old-0-0'], partidaId: 100, twitch: 'tester' },
    authMeResult: { login: 'tester', displayName: 'Tester' },
  });
  const emitsBefore = errRetry.mockSocket._emitted.filter(e => e.ev === 'jugador:unirse').length;
  errRetry.mockSocket._trigger('partida:error', { code: 'NOMBRE_DUPLICADO', msg: 'En uso' });
  errRetry.mockSocket._trigger('connect');
  const emitsAfter = errRetry.mockSocket._emitted.filter(e => e.ev === 'jugador:unirse').length;
  assert.equal(emitsAfter, emitsBefore + 1, 'connect after partida:error should not remain locked by _unionSocketId');

  errRetry.mockSocket._trigger('partida:error', { code: 'NO_PARTIDA', msg: 'No hay ninguna partida activa.' });
  assert.equal(errRetry.elements.get('pantalla-juego').style.display, 'none');
  assert.equal(errRetry.elements.get('pantalla-login').style.display, 'flex');
  assert.equal(errRetry.store.has('bingoelus-player-session'), false);

  // 6) Zombie socket on iPhone BFCache pageshow -> ping-estado times out -> disconnect + connect forced
  const zombieWake = await runClientVmScenario({
    localSession: null,
    authMeResult: { login: 'tester', displayName: 'Tester' },
  });
  zombieWake.elements.get('input-discord').value = 'Lylo';
  zombieWake.elements.get('btn-entrar').click();
  zombieWake.mockSocket._trigger('tu:carton', {
    partidaId: 300,
    carton: newCard,
    cantadas: [],
    marcadas: ['new-0-0'],
    lineaGanada: false,
    bingoGanado: false,
    reclamacionesHabilitadas: false,
    umbralReclamo: 0,
  });
  const dcBefore = zombieWake.mockSocket.disconnectCount;
  const connBefore = zombieWake.mockSocket.connectCount;
  zombieWake.triggerWin('pageshow', { persisted: true });
  const ping = zombieWake.mockSocket._emitted.find(e => e.ev === 'jugador:ping-estado');
  assert.ok(ping, 'pageshow persisted should emit jugador:ping-estado');
  // Do NOT call ping.ack -> simulate zombie socket timeout (> 2500ms)
  await delay(2650);
  assert.equal(zombieWake.mockSocket.disconnectCount, dcBefore + 1);
  assert.equal(zombieWake.mockSocket.connectCount, connBefore + 1);
});

function executeAdminPanelScript(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const matches = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(matches.length > 0);
  const scriptSrc = matches[matches.length - 1][1];

  const elements = new Map();
  const mockSocket = createFakeSocket();
  const store = new Map();

  const mockDocument = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement('div', id));
      return elements.get(id);
    },
    createElement(tag) {
      return new FakeElement(tag);
    },
    querySelectorAll(sel) {
      return mockDocument.getElementById('lista-jugadores').querySelectorAll(sel);
    },
    addEventListener() {},
  };

  const sandbox = {
    window: { addEventListener() {}, location: { origin: 'https://bingoelus.online' } },
    document: mockDocument,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    Audio: class { play() { return Promise.resolve(); } },
    YT: { PlayerState: { PLAYING: 1, BUFFERING: 3, ENDED: 0, UNSTARTED: -1, CUED: 5, PAUSED: 2 } },
    io: () => mockSocket,
    confirm: () => true,
    alert: () => {},
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout,
    clearTimeout,
    console,
    Date,
    Set,
    Map,
    Array,
    JSON,
  };
  vm.createContext(sandbox);
  vm.runInContext(scriptSrc, sandbox, { filename: path.basename(htmlPath) });
  sandbox.document.getElementById('input-srv-url').value = 'https://bingoelus.online';
  sandbox.document.getElementById('input-gestor-token').value = 'tok';
  sandbox.window.conectar();
  return { html, sandbox, elements, mockSocket };
}

test('moderador.html and gestor.html reconcile player rows in place without avatar flicker or log spam', () => {
  const mod = executeAdminPanelScript(MODERADOR_HTML_PATH);
  assert.match(mod.html, /<meta name="color-scheme" content="dark"/);
  assert.match(mod.html, /color-scheme:\s*dark;/);
  assert.match(mod.html, /\.jugador-avatar\s*\{/);
  assert.equal(/avatar\.style\.cssText/.test(mod.html), false);

  const gestor = executeAdminPanelScript(GESTOR_HTML_PATH);
  assert.match(gestor.html, /<meta name="color-scheme" content="dark"/);
  assert.match(gestor.html, /color-scheme:\s*dark;/);

  for (const panel of [mod, gestor]) {
    const cardA = makeCard('a');
    const cardB = makeCard('b');
    const cardC = makeCard('c');
    const initialState = {
      frases: cardA.flat(),
      cantadas: [],
      verificadas: [],
      olvidadas: [],
      modo: 'completo',
      totalJugadores: 3,
      online: 3,
      cuentasBaneadas: [],
      partidaActiva: true,
      reclamacionesHabilitadas: true,
      umbralReclamo: 0,
      jugadores: [
        { socketId: 's2', nombre: 'Beta', twitch: 'beta', twitchVerified: true, carton: cardB, marcadas: [], cantadoLinea: false, cantadoBingo: false, online: true },
        { socketId: 's1', nombre: 'Alfa', twitch: 'alfa', twitchVerified: true, carton: cardA, marcadas: [], cantadoLinea: false, cantadoBingo: false, online: true },
        { socketId: 's3', nombre: 'Gamma', twitch: 'gamma', twitchVerified: true, carton: cardC, marcadas: [], cantadoLinea: false, cantadoBingo: false, online: true },
      ],
    };

    panel.mockSocket._trigger('estado:actual', initialState);

    const lista = panel.elements.get('lista-jugadores');
    assert.deepEqual(lista.children.map(el => el.dataset.id), ['s1', 's2', 's3'], 'tied players must sort deterministically');

    const rowS1Before = lista.querySelector('[data-id="s1"]');
    const avatarS1Before = rowS1Before.querySelector('.jugador-avatar');
    assert.ok(avatarS1Before, 'player row must render .jugador-avatar');

    // Open accordion on s1
    rowS1Before.querySelector('.jugador-cabecera').click();
    assert.equal(rowS1Before.classList.contains('abierto'), true);

    // Emit three consecutive player updates (same count 3, only slight change)
    for (let i = 0; i < 3; i++) {
      panel.mockSocket._trigger('partida:jugador-unido', {
        modo: 'completo',
        totalJugadores: 3,
        online: 3,
        jugadores: initialState.jugadores,
      });
    }

    const rowS1After = lista.querySelector('[data-id="s1"]');
    const avatarS1After = rowS1After.querySelector('.jugador-avatar');
    assert.equal(rowS1After, rowS1Before, 'existing .jugador-fila node must be reused without recreation');
    assert.equal(avatarS1After, avatarS1Before, 'existing .jugador-avatar node must remain untouched');
    assert.equal(rowS1After.classList.contains('abierto'), true, 'open accordion state must survive updates');

    const logChildren = panel.elements.get('log-eventos').children.map(el => el.textContent);
    const connLogs = logChildren.filter(txt => txt.includes('3 jugador(es) conectado(s).'));
    assert.equal(connLogs.length, 1, 'repeated identical online counts must not spam log-eventos');
  }
});
