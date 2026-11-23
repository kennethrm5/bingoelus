'use strict';

const { contextBridge, ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add('electron-app');
});

contextBridge.exposeInMainWorld('bingoelusUpdater', {
  onEstado(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('updater:estado', listener);
    return () => ipcRenderer.removeListener('updater:estado', listener);
  },
});
