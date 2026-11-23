'use strict';

function formatearMb(bytes) {
  const valor = Number(bytes);
  if (!Number.isFinite(valor) || valor < 0) return '0.0';
  return (valor / (1024 * 1024)).toFixed(1);
}

function formatearDetalleProgreso(progress = {}) {
  const total = Number(progress.total) || 0;
  const transferred = Number(progress.transferred) || 0;
  const bps = Number(progress.bytesPerSecond) || 0;
  const partes = [];
  if (total > 0) {
    partes.push(`${formatearMb(transferred)} / ${formatearMb(total)} MB`);
  } else if (transferred > 0) {
    partes.push(`${formatearMb(transferred)} MB descargados`);
  }
  if (bps > 0) {
    partes.push(`${formatearMb(bps)} MB/s`);
  }
  return partes.join(' · ') || 'Descargando paquete de actualización...';
}

/**
 * Crea el controlador de auto-actualización para el gestor Electron.
 * Comprueba actualizaciones en GitHub Releases al arrancar y muestra una
 * ventana de progreso dedicada hasta instalar en silencio y reiniciar.
 */
function crearControladorActualizacion({
  app,
  BrowserWindow,
  dialog,
  autoUpdater,
  getMainWindow,
  getBaseUrl,
  iconPath,
  preloadPath,
  logger = console,
  restartDelayMs = 800,
}) {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;

  let updateWindow = null;
  let actualizando = false;
  let permitirCierre = false;
  let reinicioTimer = null;
  let destruido = false;
  let ultimoEstado = {
    fase: 'preparando',
    version: '',
    porcentaje: 0,
    mensaje: 'Preparando actualización...',
    detalle: 'Conectando con GitHub Releases...',
  };

  function emitirEstado(parcial = {}) {
    ultimoEstado = { ...ultimoEstado, ...parcial };
    if (updateWindow && !updateWindow.isDestroyed?.()) {
      updateWindow.webContents.send('updater:estado', ultimoEstado);
    }
  }

  function abrirVentanaActualizacion() {
    if (updateWindow && !updateWindow.isDestroyed?.()) {
      updateWindow.show?.();
      updateWindow.focus?.();
      return updateWindow;
    }

    const mainWin = getMainWindow?.();
    if (mainWin && !mainWin.isDestroyed?.()) {
      mainWin.hide?.();
    }

    updateWindow = new BrowserWindow({
      width: 440,
      height: 320,
      resizable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      frame: false,
      alwaysOnTop: true,
      backgroundColor: '#090909',
      icon: iconPath,
      title: 'Actualizando Bingoelus',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: preloadPath,
      },
    });

    if (typeof updateWindow.removeMenu === 'function') {
      updateWindow.removeMenu();
    }

    updateWindow.on('close', (event) => {
      if (actualizando && !permitirCierre) {
        event.preventDefault();
      }
    });

    updateWindow.on('closed', () => {
      updateWindow = null;
    });

    updateWindow.webContents.on('did-finish-load', () => {
      if (updateWindow && !updateWindow.isDestroyed?.()) {
        updateWindow.webContents.send('updater:estado', ultimoEstado);
      }
    });

    const baseUrl = getBaseUrl?.();
    updateWindow.loadURL(`${baseUrl}/updater`);
    return updateWindow;
  }

  function cerrarVentanaActualizacion() {
    permitirCierre = true;
    const win = updateWindow;
    updateWindow = null;
    if (win && !win.isDestroyed?.()) {
      win.close();
    }
  }

  function restaurarVentanaPrincipal() {
    const mainWin = getMainWindow?.();
    if (!mainWin || mainWin.isDestroyed?.()) return null;
    if (mainWin.isMinimized?.()) mainWin.restore?.();
    mainWin.show?.();
    mainWin.focus?.();
    return mainWin;
  }

  const onUpdateAvailable = (info = {}) => {
    if (destruido) return;
    actualizando = true;
    permitirCierre = false;
    ultimoEstado = {
      fase: 'descargando',
      version: info.version || '',
      porcentaje: 0,
      mensaje: 'Se ha encontrado una nueva versión. Descargando...',
      detalle: 'Conectando con GitHub Releases...',
    };
    abrirVentanaActualizacion();
    emitirEstado(ultimoEstado);
  };

  const onDownloadProgress = (progress = {}) => {
    if (destruido || !actualizando) return;
    const porcentaje = Math.max(0, Math.min(100, Math.round(Number(progress.percent) || 0)));
    emitirEstado({
      fase: 'descargando',
      porcentaje,
      mensaje: 'Descargando actualización de Bingoelus...',
      detalle: formatearDetalleProgreso(progress),
    });
  };

  const onUpdateDownloaded = (info = {}) => {
    if (destruido) return;
    actualizando = true;
    emitirEstado({
      fase: 'instalando',
      version: info.version || ultimoEstado.version,
      porcentaje: 100,
      mensaje: 'Actualización lista. Reiniciando Bingoelus...',
      detalle: 'Instalando nueva versión en segundo plano...',
    });

    clearTimeout(reinicioTimer);
    reinicioTimer = setTimeout(() => {
      reinicioTimer = null;
      if (destruido) return;
      permitirCierre = true;
      autoUpdater.quitAndInstall(true, true);
    }, restartDelayMs);
  };

  const onUpdateNotAvailable = (info = {}) => {
    logger?.info?.(`[Updater] Gestor actualizado (${info.version || app?.getVersion?.() || ''}).`);
  };

  const onError = (err) => {
    const mensajeError = err?.message || String(err || 'Error desconocido');
    if (!actualizando) {
      logger?.warn?.('[Updater] Comprobación de actualización omitida:', mensajeError);
      return;
    }

    logger?.error?.('[Updater] Error durante la actualización:', mensajeError);
    actualizando = false;
    clearTimeout(reinicioTimer);
    reinicioTimer = null;
    cerrarVentanaActualizacion();
    const mainWin = restaurarVentanaPrincipal();
    Promise.resolve(
      dialog.showMessageBox(mainWin || undefined, {
        type: 'warning',
        title: 'Error al actualizar Bingoelus',
        message: 'No se pudo completar la actualización automática.',
        detail: `${mensajeError}\n\nPuedes seguir usando la versión actual o descargar la última manualmente desde GitHub Releases.`,
        buttons: ['Continuar'],
      })
    ).catch(() => {});
  };

  const onBeforeQuit = () => {
    permitirCierre = true;
  };

  autoUpdater.on('update-available', onUpdateAvailable);
  autoUpdater.on('download-progress', onDownloadProgress);
  autoUpdater.on('update-downloaded', onUpdateDownloaded);
  autoUpdater.on('update-not-available', onUpdateNotAvailable);
  autoUpdater.on('error', onError);
  app.on('before-quit', onBeforeQuit);

  function iniciarComprobacionAlArranque() {
    if (destruido) return false;
    if (!app?.isPackaged && process.env.BINGOELUS_FORCE_UPDATE_CHECK !== '1') {
      logger?.info?.('[Updater] Modo desarrollo detectado; se omite la comprobación automática.');
      return false;
    }
    Promise.resolve(autoUpdater.checkForUpdates()).catch((err) => {
      logger?.warn?.('[Updater] Error al iniciar la búsqueda de actualización:', err?.message || err);
    });
    return true;
  }

  function destruir() {
    destruido = true;
    actualizando = false;
    permitirCierre = true;
    clearTimeout(reinicioTimer);
    reinicioTimer = null;
    autoUpdater.removeListener?.('update-available', onUpdateAvailable);
    autoUpdater.removeListener?.('download-progress', onDownloadProgress);
    autoUpdater.removeListener?.('update-downloaded', onUpdateDownloaded);
    autoUpdater.removeListener?.('update-not-available', onUpdateNotAvailable);
    autoUpdater.removeListener?.('error', onError);
    app.removeListener?.('before-quit', onBeforeQuit);
  }

  return {
    iniciarComprobacionAlArranque,
    getUpdateWindow: () => updateWindow,
    destruir,
  };
}

module.exports = {
  crearControladorActualizacion,
  formatearDetalleProgreso,
};
