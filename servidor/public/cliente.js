// cliente.js — lo que ve y hace el jugador en el navegador
// se conecta al servidor, muestra el cartón y envía las reclamaciones
// el servidor decide si son válidas, aquí no validamos nada

'use strict';
// token en localStorage para que el servidor sepa que eres el mismo jugador
function getOCrearToken() {
  let token = localStorage.getItem('bingoelus-token');
  if (!token) {
    token = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
    localStorage.setItem('bingoelus-token', token);
  }
  return token;
}
const socket = io('/jugador', { transports: ['websocket', 'polling'] });

// estado local del jugador
const estado = {
  nombre: '',
  carton: [],
  cantadas: new Set(),  // sincronizadas con el servidor
  marcadas: new Set(),  // las que el jugador ha tachado
  recibimoLinea: false,
  recibimoBingo: false,
  enPartida: false,
};

// Si la línea ya fue ganada globalmente (para bloquear btn-linea)
let lineaGanadaGlobal      = false;
// Si el gestor ha habilitado las reclamaciones
let reclamacionesHabilitadas = false;
// Mínimo de casillas cantadas en el cartón necesarias para poder reclamar
let umbralReclamo = 0;

// Sistema de huelgas global: 3 malos claims (Línea o Bingo) → penalización temporal
const STRIKES_MAX        = 3;
const STRIKE_COOLDOWN_MS = 20000;
let huelgasLinea    = 0;
let huelgasBingo    = 0;
let penalizadoLinea = false;
let penalizadoBingo = false;
let penTimerLinea   = null;
let penTimerBingo   = null;

// referencias DOM
const pantallaLogin  = document.getElementById('pantalla-login');
const pantallaReglas = document.getElementById('pantalla-reglas');
const pantallaJuego  = document.getElementById('pantalla-juego');
const btnEntrar      = document.getElementById('btn-entrar');
const msgEspera      = document.getElementById('msg-espera');
const nombreDisplay  = document.getElementById('nombre-display');
const estadoPartida  = document.getElementById('estado-partida');
const txtUltimaFrase = null; // elemento eliminado
const cartonEl       = document.getElementById('carton');
const btnLinea       = document.getElementById('btn-linea');
const btnBingo       = document.getElementById('btn-bingo');
const accionesEl     = document.getElementById('acciones');
const notificacionEl = document.getElementById('notificacion');
const bannerAnuncio  = document.getElementById('banner-anuncio');

// utilidades de UI

let notifTimer;
function mostrarNotif(msg, tipo = 'info', duracion = 3500) {
  notificacionEl.textContent = msg;
  notificacionEl.className   = `visible ${tipo}`;
  clearTimeout(notifTimer);
  notifTimer = setTimeout(() => {
    notificacionEl.className = '';
  }, duracion);
}
let btnCountdownIv = null;

// Envío de marcadas con throttle: si el servidor está en rate limit,
// programa un reintento automático para que el último estado siempre llegue.
let _ultimoEnvioMarcadas = 0;
let _timerEnvioMarcadas  = null;
const RATE_MARCADAS_MS   = 500; // debe coincidir con el servidor
function enviarMarcadas() {
  clearTimeout(_timerEnvioMarcadas);
  const espera = RATE_MARCADAS_MS - (Date.now() - _ultimoEnvioMarcadas);
  if (espera <= 0) {
    _ultimoEnvioMarcadas = Date.now();
    socket.emit('jugador:actualizar-marcadas', { marcadas: Array.from(estado.marcadas) });
  } else {
    _timerEnvioMarcadas = setTimeout(() => {
      _ultimoEnvioMarcadas = Date.now();
      socket.emit('jugador:actualizar-marcadas', { marcadas: Array.from(estado.marcadas) });
    }, espera);
  }
}

