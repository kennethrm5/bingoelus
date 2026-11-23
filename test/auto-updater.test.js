const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { crearControladorActualizacion } = require('../updater');

const REPO_ROOT = path.resolve(__dirname, '..');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createFakeEnvironment({ isPackaged = true, checkImpl = async () => null } = {}) {
  const createdWindows = [];
  const dialogCalls = [];
  const quitAndInstallCalls = [];
  const logs = [];
  let checkCount = 0;

  class FakeWebContents extends EventEmitter {
    constructor() {
      super();
      this.sent = [];
    }
    send(channel, payload) {
      this.sent.push({ channel, payload });
    }
  }

  class FakeBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new FakeWebContents();
      this.loadedUrls = [];
      this.visible = options?.show !== false;
      this.minimized = false;
      this.focused = false;
      this.destroyed = false;
      this.menuRemoved = false;
      createdWindows.push(this);
    }
    removeMenu() {
      this.menuRemoved = true;
    }
    loadURL(url) {
      this.loadedUrls.push(url);
    }
    hide() {
      this.visible = false;
    }
    show() {
      this.visible = true;
    }
    restore() {
      this.minimized = false;
    }
    focus() {
      this.focused = true;
    }
    isMinimized() {
      return this.minimized;
    }
    isDestroyed() {
      return this.destroyed;
    }
    close() {
      let prevented = false;
      this.emit('close', {
        preventDefault() {
          prevented = true;
        },
      });
      if (!prevented) {
        this.destroyed = true;
        this.emit('closed');
      }
      return !prevented;
    }
  }

  const mainWindow = new FakeBrowserWindow({ show: true });
  // Remove the main window from createdWindows tracking for updater windows
  createdWindows.length = 0;

  const app = new EventEmitter();
  app.isPackaged = isPackaged;
  app.getVersion = () => '4.1.1';

  const autoUpdater = new EventEmitter();
  autoUpdater.checkForUpdates = () => {
    checkCount += 1;
    return checkImpl();
  };
  autoUpdater.quitAndInstall = (isSilent, isForceRunAfter) => {
    quitAndInstallCalls.push({ isSilent, isForceRunAfter });
  };

  const dialog = {
    async showMessageBox(win, opts) {
      dialogCalls.push({ win, opts });
      return { response: 0 };
    },
  };

  const logger = {
    info: (...args) => logs.push({ level: 'info', args }),
    warn: (...args) => logs.push({ level: 'warn', args }),
    error: (...args) => logs.push({ level: 'error', args }),
  };

  const ctrl = crearControladorActualizacion({
    app,
    BrowserWindow: FakeBrowserWindow,
    dialog,
    autoUpdater,
    getMainWindow: () => mainWindow,
    getBaseUrl: () => 'http://127.0.0.1:45123',
    iconPath: path.join(REPO_ROOT, 'media', 'bingoelus-app-icon.png'),
    preloadPath: path.join(REPO_ROOT, 'preload.js'),
    logger,
    restartDelayMs: 25,
  });

  return {
    app,
    autoUpdater,
    mainWindow,
    createdWindows,
    dialogCalls,
    quitAndInstallCalls,
    logs,
    ctrl,
    getCheckCount: () => checkCount,
  };
}

test('packaging, preload bridge, updater.html, and main.js wire GitHub auto-updater cleanly', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies['electron-updater'], 'electron-updater must be in runtime dependencies');
  assert.match(pkg.scripts.dist, /--publish never/);
  assert.deepEqual(pkg.build.publish, [
    { provider: 'github', owner: 'kennethrm5', repo: 'bingoelus' },
  ]);
  assert.ok(pkg.build.files.includes('updater.js'));
  assert.ok(pkg.build.files.includes('updater.html'));
  assert.ok(!pkg.build.win?.publisherName, 'unsigned builds must omit publisherName');

  const preload = fs.readFileSync(path.join(REPO_ROOT, 'preload.js'), 'utf8');
  assert.match(preload, /contextBridge\.exposeInMainWorld\('bingoelusUpdater'/);
  assert.match(preload, /updater:estado/);

  const updaterHtml = fs.readFileSync(path.join(REPO_ROOT, 'updater.html'), 'utf8');
  assert.match(updaterHtml, /Actualizando Bingoelus/);
  assert.match(updaterHtml, /id="upd-version"/);
  assert.match(updaterHtml, /id="upd-mensaje"/);
  assert.match(updaterHtml, /id="upd-barra"/);
  assert.match(updaterHtml, /id="upd-porcentaje"/);
  assert.match(updaterHtml, /id="upd-detalle"/);
  assert.match(updaterHtml, /window\.bingoelusUpdater/);
  assert.equal(/\.innerHTML\s*=/.test(updaterHtml), false);

  const mainSrc = fs.readFileSync(path.join(REPO_ROOT, 'main.js'), 'utf8');
  assert.match(mainSrc, /xApp\.get\('\/updater'/);
  assert.match(mainSrc, /crearControladorActualizacion/);
  assert.match(mainSrc, /iniciarComprobacionAlArranque/);
});

