# 🎱 Bingoelus - Real-Time Interactive Bingo for Twitch

![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)
![Socket.io](https://img.shields.io/badge/Socket.io-010101?style=for-the-badge&logo=socket.io&logoColor=white)
![Google Cloud](https://img.shields.io/badge/GoogleCloud-%234285F4.svg?style=for-the-badge&logo=google-cloud&logoColor=white)
![Cloudflare](https://img.shields.io/badge/Cloudflare-F38020?style=for-the-badge&logo=Cloudflare&logoColor=white)

Plataforma web Full-Stack de alta concurrencia diseñada para que miles de espectadores de Twitch jueguen al bingo en tiempo real de forma sincronizada con un streaming en directo.

## 🚀 El Reto Técnico y el Problema Original (The Origin Story)
Originalmente, el creador de contenido [JoelusFitness](https://www.twitch.tv/joelusfitness)  utilizaba plataformas de terceros (como BingoBaker) para jugar con su audiencia. Sin embargo, surgieron dos problemas críticos en producción:
1. **Fraude masivo (Cheating):** Al basarse en validación del lado del cliente o en el "sistema de honor", los espectadores hacían trampas utilizando la herramienta "Inspeccionar Elemento" del navegador o editando capturas de pantalla (Photoshop) para fingir que habían ganado premios físicos.
2. **Estampidas de red (Thundering Herd):** Cuando el streamer compartía el enlace a miles de personas simultáneamente en directo, las plataformas genéricas colapsaban o expulsaban a los usuarios.

## 💡 Solución y Arquitectura (Server-Side Source of Truth)
Para resolver esto, diseñé un sistema propietario donde el cliente web es totalmente "tonto" a nivel de validación y **el servidor es la única fuente de la verdad (SSOT)**.

* **Sistema Anti-Cheat Infalible:** Cuando un jugador pulsa "¡Bingo!", el cliente web no calcula nada. El servidor cruza la petición con el cartón exacto generado para ese usuario (asociado a su ID de Twitch) y comprueba en memoria si esas casillas han sido marcadas oficialmente por el Gestor de la partida. Es matemáticamente imposible falsificar una victoria modificando el DOM.
* **Sistema de "Strikes" en Tiempo Real:** Si un usuario intenta hacer *spam* del botón de reclamar premio sin tenerlo, el servidor detecta el patrón, le avisa exactamente de qué casilla no ha salido, y si acumula 3 fallos (Strikes), bloquea su interfaz mediante WebSockets durante 20 segundos.
* **Gestión de Cuellos de Botella (Twitch API):** Para mitigar la estampida inicial sin superar el estricto *Rate Limit* de la API de Twitch (800 peticiones/min), se implementó una **"Sala de Espera Asíncrona" (Job Queue + Polling)**. Permite encolar a miles de usuarios al instante y procesar la validación OAuth en lotes controlados (`AuthQueue`), garantizando 0 *Timeouts* de red y protegiendo la IP del servidor frente a baneos del WAF de Twitch.
* **Infraestructura Zero Trust:** Desplegado en una VM de Google Cloud Platform (GCP) detrás de un túnel seguro de Cloudflare (Zero Trust), mitigando ataques DDoS en el Edge y ocultando la IP origen del servidor.

## 📊 Rendimiento y Pruebas de Estrés (Stress Tests)
Para garantizar la estabilidad en producción, se desarrollaron scripts personalizados en Node.js para simular escenarios extremos (Estampidas, Efecto Rebaño y micro-cortes de red).

**Resultados de la simulación de carga extrema (10.000 clientes concurrentes):**
* **Conexiones WebSocket establecidas:** 10.000 / 10.000 (100%) bajo simulación agresiva de pérdida de red (micro-cortes 4G) y reconexión masiva. [cite_start]Cero fallos de conexión.
* [cite_start]**Eventos procesados:** Más de 318.000 eventos (clicks, validaciones, peticiones de premio) procesados en solo 90 segundos de test[cite: 93].
* [cite_start]**Latencia HTTP media:** 26 milisegundos en peticiones HTTP simultáneas bajo estrés extremo.
* [cite_start]**Tolerancia a fallos:** 0 Errores HTTP devueltos por el servidor (0.0% fallos) durante el bombardeo masivo de tráfico.

## 🛠️ Stack Tecnológico
* **Backend:** Node.js, Express, Socket.io
* **Frontend:** Vanilla JS, HTML5, CSS3 (UI Adaptativa y optimizada para móviles)
* **Infraestructura:** Google Cloud Platform (GCP), Cloudflare Zero Trust (Tunnels)
* **Integraciones:** Twitch API (OAuth 2.0 & Helix)

## 🎯 Características Principales
- **Login obligatorio con Twitch:** Prevención automatizada de bots y multicuentas.
- **Panel de "Gestor" protegido:** Interfaz de control en tiempo real protegida por token para el administrador del evento.
- **Sincronización bidireccional:** Estado de cartones, casillas cantadas y premios sincronizados al milisegundo mediante WebSockets.
- **Reconexión resiliente:** Si un jugador cierra el navegador o pierde cobertura, su cartón y estado de casillas marcadas se recuperan automáticamente al volver a entrar gracias al almacenamiento en memoria asociado a su Twitch ID.

## 🛡️ Watchdog de Cloudflared + Backup Automático

Se añadieron artefactos operativos para Linux en `ops/watchdog` y `ops/backup`.

### 1) Instalar scripts y units en la VM

```bash
cd /opt/bingoelus
chmod +x ops/watchdog/cloudflared-watchdog.sh
chmod +x ops/backup/bingoelus-backup.sh

sudo cp ops/watchdog/cloudflared-watchdog.service /etc/systemd/system/
sudo cp ops/watchdog/cloudflared-watchdog.timer /etc/systemd/system/
sudo cp ops/backup/bingoelus-backup.service /etc/systemd/system/
sudo cp ops/backup/bingoelus-backup.timer /etc/systemd/system/

sudo cp ops/watchdog/bingoelus-cloudflared-watchdog.env.example /etc/default/bingoelus-cloudflared-watchdog
sudo cp ops/backup/bingoelus-backup.env.example /etc/default/bingoelus-backup
```

### 2) Ajustar configuración

- Edita `/etc/default/bingoelus-cloudflared-watchdog`:
	- `PRIMARY_SERVICE`, `CLONE_SERVICE`
	- `PUBLIC_HEALTH_URL` (ej: `https://tu-dominio/healthz`)
	- Opcional: `PRIMARY_TUNNEL`, `CLONE_TUNNEL` para validar mínimo de conexiones.

- Edita `/etc/default/bingoelus-backup`:
	- `SOURCE_DIRS` (por defecto: `/opt/bingoelus/ganadores:/opt/bingoelus/servidor/resultados`)
	- `BACKUP_BASE`, `RETENTION_DAYS`
	- Recomendado en GCP: `GSUTIL_BUCKET` (ej: `gs://bingoelus-backups`)
	- Opcional fallback: `RCLONE_TARGET` si prefieres rclone.

- Variables de Discord (opcional, ganador inmediato con cartón + TXT al terminar):
	- `DISCORD_WEBHOOK_URL`
	- `DISCORD_WEBHOOK_USERNAME` (default: `Bingoelus Bot`)
	- `DISCORD_WEBHOOK_AVATAR_URL` (opcional)
	- `DISCORD_NOTIFY_ON_END=1` (pon `0` para desactivar)
	- `DISCORD_NOTIFY_WINNER_ON_CARD=1` (pon `0` para desactivar avisos inmediatos de ganador)
	- `DISCORD_ATTACH_RESULTS=1` (adjunta TXT; `0` para desactivar)
	- `DISCORD_WINNERS_DIR=/opt/bingoelus/ganadores`
	- `DISCORD_MAX_FILE_BYTES=8388608`

### 3) Activar timers

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-watchdog.timer
sudo systemctl enable --now bingoelus-backup.timer
```

### 4) Verificación rápida

```bash
curl -fsS http://127.0.0.1:3000/healthz
sudo systemctl status cloudflared-watchdog.timer --no-pager
sudo systemctl status bingoelus-backup.timer --no-pager
journalctl -u cloudflared-watchdog.service -n 50 --no-pager
journalctl -u bingoelus-backup.service -n 50 --no-pager
```