function bloquearTodo(segs = STRIKE_COOLDOWN_MS / 1000) {
  cartonEl.classList.add('bloqueado');
  accionesEl.classList.add('bloqueado');
  if (!btnLinea.dataset.textoOriginal) btnLinea.dataset.textoOriginal = btnLinea.textContent;
  if (!btnBingo.dataset.textoOriginal) btnBingo.dataset.textoOriginal = btnBingo.textContent;
  let s = segs;
  const actualizarBtns = () => {
    btnLinea.textContent = `⛔ Bloqueado (${s}s)`;
    btnBingo.textContent = `⛔ Bloqueado (${s}s)`;
  };
  actualizarBtns();
  clearInterval(btnCountdownIv);
  btnCountdownIv = setInterval(() => {
    s--;
    if (s > 0) actualizarBtns();
    else clearInterval(btnCountdownIv);
  }, 1000);
}
function desbloquearTodo() {
  cartonEl.classList.remove('bloqueado');
  accionesEl.classList.remove('bloqueado');
  clearInterval(btnCountdownIv);
  if (btnLinea.dataset.textoOriginal) { btnLinea.textContent = btnLinea.dataset.textoOriginal; delete btnLinea.dataset.textoOriginal; }
  if (btnBingo.dataset.textoOriginal) { btnBingo.textContent = btnBingo.dataset.textoOriginal; delete btnBingo.dataset.textoOriginal; }
}

function mostrarBanner(msg, tipo) {
  bannerAnuncio.style.display = 'block';
  bannerAnuncio.className     = `banner-anuncio ${tipo}`;  // clase para estilos
  bannerAnuncio.id            = 'banner-anuncio';          // reaplica el id
  bannerAnuncio.textContent   = msg;
}

// frases que tienen imagen asociada en /media/casillas/
const CASILLAS_IMG = {
  'Donut o donette':                '/media/casillas/donut_lotus.png',
  'Macarrones levantavidas':        '/media/casillas/macarrones.png',
  'Tostadita de las m\u00edas':         '/media/casillas/tostadita.png',
  'Bocadillete':                    '/media/casillas/bocadillete.png',
  'Bostez\u00f3n (o intento de)':       '/media/casillas/bostezo.png',
  'Algo fritaco':                   '/media/casillas/frito.png',
  'Poncho de palomitas':            '/media/casillas/poncho_palomitas.png',
  '"Le pregunté a Gemini" o chatgpt': '/media/casillas/chat_gpt.png',
  'La creatina (mostrada o tomada)':'/media/casillas/creatina.png',
  '"No soy de dulce"':              '/media/casillas/dulce.png',
  'Alguna fruta':                   '/media/casillas/fruta.png',
  'Goku':                           '/media/casillas/goku.png',
  'Rascarse el papotrón en el gym': '/media/casillas/gym.png',
  '"Tengo hambre"':                 '/media/casillas/hambre.png',
  'Hamburguesotrón':                '/media/casillas/hamburguesa.png',
  'Omega3 (mostrado o tomado)':     '/media/casillas/omega3.png',
  'Picsa':                          '/media/casillas/picsa.png',
  'Platotrón cuál Cerro Calderón':  '/media/casillas/platotron.png',
  'Mucha edición/mucho trabajo':    '/media/casillas/trabajo.png',
};

// monta el cartón en el DOM
function renderizarCarton() {
  cartonEl.innerHTML = '';
  estado.carton.forEach((fila, fi) => {
    fila.forEach((frase, ci) => {
      const celda = document.createElement('div');
      celda.className     = 'celda-jugador no-cantada';
      celda.dataset.frase = frase;
      celda.title         = frase;

      const imgSrc = CASILLAS_IMG[frase];
      if (imgSrc) {
        const imgEl = document.createElement('img');
        imgEl.src       = imgSrc;
        imgEl.alt       = '';
        imgEl.className = 'celda-bg-img';
        celda.appendChild(imgEl);
        celda.classList.add('celda-con-foto');
      }
      const span = document.createElement('span');
      span.textContent = frase;
      celda.appendChild(span);

// El jugador puede tachar una celda en cualquier momento
      celda.addEventListener('click', () => {
        // Toggle de casilla
        if (estado.marcadas.has(frase)) {
          estado.marcadas.delete(frase);
        } else {
          estado.marcadas.add(frase);
        }
        actualizarCelda(celda, frase);
        
        // Notificar al servidor
        enviarMarcadas();
      });

      cartonEl.appendChild(celda);
    });
  });
}

