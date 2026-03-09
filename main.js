// main.js — proceso principal de Electron
// Sirve gestor.html localmente y abre la ventana del gestor.
// Toda la lógica del juego corre en el servidor remoto (servidor/server.js en la VM).

'use strict';

const { app, BrowserWindow } = require('electron');
const path    = require('path');
const http    = require('http');
const express = require('express');

const PORT_LOCAL = 3001; // servidor local solo para servir gestor.html y media

// Servidor Express mínimo: solo sirve el HTML del gestor y los archivos de media
const xApp = express();
xApp.get('/gestor', (_req, res) => {
  res.sendFile(path.join(__dirname, 'gestor.html'));
});
xApp.use('/media', express.static(path.join(__dirname, 'media')));
http.createServer(xApp).listen(PORT_LOCAL, '127.0.0.1');

// ─── Ventana Electron ─────────────────────────────────────────

let mainWindow;

function crearVentana() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Bingoelus — Gestor',
    icon: path.join(__dirname, 'media', 'joelus.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${PORT_LOCAL}/gestor`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  crearVentana();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) crearVentana();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
