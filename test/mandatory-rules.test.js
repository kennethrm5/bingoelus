const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const REPO_ROOT = path.resolve(__dirname, '..');
const INDEX_HTML_PATH = path.join(REPO_ROOT, 'servidor', 'public', 'index.html');
const CLIENT_JS_PATH = path.join(REPO_ROOT, 'servidor', 'public', 'cliente.js');

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
  constructor() {
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
    this.classList = new FakeClassList();
    this._innerHTML = '';
    this._textContent = '';
    this.value = '';
    this.title = '';
    this.disabled = false;
    this.checked = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
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
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }
  getAttribute(k) {
    return this.attributes.has(k) ? this.attributes.get(k) : null;
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatchEvent(ev) {
    const eventObj = typeof ev === 'string' ? { type: ev, target: this } : ev;
    for (const fn of this.listeners.get(eventObj.type) || []) fn(eventObj);
  }
  click() {
    this.dispatchEvent({ type: 'click', target: this, stopPropagation() {} });
  }
  querySelectorAll() {
    return [];
  }
  focus() {}
}

function createFakeSocket() {
  const handlers = new Map();
  const emitted = [];
  return {
    id: 'mock-sock-rules-1',
    connected: true,
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(fn);
    },
    emit(ev, payload, ack) {
      emitted.push({ ev, payload, ack });
    },
    disconnect() {
      this.connected = false;
    },
    connect() {
      this.connected = true;
    },
    _trigger(ev, ...args) {
      for (const fn of handlers.get(ev) || []) fn(...args);
    },
    _emitted: emitted,
  };
}

async function runRulesVmScenario({
  localSession = null,
  scrollHeight = 620,
  clientHeight = 280,
  useRaf = true,
} = {}) {
  const store = new Map();
  if (localSession) {
    store.set('bingoelus-player-session', JSON.stringify(localSession));
  }

  let nowMs = 1_000_000;
  let nextTimerId = 1;
  const timers = new Map();
  const rafQueue = [];

  const elements = new Map();
  const knownIds = [
    'pantalla-login', 'pantalla-reglas', 'pantalla-juego', 'btn-entrar', 'msg-espera',
    'nombre-display', 'estado-partida', 'carton', 'btn-linea', 'btn-bingo', 'acciones',
    'notificacion', 'banner-anuncio', 'modal-premio', 'modal-premio-img', 'modal-premio-msg',
    'modal-premio-btn', 'twitch-loading', 'twitch-card', 'twitch-avatar', 'twitch-card-name',
    'twitch-card-login', 'discord-step', 'input-discord', 'discord-error',
    'btn-aceptar-reglas', 'reglas-scroll', 'chk-aceptar-reglas', 'reglas-aceptacion',
    'req-reglas-tiempo', 'req-reglas-scroll', 'req-reglas-check',
  ];
  for (const id of knownIds) {
    const tag = id.startsWith('input') || id.startsWith('chk') ? 'input' : 'div';
    elements.set(id, new FakeElement(tag, id));
  }
  const btnAceptar = elements.get('btn-aceptar-reglas');
  btnAceptar.disabled = true;
  const scrollBox = elements.get('reglas-scroll');
  scrollBox.scrollHeight = scrollHeight;
  scrollBox.clientHeight = clientHeight;

  const docListeners = new Map();
  const winListeners = new Map();
  const mockLocation = { search: '', href: 'https://bingoelus.online/' };
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

  class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [nowMs]));
    }
    static now() {
      return nowMs;
    }
  }

  const sandbox = {
    window: mockWindow,
    document: mockDocument,
    location: mockLocation,
    history: { replaceState() {} },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    navigator: { onLine: true, vibrate: () => {} },
    URLSearchParams,
    fetch: async url => {
      if (String(url).startsWith('/api/casillas')) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (String(url).startsWith('/auth/me')) {
        return { ok: true, status: 200, json: async () => ({ login: 'tester', displayName: 'Tester' }) };
      }
      return { ok: false, status: 404, json: async () => null };
    },
    io: () => mockSocket,
    setTimeout(fn, ms = 0, ...args) {
      const id = nextTimerId++;
      timers.set(id, { id, fn, args, interval: null, nextRun: nowMs + Math.max(0, ms) });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval(fn, ms = 0, ...args) {
      const id = nextTimerId++;
      const step = Math.max(1, ms);
      timers.set(id, { id, fn, args, interval: step, nextRun: nowMs + step });
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    console,
    Date: FakeDate,
    Set,
    Array,
    JSON,
    Number,
    Boolean,
  };
  if (useRaf) {
    sandbox.requestAnimationFrame = fn => {
      rafQueue.push(fn);
      return rafQueue.length;
    };
  }
  sandbox.self = mockWindow;

  const src = fs.readFileSync(CLIENT_JS_PATH, 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'cliente.js' });

  // Flush microtasks for fetch('/auth/me')
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  function flushRaf() {
    while (rafQueue.length > 0) {
      const fn = rafQueue.shift();
      fn(nowMs);
    }
  }

  function advanceTime(ms) {
    const target = nowMs + ms;
    while (true) {
      let nextTimer = null;
      for (const t of timers.values()) {
        if (t.nextRun <= target && (!nextTimer || t.nextRun < nextTimer.nextRun)) {
          nextTimer = t;
        }
      }
      if (!nextTimer) break;
      nowMs = nextTimer.nextRun;
      if (nextTimer.interval === null) {
        timers.delete(nextTimer.id);
      } else {
        nextTimer.nextRun += nextTimer.interval;
      }
      nextTimer.fn(...nextTimer.args);
    }
    nowMs = target;
  }

  return {
    sandbox,
    store,
    elements,
    mockSocket,
    mockDocument,
    timers,
    flushRaf,
    advanceTime,
    triggerWin(ev, payload = {}) {
      for (const fn of winListeners.get(ev) || []) fn(payload);
    },
    evalInVm(expr) {
      return vm.runInContext(expr, sandbox);
    },
  };
}