// actualiza clases CSS de una celda según cantadas/marcadas
function actualizarCelda(celdaEl, frase) {
  const cantada = estado.cantadas.has(frase);
  const marcada = estado.marcadas.has(frase);

  celdaEl.classList.remove('cantada', 'marcada', 'no-cantada', 'penalizada');

  // El jugador no debe saber visualmente si acertó o no.
  // Solo se marca.
  if (marcada) {
    celdaEl.classList.add('marcada');
  } else {
    celdaEl.classList.add('no-cantada');
  }
}

// recorre todas las celdas y aplica actualizarCelda
function actualizarTodasLasCeldas() {
  cartonEl.querySelectorAll('.celda-jugador').forEach(celdaEl => {
    actualizarCelda(celdaEl, celdaEl.dataset.frase);
  });
}

// resetea huelgas si se habilitan reclamaciones
function actualizarBotones() {
  if (reclamacionesHabilitadas && !lineaGanadaGlobal && !estado.recibimoLinea) {
    huelgasLinea = 0;
    penalizadoLinea = false;
    clearTimeout(penTimerLinea);
  }
  if (reclamacionesHabilitadas && !estado.recibimoBingo) {
    huelgasBingo = 0;
    penalizadoBingo = false;
    clearTimeout(penTimerBingo);
  }
  actualizarEstadoVisualBotones();
}

// marca/desmarca la clase 'eligible' para dar feedback visual al jugador
function actualizarEstadoVisualBotones() {
  const lineaElegible = reclamacionesHabilitadas && estado.enPartida &&
                        !estado.recibimoLinea && !lineaGanadaGlobal;
  const bingoElegible = reclamacionesHabilitadas && estado.enPartida &&
                        !estado.recibimoBingo;

  btnLinea.classList.toggle('eligible', lineaElegible);
  btnBingo.classList.toggle('eligible', bingoElegible);
}

// sesión Twitch
let twitchUser = null;

(function checkTwitchSession() {
  const params    = new URLSearchParams(window.location.search);
  const errorCode = params.get('twitch_error');
  const loadingEl = document.getElementById('twitch-loading');

  fetch('/auth/me')
    .then(r => r.json())
    .then(user => {
      if (loadingEl) loadingEl.style.display = 'none';

      if (!user || !user.login) {
        if (errorCode) {
          // Error en el flujo OAuth → mostrar mensaje y opción de reintentar
          const msgs = {
            cancelado:       'Cancelaste el inicio de sesión con Twitch.',
            estado_invalido: 'El enlace de Twitch caducó. Inténtalo de nuevo.',
            error_servidor:  'Error al conectar con Twitch. Inténtalo más tarde.',
            cola_llena:      'Hay mucha gente intentando entrar a la vez. Espera un momento y vuelve a intentarlo.',
          };
          const errMsg = msgs[errorCode] || 'Error desconocido con Twitch.';
          if (loadingEl) {
            loadingEl.innerHTML = `❌ ${errMsg}<br><a href="/auth/twitch" style="color:#9147ff;font-weight:700;display:inline-block;margin-top:8px">🟣 Reintentar con Twitch</a>`;
            loadingEl.style.color = 'var(--danger)';
            loadingEl.style.display = 'block';
          }
          history.replaceState({}, '', '/');
      // sin sesión → a Twitch
          window.location.href = '/auth/twitch';
        }
        return;
      }

      twitchUser = user;
      history.replaceState({}, '', '/'); // quito los query params si los hay

      // Mostrar tarjeta de perfil Twitch
      const cardEl    = document.getElementById('twitch-card');
      const avatarEl  = document.getElementById('twitch-avatar');
      const nameEl    = document.getElementById('twitch-card-name');
      const loginEl   = document.getElementById('twitch-card-login');
      const btnEntrar = document.getElementById('btn-entrar');

      if (avatarEl)  avatarEl.textContent    = (user.displayName || user.login).charAt(0).toUpperCase();
      if (nameEl)    nameEl.textContent      = user.displayName || user.login;
      if (loginEl)   loginEl.textContent     = `@${user.login}`;
      if (cardEl)    cardEl.style.display    = 'flex';
      // Mostrar campo Discord y botón entrar
      const discordStep = document.getElementById('discord-step');
      if (discordStep) discordStep.style.display = 'flex';
      if (btnEntrar) btnEntrar.style.display = 'block';
    })
    .catch(() => {
      // error de red → intento autenticar de nuevo
      window.location.href = '/auth/twitch';
    });
})();

