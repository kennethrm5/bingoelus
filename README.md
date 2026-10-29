<h1>
  <img src="media/bingoelus.png" alt="Bingoelus Logo" width="80" style="vertical-align: middle; margin-right: 10px;">
  Bingoelus - Bingo interactivo a tiempo real para Twitch
</h1>


![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)
![Socket.io](https://img.shields.io/badge/Socket.io-010101?style=for-the-badge&logo=socket.io&logoColor=white)
![Google Cloud](https://img.shields.io/badge/GoogleCloud-%234285F4.svg?style=for-the-badge&logo=google-cloud&logoColor=white)
![Cloudflare](https://img.shields.io/badge/Cloudflare-F38020?style=for-the-badge&logo=Cloudflare&logoColor=white)
![Nginx](https://img.shields.io/badge/Nginx-009639?style=for-the-badge&logo=nginx&logoColor=white)

Plataforma web *full-stack* de alta concurrencia diseñada para que miles de espectadores de Twitch jueguen al bingo simultáneamente en tiempo real, totalmente sincronizada con un *streaming* en directo.

---

## 🎯 Problema Original y Desafíos de Red

El proyecto nace para solucionar dos limitaciones graves observadas en plataformas de terceros durante transmisiones en vivo:
1. **Fraude masivo:** Inseguridad del lado del cliente que permitía falsificar victorias mediante la manipulación del DOM o peticiones HTTP arbitrarias.
2. **Colapsos de infraestructura:** Caídas por estampidas de tráfico (*thundering herd*) cuando miles de espectadores accedían simultáneamente al recibir la orden en el directo.
3. **Bloqueos colaterales de ISP (LaLiga / Operadoras en España):** Bloqueos indiscrimados aplicados por las principales operadoras españolas (Vodafone, DIGI, etc.) sobre los rangos de IP compartidos de la red gratuita de Cloudflare (`188.114.96.0/22`) durante eventos deportivos.

---

## 🏗️ Arquitectura de Red y Alta Disponibilidad

La arquitectura se fundamenta en el principio **Server-Side Source of Truth (SSOT)**: el servidor central es la única entidad con capacidad para validar el estado de la partida, los marcados de los cartones y la legitimidad de los premios.

### 🌐 Diagrama de Enrutamiento y Dominio Puente (Cloudflare for SaaS)

Para eludir los bloqueos de IP en España sin exponer la IP pública de la máquina en GCP ni sacrificar los túneles ciegos, se implementa un esquema de enrutamiento mediante **Cloudflare for SaaS (Custom Hostnames)** con un dominio puente intermedio (`3829104.xyz`).

```text
[ Jugador en España ] 
         │
         ▼
[ bingoelus.online ] ──( CNAME - DNS Only / Nube Gris )
         │
         ▼
[ 3829104.xyz ] ──( Fallback Origin - Custom Hostname / Nube Naranja )
         │  └─► Asigna IP limpia en Edge (104.21.x.x / 172.67.x.x)
         ▼
[ Cloudflare Zero Trust Tunnel ] (Protocolo HTTP/2 - Dual HA)
         │
         ▼
[ GCP Compute Engine (Ubuntu 22.04) ]
   ├── Nginx (Reverse Proxy & WebSockets / worker_connections 8192)
   └── Node.js + Express + Socket.io (PM2 Cluster)
```

#### Mecanismo Anti-Bloqueo de ISP:
* **Dominio Público (`bingoelus.online`):** Apunta mediante un registro `CNAME` en modo *DNS Only* (Nube Gris) hacia el dominio puente.
* **Dominio Puente (`3829104.xyz`):** Configurado como *Fallback Origin* en Cloudflare for SaaS. Absorbe la resolución DNS inicial y le asigna al tráfico entrante direcciones IP limpias fuera del rango manchado por listas negras.
* **Custom Hostname:** `bingoelus.online` está dado de alta en la capa empresarial de SaaS de Cloudflare con emisión automática de certificado SSL (TLS 1.2/1.3) vía verificación HTTP, entregando el tráfico directamente al *Tunnel* de producción.

---

## 🚀 Componentes de la Aplicación

### Arquitectura de Clientes
- **Gestor (Panel de Control):** Aplicación de escritorio nativa desarrollada en Electron, conectada por WebSocket con cifrado y token de autorización.
- **Moderadores y Jugadores:** Interfaz web ligera en Vanilla JS/HTML5/CSS3 alojada en el servidor, accesible desde `https://bingoelus.online`.
- **Servidor Central:** Orquestador de partidas, validador de premios en tiempo real y emisor de eventos mediante Socket.io.

### Flujo Principal de Ejecución
1. **Autenticación OAuth 2.0 (Twitch API):** Identidad única por usuario para garantizar 1 cartón por cuenta y prevenir multicuentas/bots.
2. **Sincronización en Tiempo Real:** Comunicación bidireccional continua mediante Socket.io con mecanismos de reconexión transparente.
3. **Validación Optimista (Optimistic Execution):**
   - Reclamaciones válidas de *Línea* o *Bingo*: Procesamiento instantáneo en 0 ms sin *cooldown*.
   - Reclamaciones inválidas: Aplicación adaptativa de *rate limiting* y penalizaciones temporales (*cooldown*) para mitigar el spam de peticiones.
4. **Modo Compacto de Escalabilidad:** Cuando se superan los 300 jugadores activos, el servidor conmuta a un modo optimizado enviando al gestor únicamente el top de cartones más cercanos a ganar y delegando la búsqueda de cartones al servidor.

---

## 🛠️ Infraestructura y Servidor en Google Cloud Platform

### Especificaciones de la Instancia GCP
- **Instancia**: `bingoelus-server`
- **Región / Zona**: `europe-southwest1-c` (Madrid)
- **Tipo de máquina**: `e2-standard-2` (2 vCPU, 8 GB RAM)
- **Sistema Operativo**: Ubuntu 22.04 LTS (`x86_64`)
- **Web Server / Reverse Proxy**: Nginx optimizado (`worker_rlimit_nofile 65535`, `worker_connections 8192`, soportes Keep-Alive y WebSockets).
- **Runtime**: Node.js 20+ gestionado mediante **PM2**.
- **Conectividad de Red**: Cloudflare Tunnel (`cloudflared`) forzado sobre protocolo **HTTP/2 (TCP)** con duplicación de procesos (Servicio Principal + Servicio Clon) para lograr **8 vías de conexión concurrentes (High Availability)**.

### Sistema de Operaciones, Watchdog y Backup (Capacidad DR)
- **Watchdog Autónomo (`cloudflared-watchdog`):** Timer de *systemd* que ejecuta comprobaciones cada 30s sobre `/healthz` (salud local) y la URL pública. Ante degradación o caída del socket, aplica autocorrección y reinicio ordenado del servicio.
- **Backup Híbrido Incremental (`bingoelus-backup`):**
  - **Inmediato (UX / Streamer):** Notificación asíncrona no bloqueante vía **Discord Webhooks** (`multipart/form-data`) al cantar un cartón o finalizar partida, enviando resúmenes `.txt` y los `.png` de cartones ganadores.
  - **Programado (DR / Disaster Recovery):** Sincronización periódica incremental mediante `gsutil` hacia un bucket de **Google Cloud Storage (`gs://...`)**, con rotación `.tar.gz` y retención de 30 días.

---

## 📦 Guía de Instalación y Despliegue en GCP

### 1. Despliegue Inicial en VM

```bash
# Preparar directorios operativos
sudo mkdir -p /opt/bingoelus
sudo chown "$USER":"$(id -gn)" /opt/bingoelus
npm install --global pm2

# Clonar repositorio y ejecutar instalador
git clone --branch main git@github.com:kennethrm5/bingoelus.git /opt/bingoelus-repo
cd /opt/bingoelus-repo
bash servidor/ops/gcp/install.sh
```

### 2. Configuración de Variables de Entorno (`/opt/bingoelus/config.json`)
Edita el archivo de configuración generado e inyecta las credenciales requeridas:

```json
{
  "baseUrl": "https://bingoelus.online",
  "gestorToken": "TU_GESTOR_TOKEN_SECRETO",
  "twitchClientId": "TU_TWITCH_CLIENT_ID",
  "twitchClientSecret": "TU_TWITCH_CLIENT_SECRET",
  "discordWebhookUrl": "https://discord.com/api/webhooks/TU_WEBHOOK_URL"
}
```

Aplica permisos restrictivos y completa la instalación:
```bash
chmod 600 /opt/bingoelus/config.json
bash servidor/ops/gcp/install.sh
pm2 startup systemd
pm2 save
```

### 3. Actualizaciones Continuas
Para aplicar cambios en producción sin alterar estados ni archivos generados en caliente:
```bash
cd /opt/bingoelus-repo
bash servidor/ops/gcp/update.sh
```

---

## 💻 Entorno de Desarrollo Local con Docker

Puedes ejecutar el entorno completo localmente sin instalar Node.js en tu sistema anfitrión:

```powershell
# Iniciar servidor en entorno aislado
Copy-Item .env.example .env
docker compose up --build servidor
```

Acceso local:
- **Aplicación Web:** `http://localhost:3000`
- **Health check:** `http://localhost:3000/healthz`
- **Panel de Moderación:** `http://localhost:3000/moderador`

### Dominio de Pruebas con Cloudflare Tunnel Local
Para exponer la instancia local mediante un túnel staging (`https://dev.bingoelus.online`):
1. Asigna el token de desarrollo a `CLOUDFLARED_TUNNEL_TOKEN` en tu `.env`.
2. Asigna `BASE_URL=https://dev.bingoelus.online` y configura la URL de redirección en la consola de desarrolladores de Twitch.
3. Inicia la pila completa:
```powershell
docker compose up --build
```

---

## 🧪 Pruebas de Carga y Estrés

El proyecto incluye scripts de simulación multihilo para validar la estabilidad en escenarios extremas:

```powershell
# Ejecución del test de estrés (1000 conexiones concurrentes durante 600s)
node stress-test.js https://bingoelus.online 1000 600 30000
```

---

## 🛠️ Stack Tecnológico

- **Backend:** Node.js (v20+), Express, Socket.io, PM2.
- **Frontend:** Vanilla JS (ES6+), HTML5, CSS3 (Optimizado para ultra-baja latencia).
- **Desktop Client:** Electron, Electron-Builder (Windows NSIS x64).
- **Infraestructura Cloud:** Google Cloud Platform (Compute Engine & Cloud Storage).
- **Red y Seguridad:** Cloudflare Zero Trust Tunnels, Cloudflare for SaaS (Custom Hostnames), Nginx.
- **Integraciones externas:** Twitch API (OAuth 2.0 & Helix), Discord Webhooks API.