test('index.html exposes rules scroll container, progress pills, acceptance checkbox, disabled button, and ?v=2.5', () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

  assert.match(html, /id="reglas-scroll"/);
  assert.match(html, /id="reglas-progreso"/);
  assert.match(html, /id="req-reglas-tiempo"/);
  assert.match(html, /id="req-reglas-scroll"/);
  assert.match(html, /id="req-reglas-check"/);
  assert.match(html, /id="reglas-aceptacion"/);
  assert.match(html, /id="chk-aceptar-reglas"/);
  assert.match(html, /<button[^>]*id="btn-aceptar-reglas"[^>]*disabled/);
  assert.match(html, /src="\/cliente\.js\?v=2\.5"/);

  const hoverIdx = html.indexOf('#btn-aceptar-reglas:hover {');
  const disabledIdx = html.indexOf('#btn-aceptar-reglas:disabled');
  assert.ok(hoverIdx !== -1 && disabledIdx !== -1 && disabledIdx > hoverIdx,
    '#btn-aceptar-reglas:disabled CSS rule must follow :hover in cascade');
});

test('mandatory rules gate enforces 10s (paused when hidden), scroll to bottom, checkbox, and preserves called phrases', async () => {
  const env = await runRulesVmScenario({ scrollHeight: 620, clientHeight: 280, useRaf: true });
  const card1 = makeCard('g1');

  env.elements.get('input-discord').value = 'Lylo';
  env.elements.get('btn-entrar').click();

  env.mockSocket._trigger('tu:carton', {
    partidaId: 100,
    carton: card1,
    cantadas: [],
    marcadas: [],
    lineaGanada: false,
    bingoGanado: false,
    reclamacionesHabilitadas: false,
    umbralReclamo: 0,
  });
  env.flushRaf();

  const btn = env.elements.get('btn-aceptar-reglas');
  const scrollBox = env.elements.get('reglas-scroll');
  const chk = env.elements.get('chk-aceptar-reglas');
  const pantallaReglas = env.elements.get('pantalla-reglas');
  const pantallaJuego = env.elements.get('pantalla-juego');

  assert.equal(pantallaReglas.style.display, 'flex');
  assert.equal(pantallaJuego.style.display, 'none');
  assert.equal(btn.disabled, true);
  assert.equal(btn.textContent, 'Lee las reglas (10s)');
  assert.equal(JSON.parse(env.store.get('bingoelus-player-session')).reglasAceptadas, false);

  // Forced click before completing prerequisites must NOT enter game
  btn.click();
  assert.equal(pantallaReglas.style.display, 'flex');
  assert.equal(pantallaJuego.style.display, 'none');

  // Timer must pause when document is hidden
  env.mockDocument.visibilityState = 'hidden';
  env.advanceTime(5000);
  assert.equal(btn.textContent, 'Lee las reglas (10s)');

  // Resume visibility and wait full 10s
  env.mockDocument.visibilityState = 'visible';
  env.advanceTime(10000);
  assert.equal(env.elements.get('req-reglas-tiempo').classList.contains('completado'), true);
  assert.equal(btn.disabled, true);
  assert.equal(btn.textContent, 'Desliza hasta el final de las reglas');

  // Scroll only halfway -> still incomplete
  scrollBox.scrollTop = 100;
  scrollBox.dispatchEvent('scroll');
  assert.equal(env.elements.get('req-reglas-scroll').classList.contains('completado'), false);
  assert.equal(btn.disabled, true);

  // Scroll to bottom -> scroll requirement completed, still needs checkbox
  scrollBox.scrollTop = 335; // 335 + 280 = 615 >= 620 - 12
  scrollBox.dispatchEvent('scroll');
  assert.equal(env.elements.get('req-reglas-scroll').classList.contains('completado'), true);
  assert.equal(btn.disabled, true);
  assert.equal(btn.textContent, 'Marca la casilla para continuar');

  // Check acceptance box -> unlocks continue button
  chk.checked = true;
  chk.dispatchEvent('change');
  assert.equal(env.elements.get('req-reglas-check').classList.contains('completado'), true);
  assert.equal(env.elements.get('reglas-aceptacion').classList.contains('aceptado'), true);
  assert.equal(btn.disabled, false);
  assert.equal(btn.getAttribute('aria-disabled'), 'false');
  assert.equal(btn.textContent, 'Entendido, a jugar');

  // Called and uncalled phrases arriving while reading must be preserved on entry
  env.mockSocket._trigger('partida:frase-cantada', { frase: 'g1-0-0', cantadas: ['g1-0-0', 'g1-0-1'] });
  env.mockSocket._trigger('partida:frase-descantada', { frase: 'g1-0-1', cantadas: ['g1-0-0'] });

  btn.click();
  assert.equal(pantallaReglas.style.display, 'none');
  assert.equal(pantallaJuego.style.display, 'flex');
  assert.equal(env.evalInVm('estado.enPartida'), true);
  assert.equal(env.evalInVm('estado.reglasAceptadas'), true);
  assert.equal(env.evalInVm('estado.cantadas.has("g1-0-0")'), true);
  assert.equal(env.evalInVm('estado.cantadas.has("g1-0-1")'), false);
  assert.equal(JSON.parse(env.store.get('bingoelus-player-session')).reglasAceptadas, true);
});