function intentarEntrar() {
  if (!twitchUser) {
    window.location.href = '/auth/twitch';
    return;
  }

  // Validar nombre de Discord
  const inputDiscord = document.getElementById('input-discord');
  const discordError = document.getElementById('discord-error');
  const nombreDiscord = inputDiscord ? inputDiscord.value.trim() : '';
  if (!nombreDiscord) {
    if (discordError) discordError.style.display = 'block';
    if (inputDiscord) inputDiscord.focus();
    return;
  }
  if (discordError) discordError.style.display = 'none';

  const nombre = nombreDiscord;
  const token  = getOCrearToken();
  estado.nombre = nombre;
  if (nombreDisplay) nombreDisplay.textContent = nombre;
  socket.emit('jugador:unirse', { nombre, token, twitch: twitchUser.login });
}

btnEntrar.addEventListener('click', intentarEntrar);

document.getElementById('btn-aceptar-reglas')?.addEventListener('click', () => {
  pantallaReglas.style.display = 'none';
  // En este punto ya tenemos el cartón del servidor,
  // así que pasamos directamente a la pantalla de juego
  if (estado.pendienteCarton) {
    const { carton, cantadas, marcadas } = estado.pendienteCarton;
    delete estado.pendienteCarton;
    pasarAPantallaJuego(carton, cantadas, marcadas);
  }
});

// Enter en el campo Discord también entra al juego
document.getElementById('input-discord')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') intentarEntrar();
});

function pasarAPantallaJuego(carton, cantadas, marcadasIniciales) {
  estado.carton  = carton;
  estado.cantadas = new Set(cantadas);
  estado.marcadas = marcadasIniciales ? new Set(marcadasIniciales) : new Set();
  estado.enPartida = true;

  pantallaLogin.style.display  = 'none';
  pantallaReglas.style.display = 'none';
  pantallaJuego.style.display  = 'flex';

  estadoPartida.textContent = 'Partida en curso';
  estadoPartida.className   = 'activa';

  renderizarCarton();
  actualizarTodasLasCeldas();

  // Los botones solo se habilitan cuando el gestor lo permita
  actualizarBotones();

  if (cantadas.length > 0) {
    // última frase eliminada de la UI
  }
}

// botones de línea y bingo

btnLinea.addEventListener('click', () => {
  const puedeReclamar = reclamacionesHabilitadas && estado.enPartida &&
                        !estado.recibimoLinea && !lineaGanadaGlobal;
  if (!puedeReclamar) {
    if (!reclamacionesHabilitadas)    mostrarNotif('🔒 El gestor aún no ha habilitado las reclamaciones.', 'info', 2500);
    else if (!estado.enPartida)       mostrarNotif('⏸ No hay partida activa.', 'info', 2500);
    else if (lineaGanadaGlobal)       mostrarNotif('❌ La línea ya fue cantada.', 'info', 2500);
    else if (estado.recibimoLinea)    mostrarNotif('✅ Ya reclamaste una línea.', 'info', 2500);
    return;
  }
  socket.emit('jugador:pedir-linea', { marcadas: Array.from(estado.marcadas) });
});

btnBingo.addEventListener('click', () => {
  const puedeReclamar = reclamacionesHabilitadas && estado.enPartida &&
                        !estado.recibimoBingo;
  if (!puedeReclamar) {
    if (!reclamacionesHabilitadas)    mostrarNotif('🔒 El gestor aún no ha habilitado las reclamaciones.', 'info', 2500);
    else if (!estado.enPartida)       mostrarNotif('⏸ No hay partida activa.', 'info', 2500);
    else if (estado.recibimoBingo)    mostrarNotif('✅ Ya reclamaste el bingo.', 'info', 2500);
    return;
  }
  socket.emit('jugador:pedir-bingo', { marcadas: Array.from(estado.marcadas) });
});

