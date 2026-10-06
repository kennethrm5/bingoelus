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

### Iniciar el gestor de escritorio en Windows

Desde una copia del proyecto, instala las dependencias una vez con `npm install` y luego abre `Iniciar Gestor.bat` para iniciar la aplicación de escritorio. El gestor se conecta al servidor cuya dirección configures en su pantalla de conexión; este archivo no inicia el servidor ni Docker.

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

## Arranque local del servidor con Docker

Se puede ejecutar el servidor de `servidor/` localmente sin instalar Node.js en el equipo. En un checkout nuevo, copia `.env.example` a `.env` y añade ahí la configuración local que necesites:

```powershell
Copy-Item .env.example .env
docker compose up --build
```

No sobrescribas un `.env` existente: puede contener credenciales locales. Cuando el contenedor esté healthy, el servidor estará disponible en el equipo anfitrión y en la red local:

- Aplicación: `http://localhost:3000`
- Estado del servidor: `http://localhost:3000/healthz`
- Panel de moderación: `http://localhost:3000/moderador`

Para abrirlo desde un móvil conectado a la misma Wi-Fi:

1. En Windows, ejecuta `ipconfig` y busca la dirección IPv4 del adaptador Wi-Fi del PC (por ejemplo, `192.168.1.25`).
2. En el móvil, abre `http://192.168.1.25:3000`, sustituyendo la dirección de ejemplo por la del PC. No uses `localhost`: en el móvil apuntaría al propio teléfono.
3. Si no carga, permite las conexiones TCP entrantes al puerto 3000 en el Firewall de Windows para el perfil de red **Privada**. Comprueba también que el PC no esté conectado a una red pública o aislada por el router.

El puerto queda publicado en todas las interfaces del PC, por lo que otros dispositivos de la red local también podrán acceder mientras Compose esté activo. Úsalo solo en una red de confianza y detén el contenedor con `docker compose down` al terminar.

El token local predeterminado del gestor es `local-development-only`; solo debe usarse para desarrollo local. Se puede reemplazar con `GESTOR_TOKEN` en `.env`. Sin credenciales de Twitch se puede comprobar que la página y `/healthz` responden, pero no completar el login ni unirse a una partida autenticada.

### Dominio de pruebas con Cloudflare Tunnel

Para llegar desde Internet por `https://dev.bingoelus.online` sin modificar el túnel de producción de `bingoelus.online`:

1. En Cloudflare Zero Trust, crea un **túnel nombrado independiente** para desarrollo y configura su hostname público `dev.bingoelus.online` con el servicio de origen `http://servidor:3000`. Esto crea/usa la ruta DNS del subdominio; no cambies la ruta existente de `bingoelus.online`.
2. Copia el token de ese túnel de desarrollo a `CLOUDFLARED_TUNNEL_TOKEN` en `.env`.
3. En `.env`, configura `BASE_URL=https://dev.bingoelus.online`, además de `TWITCH_CLIENT_ID` y `TWITCH_CLIENT_SECRET`. En la consola de Twitch registra exactamente `https://dev.bingoelus.online/auth/twitch/callback` como OAuth Redirect URL.
4. Arranca el servidor y el túnel:

   ```powershell
   docker compose --profile tunnel up --build
   ```

El túnel sale desde el PC hacia Cloudflare; no requiere abrir puertos en el router. Para detener servidor y túnel, ejecuta `docker compose down`. El túnel de producción de GCP sigue siendo independiente. Si el hostname ya está asociado a otro túnel, Cloudflare no podrá asignarlo a este hasta que se libere esa ruta DNS.

Para volver a pruebas solo locales, omite `--profile tunnel` y cambia `BASE_URL` en `.env` a `http://localhost:3000`. No compartas ni subas `.env`: contiene el token del túnel y credenciales OAuth.

Los resultados y las cuentas baneadas se conservan en los volúmenes Docker `resultados` y `cuentas-baneadas` al parar el servicio con `docker compose down`. `docker compose down -v` también elimina ambos volúmenes y esos datos locales.

El panel de moderación permite banear permanentemente una cuenta autenticada de Twitch desde el cartón del jugador y desbanearla desde la lista de cuentas baneadas. El servidor expulsa sus conexiones activas y rechaza nuevos intentos de entrada. En Docker, los baneos persisten en el volumen `cuentas-baneadas`; en una instalación directa de Node.js se guardan en `servidor/datos/cuentas-baneadas.json`. Conserva ese almacenamiento para mantener los baneos después de reiniciar o actualizar el servidor.
## Regresión de sincronización móvil
La suite `npm run test:sync` valida la recuperación de sesión del jugador y la entrega de las marcas. Se ejecuta contra un servidor aislado en `127.0.0.1:3101`; no usa `dev.bingoelus.online` ni el túnel de Cloudflare.

Desde la raíz del repositorio, construye la imagen y arranca el servidor de pruebas:

```powershell
docker build -t bingoelus-servidor -f servidor/Dockerfile .
docker run --rm -d --name bingoelus-sync-test -p 127.0.0.1:3101:3000 -e PORT=3000 -e GESTOR_TOKEN=sync-test-token -e ALLOW_STRESS_BOTS=1 -e ONLINE_MEDIA_THRESHOLD=100 -e ONLINE_ALTA_THRESHOLD=101 -e HEALTHZ_VERBOSE=1 bingoelus-servidor
npm run test:sync
docker stop bingoelus-sync-test
```

El umbral reducido permite probar el rate limit adaptativo con 100 clientes simulados. La suite comprueba que la última instantánea sigue llegando aunque el cliente envíe cada 120 ms y el servidor aplique un intervalo de 160 ms. El navegador guarda el cartón, el nombre y las marcas en el dispositivo, muestra el estado de conexión y los restaura automáticamente tras una reconexión o recarga. Esos datos locales se eliminan cuando el cliente recibe el inicio de una nueva partida.

## Stack tecnológico
- **Backend:** Node.js, Express, Socket.io
- **Frontend:** Vanilla JS, HTML5, CSS3
- **Infraestructura:** Google Cloud Platform (GCP), Cloudflare Zero Trust (Tunnels)
- **Integraciones:** Twitch API (OAuth 2.0 & Helix)

## Características clave
- **Panel de gestor protegido** por token para control en tiempo real.
- **Sincronización bidireccional** de estado de cartones y premios.
- **Reconexiones resilientes** con cartones persistidos por Twitch ID.