test('prevents F5 bypass before acceptance, keeps timer on mid-reading reconnect, skips on same-game reconnect, and requires reading again on new game', async () => {
  const card1 = makeCard('g1');
  const card2 = makeCard('g2');

  // A) Reload with reglasAceptadas: false -> must stay on pantalla-reglas, NOT pantalla-juego
  const reloadPending = await runRulesVmScenario({
    localSession: {
      nombre: 'Lylo',
      carton: card1,
      marcadas: [],
      partidaId: 100,
      twitch: 'tester',
      reglasAceptadas: false,
    },
    scrollHeight: 620,
    clientHeight: 280,
  });
  reloadPending.flushRaf();
  assert.equal(reloadPending.elements.get('pantalla-reglas').style.display, 'flex');
  assert.equal(reloadPending.elements.get('pantalla-juego').style.display, 'none');
  assert.equal(reloadPending.elements.get('btn-aceptar-reglas').textContent, 'Lee las reglas (10s)');

  // B) Reconnect receiving tu:carton while reading same game after 4s -> must preserve remaining 6s and scroll
  reloadPending.advanceTime(4000);
  reloadPending.elements.get('reglas-scroll').scrollTop = 335;
  reloadPending.elements.get('reglas-scroll').dispatchEvent('scroll');
  reloadPending.mockSocket._trigger('tu:carton', {
    partidaId: 100,
    carton: card1,
    cantadas: ['g1-0-0'],
    marcadas: [],
    lineaGanada: false,
    bingoGanado: false,
    reclamacionesHabilitadas: false,
    umbralReclamo: 0,
  });
  assert.equal(reloadPending.elements.get('pantalla-reglas').style.display, 'flex');
  assert.equal(reloadPending.elements.get('req-reglas-scroll').classList.contains('completado'), true);
  assert.equal(reloadPending.elements.get('btn-aceptar-reglas').textContent, 'Lee las reglas (6s)');

  // C) Reload AFTER acceptance even with 0 marks -> skips rules straight into pantalla-juego
  const reloadAccepted = await runRulesVmScenario({
    localSession: {
      nombre: 'Lylo',
      carton: card1,
      marcadas: [],
      partidaId: 100,
      twitch: 'tester',
      reglasAceptadas: true,
    },
    scrollHeight: 620,
    clientHeight: 280,
  });
  assert.equal(reloadAccepted.elements.get('pantalla-juego').style.display, 'flex');
  assert.equal(reloadAccepted.elements.get('pantalla-reglas').style.display, 'none');

  reloadAccepted.mockSocket._trigger('tu:carton', {
    partidaId: 100,
    carton: card1,
    cantadas: ['g1-0-0'],
    marcadas: [],
    lineaGanada: false,
    bingoGanado: false,
    reclamacionesHabilitadas: false,
    umbralReclamo: 0,
  });
  assert.equal(reloadAccepted.elements.get('pantalla-juego').style.display, 'flex');
  assert.equal(reloadAccepted.elements.get('pantalla-reglas').style.display, 'none');

  // D) New game starts -> partida:nueva + new tu:carton must require rules reading again
  reloadAccepted.mockSocket._trigger('partida:nueva');
  reloadAccepted.elements.get('btn-entrar').click();
  reloadAccepted.mockSocket._trigger('tu:carton', {
    partidaId: 200,
    carton: card2,
    cantadas: [],
    marcadas: [],
    lineaGanada: false,
    bingoGanado: false,
    reclamacionesHabilitadas: false,
    umbralReclamo: 0,
  });
  reloadAccepted.flushRaf();
  assert.equal(reloadAccepted.elements.get('pantalla-reglas').style.display, 'flex');
  assert.equal(reloadAccepted.elements.get('pantalla-juego').style.display, 'none');
  assert.equal(reloadAccepted.elements.get('btn-aceptar-reglas').disabled, true);
  assert.equal(reloadAccepted.elements.get('btn-aceptar-reglas').textContent, 'Lee las reglas (10s)');
});

