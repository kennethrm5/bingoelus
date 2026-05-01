# 🎱 Bingoelus - Bingo interactivo a tiempo real para Twitch

![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)
![Socket.io](https://img.shields.io/badge/Socket.io-010101?style=for-the-badge&logo=socket.io&logoColor=white)
![Google Cloud](https://img.shields.io/badge/GoogleCloud-%234285F4.svg?style=for-the-badge&logo=google-cloud&logoColor=white)
![Cloudflare](https://img.shields.io/badge/Cloudflare-F38020?style=for-the-badge&logo=Cloudflare&logoColor=white)

Plataforma web full-stack de alta concurrencia para que miles de espectadores de Twitch jueguen al bingo en tiempo real, sincronizada con un streaming en directo.

## Problema original (origen del proyecto)
El proyecto nace por dos problemas en plataformas de terceros que se usaban en directo: 
1) Fraude masivo al poder falsificar victorias desde el navegador y
2) Colapsos por estampidas de tráfico cuando miles de usuarios entraban a la vez.

Estos dos puntos fueron la causa directa de construir Bingoelus.

## Arquitectura y funcionamiento
La solución se basa en un modelo **Server-Side Source of Truth (SSOT)**: el servidor es el único que valida estado y premios. El cliente es una vista reactiva sin lógica de validación.

### Arquitectura de clientes
- **Gestor**: se conecta al servidor mediante una app instalable en Windows (cliente Electron).
- **Moderadores y jugadores**: se conectan vía web a la interfaz alojada en el servidor, accesible desde `https://bingoelus.online`.
- **Servidor central**: orquesta la partida, valida premios y distribuye estado en tiempo real a todos los clientes.

### Flujo principal
1. **Login Twitch (OAuth 2.0)**: el jugador se autentica y obtiene un cartón asociado a su Twitch ID.
2. **Sesión en tiempo real**: el servidor mantiene el estado de partida y difunde cambios por Socket.io.
3. **Canto y validación**: el gestor canta frases; el servidor marca casillas oficialmente.
4. **Reclamación de premio**: el cliente solo solicita; el servidor valida contra el cartón oficial y el estado cantado.

### Antifraude y control de abuso
- **Validación server-side**: una victoria no puede falsificarse modificando el DOM.
- **Strikes en tiempo real**: reclamos inválidos generan penalizaciones temporales y se registran por socket.

### Escalabilidad y rendimiento
- **Modo compacto**: cuando hay más de 300 jugadores, el servidor envía al gestor solo el top de cartones más cercanos al bingo y habilita búsqueda remota.
- **Rate limiting**: control de frecuencia por acciones sensibles (reclamos, marcadas, búsquedas).
- **Twitch API**: cola asíncrona para evitar rate limits y absorber estampidas.

### Infraestructura
- **Servidor**: Node.js + Express + Socket.io.
- **Cliente**: Vanilla JS/HTML/CSS optimizado para latencia baja.
- **Despliegue**: VM en GCP con túnel Cloudflare Zero Trust, ocultando IP origen y mitigando DDoS.

### Detalles de la VM en GCP
- **Nombre de instancia**: `bingoelus-server`.
- **Región/zona**: `europe-southwest1-c`.
- **Tipo de máquina**: `e2-standard-2` (2 vCPU, 8 GB RAM).
- **SO base**: Ubuntu 22.04 LTS (`ubuntu-2204-jammy-v20260226`).
- **Arquitectura**: x86_64.
- **Compute Engine (Linux con systemd)**: el servidor corre como proceso Node.js gestionado por systemd.
- **Disco persistente**: resultados y cartones ganadores se guardan en disco y se respaldan con el job de backup.
- **Red/seguridad**: el acceso público se sirve a través de Cloudflare Tunnel (Zero Trust), evitando exponer la IP origen.
- **Health checks**: endpoint `/healthz` local para verificación operativa y watchdog del túnel.
- **Servicios operativos**: watchdog de cloudflared y backups automatizados descritos en `ops/watchdog` y `ops/backup`.

### Watchdog y backup (operación en VM)
- **Watchdog de cloudflared**: systemd timer que verifica el túnel y el endpoint `/healthz`. Si detecta caída o degradación, reinicia el servicio para restaurar la conectividad pública.
- **Backup automatizado**: jobs programados que exportan resultados y cartones ganadores a almacenamiento seguro (local y remoto en un canal del servidor de la comunidad en Discord), con retención configurable.

## Justificación de la selección de tecnologías
- **Node.js**: modelo event-loop ideal para cientos/miles de conexiones concurrentes con I/O no bloqueante.
- **Express**: capa HTTP ligera para endpoints y middleware sin sobrecarga.
- **Socket.io**: tiempo real con WebSocket + fallback, reconexión y eventos tipados por sala.
- **Vanilla JS**: UI ligera y rápida, sin bundles pesados ni dependencias innecesarias.
- **GCP Compute Engine**: control total del runtime, costos predecibles y despliegue simple.
- **Cloudflare Zero Trust**: protege el origen, reduce superficie de ataque y mitiga DDoS.
- **Twitch OAuth**: identidad única por usuario, reduce bots y evita multicuentas.

## Pruebas de estrés
Se incluyen scripts de simulación para validar concurrencia, reconexión y eventos masivos. En pruebas internas se alcanzaron miles de conexiones simultáneas y cientos de miles de eventos procesados en segundos, con latencias bajas en HTTP y WebSocket.

## Stack tecnológico
- **Backend:** Node.js, Express, Socket.io
- **Frontend:** Vanilla JS, HTML5, CSS3
- **Infraestructura:** Google Cloud Platform (GCP), Cloudflare Zero Trust (Tunnels)
- **Integraciones:** Twitch API (OAuth 2.0 & Helix)

## Características clave
- **Panel de gestor protegido** por token para control en tiempo real.
- **Sincronización bidireccional** de estado de cartones y premios.
- **Reconexiones resilientes** con cartones persistidos por Twitch ID.