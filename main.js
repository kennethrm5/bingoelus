// main.js — proceso principal de Electron
// Sirve gestor.html localmente y abre la ventana del gestor.
// Toda la lógica del juego corre en el servidor remoto (servidor/server.js en la VM).

'use strict';

const { app, BrowserWindow, dialog } = require('electron');
const path    = require('path');
const http    = require('http');
const express = require('express');
const { autoUpdater } = require('electron-updater');
const { crearControladorActualizacion } = require('./updater');

app.setAppUserModelId('com.kennethrm5.bingoelus');

let portLocal;

// Servidor Express mínimo: solo sirve el HTML del gestor y los archivos de media
const xApp = express();
xApp.get('/gestor', (_req, res) => {
  res.sendFile(path.join(__dirname, 'gestor.html'));
});
xApp.get('/updater', (_req, res) => {
  res.sendFile(path.join(__dirname, 'updater.html'));
});
xApp.use('/media', express.static(path.join(__dirname, 'media')));
const servidorLocal = http.createServer(xApp);

// ─── Ventana Electron ─────────────────────────────────────────

let mainWindow;
let controladorActualizacion;

function crearVentana() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Bingoelus — Gestor',
    icon: path.join(__dirname, 'media', 'bingoelus-app-icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#11100c',
      symbolColor: '#f5b800',
      height: 38,
    },
    backgroundColor: '#090909',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadURL(`http://127.0.0.1:${portLocal}/gestor`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function iniciarServidorLocal() {
  return new Promise((resolve, reject) => {
    servidorLocal.once('error', reject);
    servidorLocal.listen(0, '127.0.0.1', () => {
      servidorLocal.removeListener('error', reject);
      const address = servidorLocal.address();
      if (!address || typeof address === 'string') {
        reject(new Error('No se pudo obtener el puerto del servidor local.'));
        return;
      }
      portLocal = address.port;
      resolve();
    });
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const updateWin = controladorActualizacion?.getUpdateWindow();
    if (updateWin && !updateWin.isDestroyed()) {
      if (updateWin.isMinimized()) updateWin.restore();
      updateWin.focus();
      return;
    }
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    try {
      await iniciarServidorLocal();
      crearVentana();
      controladorActualizacion = crearControladorActualizacion({
        app,
        BrowserWindow,
        dialog,
        autoUpdater,
        getMainWindow: () => mainWindow,
        getBaseUrl: () => `http://127.0.0.1:${portLocal}`,
        iconPath: path.join(__dirname, 'media', 'bingoelus-app-icon.png'),
        preloadPath: path.join(__dirname, 'preload.js'),
      });
      controladorActualizacion.iniciarComprobacionAlArranque();
    } catch (error) {
      console.error('No se pudo iniciar el servidor local del gestor:', error);
      dialog.showErrorBox(
        'Error al iniciar el gestor',
        `No se pudo iniciar el servidor local: ${error.message}`
      );
      app.quit();
      return;
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) crearVentana();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