test('skips auto-update check in development and handles up-to-date or silent check errors without interrupting startup', async () => {
  const devEnv = createFakeEnvironment({ isPackaged: false });
  assert.equal(devEnv.ctrl.iniciarComprobacionAlArranque(), false);
  assert.equal(devEnv.getCheckCount(), 0);
  devEnv.ctrl.destruir();

  const upToDateEnv = createFakeEnvironment({ isPackaged: true });
  assert.equal(upToDateEnv.ctrl.iniciarComprobacionAlArranque(), true);
  assert.equal(upToDateEnv.getCheckCount(), 1);
  upToDateEnv.autoUpdater.emit('update-not-available', { version: '4.1.1' });
  assert.equal(upToDateEnv.createdWindows.length, 0);
  assert.equal(upToDateEnv.mainWindow.visible, true);
  upToDateEnv.ctrl.destruir();

  const offlineEnv = createFakeEnvironment({
    isPackaged: true,
    checkImpl: async () => {
      throw new Error('net::ERR_NAME_NOT_RESOLVED');
    },
  });
  assert.equal(offlineEnv.ctrl.iniciarComprobacionAlArranque(), true);
  await delay(15);
  offlineEnv.autoUpdater.emit('error', new Error('404 Not Found latest.yml'));
  assert.equal(offlineEnv.createdWindows.length, 0);
  assert.equal(offlineEnv.dialogCalls.length, 0);
  assert.equal(offlineEnv.mainWindow.visible, true);
  offlineEnv.ctrl.destruir();
});

test('update-available opens dedicated updater window, streams progress, blocks early close, and restarts silently after download', async () => {
  const env = createFakeEnvironment({ isPackaged: true });
  env.ctrl.iniciarComprobacionAlArranque();

  env.autoUpdater.emit('update-available', { version: '4.2.0' });
  assert.equal(env.mainWindow.visible, false, 'mainWindow must hide while updater window is shown');
  assert.equal(env.createdWindows.length, 1);

  const updWin = env.createdWindows[0];
  assert.equal(updWin.loadedUrls[0], 'http://127.0.0.1:45123/updater');
  assert.equal(updWin.options.webPreferences.contextIsolation, true);
  assert.equal(updWin.options.webPreferences.nodeIntegration, false);
  assert.equal(updWin.options.closable, false);

  // Trying to close while updating must be prevented
  assert.equal(updWin.close(), false);
  assert.equal(updWin.isDestroyed(), false);

  // Initial state must be pushed again on did-finish-load
  updWin.webContents.emit('did-finish-load');
  const afterLoad = updWin.webContents.sent.at(-1);
  assert.equal(afterLoad.channel, 'updater:estado');
  assert.equal(afterLoad.payload.version, '4.2.0');
  assert.equal(afterLoad.payload.fase, 'descargando');

  env.autoUpdater.emit('download-progress', {
    percent: 42.4,
    transferred: 44_040_192,
    total: 104_857_600,
    bytesPerSecond: 5_242_880,
  });
  const afterProgress = updWin.webContents.sent.at(-1);
  assert.equal(afterProgress.payload.porcentaje, 42);
  assert.match(afterProgress.payload.detalle, /42\.0 \/ 100\.0 MB · 5\.0 MB\/s/);

  env.autoUpdater.emit('update-downloaded', { version: '4.2.0' });
  const afterDownloaded = updWin.webContents.sent.at(-1);
  assert.equal(afterDownloaded.payload.fase, 'instalando');
  assert.equal(afterDownloaded.payload.porcentaje, 100);
  assert.match(afterDownloaded.payload.mensaje, /Reiniciando Bingoelus/);

  await delay(60);
  assert.deepEqual(env.quitAndInstallCalls, [{ isSilent: true, isForceRunAfter: true }]);
  assert.equal(updWin.close(), true);
  env.ctrl.destruir();
});

test('download error closes updater window, restores mainWindow, and shows warning dialog', async () => {
  const env = createFakeEnvironment({ isPackaged: true });
  env.ctrl.iniciarComprobacionAlArranque();

  env.autoUpdater.emit('update-available', { version: '4.2.0' });
  const updWin = env.createdWindows[0];
  assert.equal(env.mainWindow.visible, false);

  env.autoUpdater.emit('error', new Error('Checksum mismatch'));
  assert.equal(updWin.isDestroyed(), true);
  assert.equal(env.mainWindow.visible, true);
  assert.equal(env.mainWindow.focused, true);
  assert.equal(env.dialogCalls.length, 1);
  assert.match(env.dialogCalls[0].opts.detail, /Checksum mismatch/);
  env.ctrl.destruir();
});