test('non-overflow scrollbox auto-satisfies scroll check and ping-estado card swap stays on rules screen when unaccepted', async () => {
  const env = await runRulesVmScenario({ scrollHeight: 250, clientHeight: 300, useRaf: true });
  const card1 = makeCard('g1');
  const card1Alt = makeCard('g1alt');

  env.elements.get('input-discord').value = 'Lylo';
  env.elements.get('btn-entrar').click();
  env.mockSocket._trigger('tu:carton', {
    partidaId: 100,
    carton: card1,
    cantadas: [],
    marcadas: [],
    lineaGanada: false,
    bingoGanado: false,
    reclamacionesHabilitadas: false,
    umbralReclamo: 0,
  });
  env.flushRaf();

  assert.equal(env.elements.get('req-reglas-scroll').classList.contains('completado'), true);
  assert.equal(env.elements.get('btn-aceptar-reglas').disabled, true);

  // Forced pageshow ping-estado returns updated card while unaccepted -> must keep rules gate active
  env.triggerWin('pageshow', { persisted: true });
  const pingCall = env.mockSocket._emitted.find(e => e.ev === 'jugador:ping-estado');
  assert.ok(pingCall);
  pingCall.ack({
    sesionValida: true,
    partidaActiva: true,
    partidaId: 100,
    registrado: true,
    carton: card1Alt,
    cantadas: ['g1alt-0-0'],
    marcadas: [],
    reclamacionesHabilitadas: false,
    umbralReclamo: 0,
  });
  env.flushRaf();
  assert.equal(env.elements.get('pantalla-reglas').style.display, 'flex');
  assert.equal(env.elements.get('pantalla-juego').style.display, 'none');

  env.advanceTime(10000);
  const chk = env.elements.get('chk-aceptar-reglas');
  chk.checked = true;
  chk.dispatchEvent('change');
  assert.equal(env.elements.get('btn-aceptar-reglas').disabled, false);

  env.elements.get('btn-aceptar-reglas').click();
  assert.equal(env.elements.get('pantalla-juego').style.display, 'flex');
  assert.equal(env.evalInVm('estado.cantadas.has("g1alt-0-0")'), true);
});