// eventos socket.io

socket.on('connect', () => {
  console.log('[Cliente] Conectado al servidor. ID:', socket.id);
});

socket.on('disconnect', () => {
  mostrarNotif('⚠️ Desconectado del servidor. Recarga la página.', 'error', 0);
});

// el servidor me asigna el cartón (también al reconectar)
socket.on('tu:carton', ({ carton, cantadas, marcadas, lineaGanada, bingoGanado, reclamacionesHabilitadas: habilitadas, umbralReclamo: umbral }) => {
  reclamacionesHabilitadas = habilitadas || false;
  lineaGanadaGlobal        = lineaGanada || false;
  umbralReclamo            = umbral ?? 0;

  const esReconexion = marcadas && marcadas.length > 0;
  if (esReconexion) {
    // Reconexión: ir directamente al juego sin reglas
    pasarAPantallaJuego(carton, cantadas, marcadas);
    mostrarNotif('🎱 ¡Reconectado! Tu cartón fue restaurado.', 'ok');
  } else {
    // Primera vez: mostrar pantalla de reglas
    estado.pendienteCarton = { carton, cantadas, marcadas };
    pantallaLogin.style.display  = 'none';
    pantallaReglas.style.display = 'flex';
    mostrarNotif('🎱 ¡Cartón asignado! Lee las reglas y pulsa continuar.', 'ok');
  }

  if (lineaGanada) {
    lineaGanadaGlobal = true;
    mostrarBanner('La línea ya fue cantada en esta partida.', 'linea');
  }
  if (bingoGanado) {
    estado.recibimoBingo = true;
    estadoPartida.textContent = 'Partida finalizada';
    estadoPartida.className   = 'finalizada';
  }
  actualizarBotones();
});

// nueva frase cantada desde el gestor
socket.on('partida:frase-cantada', ({ frase, cantadas }) => {
  estado.cantadas = new Set(cantadas);
  actualizarTodasLasCeldas();
  actualizarEstadoVisualBotones();
  if (navigator.vibrate) navigator.vibrate(80);
});

// ── Modal de premio al jugador ───────────────────────────────
const modalPremio    = document.getElementById('modal-premio');
const modalPremioImg = document.getElementById('modal-premio-img');
const modalPremioMsg = document.getElementById('modal-premio-msg');
const modalPremioBtn = document.getElementById('modal-premio-btn');
modalPremioBtn.addEventListener('click', () => modalPremio.classList.remove('visible'));

function mostrarModalPremio(tipo) {
  if (tipo === 'linea') {
    modalPremioImg.src = '/media/proteina.png';
    modalPremioMsg.textContent = '¡Te llevas una proteína BIG!';
    modalPremioMsg.className = 'linea-msg';
  } else {
    modalPremioImg.src = '/media/proteina-creatina.png';
    modalPremioMsg.textContent = '¡Proteinita y createinita BIG que te llevas campeón!';
    modalPremioMsg.className = 'bingo-msg';
  }
  modalPremio.classList.add('visible');
}

// ── Tu reclamación de Línea fue ACEPTADA ──────────────────
socket.on('tu:linea-valida', ({ ganador }) => {
  estado.recibimoLinea = true;
  actualizarBotones();
  mostrarModalPremio('linea');
});

// ── Tu reclamación de Bingo fue ACEPTADA ────────────────────
socket.on('tu:bingo-valido', ({ ganador }) => {
  estado.recibimoBingo = true;
  actualizarBotones();
  estadoPartida.textContent = '¡Has ganado el Bingo!';
  estadoPartida.className   = 'activa';
  mostrarModalPremio('bingo');
});

// ── Anuncio público: alguien cantó Línea ─────────────────────
socket.on('partida:linea-anuncio', ({ ganador }) => {
  if (ganador !== estado.nombre) {
    mostrarBanner(`🎉 ¡${ganador} ha cantado LÍNEA!`, 'linea');
    mostrarNotif(`¡${ganador} ha cantado Línea!`, 'info');
  }
  lineaGanadaGlobal        = true;
  estado.recibimoLinea     = true;
  reclamacionesHabilitadas = false;
  actualizarBotones();
});

