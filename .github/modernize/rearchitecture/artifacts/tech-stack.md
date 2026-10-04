# Existing technology stack

## Runtime and application languages

- Server: JavaScript on Node.js; `servidor/package.json` identifies `servidor/server.js` as its entrypoint. No `engines` field or pinned Node version is present.
- Desktop manager: JavaScript with Electron; root `package.json` identifies `main.js`. Electron is declared as `^28.0.0`.
- Browser clients: vanilla JavaScript, HTML, and inline CSS; no frontend build system or bundler is declared.
- Operations: Bash scripts and systemd unit/timer files.
- README-described host: GCP Compute Engine `e2-standard-2`, Ubuntu 22.04 LTS, x86_64, zone `europe-southwest1-c`, behind Cloudflare Zero Trust Tunnel. Treat these as README claims, not live VM verification.

## Frameworks and dependencies

### Server package (`servidor/package.json`, package version 2.1.1)

- `compression` `^1.7.4`
- `express` `^4.18.3`
- `socket.io` `^4.7.2`

There is no checked-in server `package-lock.json` or explicit Node engine version.

### Root desktop-manager package (`package.json`, package version 3.1.0)

- Runtime dependencies: `compression` `^1.8.1`, `express` `^4.18.3`, `socket.io` `^4.8.3`
- Development dependencies: `electron` `^28.0.0`, `electron-builder` `^24.13.3`, `socket.io-client` `^4.8.3`
- Windows x64 NSIS packaging is configured in `package.json`; `main.js` hosts `gestor.html` locally on `127.0.0.1:3001`.

The hosted moderator page loads Socket.IO client 4.7.5 from the Socket.IO CDN. The player page loads the client script served by the same Socket.IO server instance.

## Integrations and state

- Twitch OAuth 2.0 and Twitch user lookup/API calls are implemented in `servidor/server.js`; authentication session/state maps are in process memory.
- Cloudflare Tunnel is the documented public ingress. Web clients configure WebSocket first and polling as the alternative; the server supports both unless `SOCKET_IO_WEBSOCKET_ONLY=1`.
- Discord webhook notifications and optional GCS (`gsutil`) / rclone backup targets are represented in server/ops configuration.
- No database, ORM, message broker, or persistent session store is present in the inspected project.
- Game/player state, Twitch session maps, and player tokens are in server memory. Result files are written under `servidor/resultados`; backup scripts archive configured filesystem paths. A process restart therefore cannot be assumed to restore an active game or its in-memory player token map.

## Runtime and operations settings relevant to connectivity

The server defaults are Socket.IO ping interval 25 seconds, ping timeout 30 seconds, connect timeout 45 seconds, and upgrade timeout 30 seconds. They can be overridden by environment variables; the repository does not establish the effective VM values. Mark pacing defaults to 120/160/220 ms at online thresholds 400/800. The browser uses a fixed 120 ms local throttle.

The watchdog runs every 30 seconds in the checked-in timer and probes local `/healthz`, optional public `/healthz`, systemd service state, and optional tunnel connection counts. `/healthz` is an HTTP process/game summary; no Socket.IO application-level health probe is implemented.