// bingo anunciado — la partida puede seguir o no
socket.on('partida:bingo-anuncio', ({ ganador }) => {
  if (ganador !== estado.nombre) {
    mostrarBanner(`🏆 ¡${ganador} ha cantado BINGO!`, 'bingo');
    mostrarNotif(`¡${ganador} ha cantado Bingo! Esperando al gestor...`, 'info', 5000);
  }
  // reclamacionesHabilitadas se actualiza por el evento partida:reclamaciones-deshabilitadas
});

// el gestor cerró la partida
socket.on('partida:juego-terminado', ({ ganadores }) => {
  estado.recibimoBingo     = true;
  reclamacionesHabilitadas = false;
  actualizarBotones();

  const lista = ganadores.length > 0 ? ganadores.join(', ') : 'nadie';
  mostrarBanner(`🏆 ¡Partida finalizada! Ganador(es) de Bingo: ${lista}`, 'bingo');

  if (ganadores.includes(estado.nombre)) {
    estadoPartida.textContent = '🏆 ¡Has ganado!';
    estadoPartida.className   = 'activa';
    mostrarNotif(`🏆 ¡La partida ha terminado! ¡Enhorabuena, ${estado.nombre}!`, 'ok', 8000);
  } else {
    estadoPartida.textContent = 'Partida finalizada';
    estadoPartida.className   = 'finalizada';
    mostrarNotif(`La partida ha terminado. Ganó: ${lista}`, 'info', 8000);
  }
});


socket.on('partida:reclamaciones-habilitadas', () => {
  reclamacionesHabilitadas = true;
  actualizarBotones();
  mostrarNotif('🔓 El gestor ha habilitado las reclamaciones.', 'info', 3000);
});


socket.on('partida:reclamaciones-deshabilitadas', () => {
  reclamacionesHabilitadas = false;
  actualizarBotones();
});


socket.on('partida:error', ({ msg }) => {
  mostrarNotif(`❌ ${msg}`, 'error');
});

socket.on('tu:bloqueado', ({ segs, msg }) => {
  mostrarNotif(`⛔ ${msg}`, 'error', 4000);
  bloquearTodo(segs);
  setTimeout(() => desbloquearTodo(), segs * 1000);
});

// nueva partida → resetear todo y volver al login
socket.on('partida:nueva', () => {
  Object.assign(estado, {
    nombre: '',
    carton: [],
    cantadas: new Set(),
    marcadas: new Set(),
    recibimoLinea: false,
    recibimoBingo: false,
    enPartida: false,
  });
  lineaGanadaGlobal        = false;
  reclamacionesHabilitadas = false;
  umbralReclamo            = 0;
  huelgasLinea = 0;
  huelgasBingo = 0;
  penalizadoLinea = false;
  penalizadoBingo = false;
  clearTimeout(penTimerLinea);
  clearTimeout(penTimerBingo);
  desbloquearTodo();

  // Volver a la pantalla de login
  pantallaJuego.style.display = 'none';
  pantallaLogin.style.display = 'flex';
  msgEspera.style.display     = 'none';
  bannerAnuncio.style.display = 'none';

  mostrarNotif('⚠️ El gestor ha iniciado una nueva partida. Vuelve a entrar.', 'info', 5000);
});

// el gestor desmarcó una frase (error del gestor al cantar)
socket.on('partida:frase-descantada', ({ frase, cantadas }) => {
  estado.cantadas = new Set(cantadas);
  // si el jugador la tenía marcada, la desmarcamos también
  if (estado.marcadas.has(frase)) {
    estado.marcadas.delete(frase);
    socket.emit('jugador:actualizar-marcadas', { marcadas: Array.from(estado.marcadas) });
  }
  desbloquearTodo();
  actualizarTodasLasCeldas();
  actualizarEstadoVisualBotones();
});

// umbral actualizado por el gestor
socket.on('partida:umbral-actualizado', ({ umbral }) => {
  umbralReclamo = umbral;
  actualizarEstadoVisualBotones();
});
