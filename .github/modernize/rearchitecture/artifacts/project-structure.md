# Project structure

## Project type

Full-stack application repository with a separately deployable Node.js game server, static browser clients, a Windows Electron manager, and operational systemd scripts. The source tree is not a single deployable: the documented GCP runtime is `servidor/`; the root Electron app is the manager client.

## Tracked file counts

The repository has 70 tracked files: 5 JavaScript, 4 HTML, 5 JSON, 3 shell scripts, 2 systemd services, 2 systemd timers, 2 environment examples, 2 Markdown files, 44 media assets, and `.gitignore`. The `servidor/` subtree has 18 tracked files: 3 JavaScript, 3 HTML, 3 JSON, 2 shell scripts, 2 services, 2 timers, 2 environment examples, and 1 Markdown file.

## Runtime/deployment boundaries

- `servidor/server.js` is the GCP process entrypoint. It creates one Express HTTP server and attaches Socket.IO. It serves the player and moderator assets from `servidor/public/`.
- `servidor/public/index.html` and `cliente.js` form the player app. The responsive HTML includes mobile viewport metadata; both mobile and desktop clients use `/jugador`.
- `servidor/public/moderador.html` is the hosted moderator client. It connects to the server's `/gestor` namespace using a moderator token.
- Root `main.js` starts a small local Express server for Electron, serving root `gestor.html` and media. `gestor.html` separately connects to the remote `/gestor` namespace.
- `servidor/moderador.js` is an additional command-line client, defaulting to `http://localhost:3000/gestor`; no production use is declared in the README.
- `servidor/ops/watchdog` and `servidor/ops/backup` contain systemd service/timer and shell-script pairs. The checked-in watchdog environment is an example, not evidence of the VM's installed values.

## Layers and functional areas

| Layer / area | Main files | Responsibility |
|---|---|---|
| HTTP/API and game runtime | `servidor/server.js` | Express routes, Twitch OAuth/session maps, Socket.IO namespaces, authoritative game state, validation, rate limits, manager/player broadcasts, health endpoint |
| Player presentation and local state | `servidor/public/index.html`, `servidor/public/cliente.js` | Twitch login UI, player name entry, cart rendering, local checkbox state, mark-event emission, prize claims |
| Moderator presentation | `servidor/public/moderador.html` | Hosted management UI, list/search/rendering of players, controls over `/gestor` |
| Desktop manager presentation | `gestor.html`, `main.js` | Electron window and local asset server; remote Socket.IO manager client |
| Terminal moderator | `servidor/moderador.js` | Optional CLI for phrase state and manager events |
| Operations | `servidor/ops/**` | Cloudflared health/watchdog and result-file backup timers |
| Static data/assets | `servidor/casillas.json`, `servidor/public/reglas.txt`, `media/**`, `servidor/public/media/**` | Phrase-image mappings, rules, images, and audio |

## Network flow

1. Browser traffic enters through the public Cloudflare Tunnel URL and reaches the server on port 3000 according to the README/ops examples.
2. Express serves the player page, moderator page, OAuth endpoints, `/api/casillas`, and `/healthz`.
3. Socket.IO exposes `/jugador` and `/gestor` namespaces on that same HTTP server. The player namespace requires a Twitch session cookie for joining; the manager namespace authenticates with a token.
4. Player marks are sent to the server; the server validates membership in the player's 25-cell card and emits batched mark deltas to manager clients.
5. The manager and hosted moderator display the same server summary and Socket.IO mark deltas.

## Failure-mode evidence: mobile presence and marks

- The player page performs a local visual toggle before sending a mark snapshot. The UI does not wait for a server acknowledgement.
- The server's source of online presence is `estado.jugadores`, keyed by the current Socket.IO `socket.id`. On disconnect it copies game flags/marks to the in-memory Twitch-keyed token entry and deletes that socket-keyed online entry.
- Socket.IO can reconnect the transport, but the player client's `connect` handler only logs the connection. The initial `jugador:unirse` is sent by the "Entrar" action; no rejoin is sent after reconnect. The new socket ID therefore has no player object, and mark updates are silently ignored.
- Mark sender throttle is fixed at 120 ms in the browser. Server-side pacing is adaptive (120/160/220 ms defaults, based on online count). The server silently returns on a too-early event; the client has no acknowledgement/retry for this update. Thus the visible local mark can diverge even when the transport is connected.
- Claim handlers include the current local marked set in the claim event, but only apply it after finding a registered player for the current socket. This explains why clicking a claim can appear to be the first point at which marks are sent, but it cannot repair an unregistered/reconnected socket by itself.
- Both manager UIs receive player lists and mark deltas from `/gestor`. The list reflects server registration, not the browser's local state.

The static evidence establishes the missing application-level rejoin and silent mark-drop paths. It does not establish how often mobile browsers lose the transport, whether Cloudflare caused a given disconnect, or the VM's effective environment values.

## Configuration and source/documentation discrepancies

- The README describes compact mode above 300 connected players; `server.js` switches to compact mode above `GESTOR_FULL_THRESHOLD = 100` and returns at most 100 cards. Verify which behavior is intended.
- `servidor/ops/README.md` documents a `/srv/bingoelus` layout, while the backup script defaults to `/opt/bingoelus`. The watchdog service also references `/opt/bingoelus`; verify installed paths rather than inferring them from either document.
- The README says the server runs under systemd, but the repository does not contain a systemd unit for the Node server. Its actual unit, `ExecStart`, environment, restart policy, and Node version are not inferable here.
- The source has a `config.example.json`; actual runtime secrets/config are intentionally excluded from these artifacts.

## Entry points

- Node server: `servidor/server.js`
- Electron manager: `main.js` → `gestor.html`
- Player browser page: `/`, `/jugador`, `/jugador.html`
- Hosted moderator page: `/moderador`, `/moderador.html`
- Operations: `cloudflared-watchdog.timer` and `bingoelus-backup.timer`
- Optional CLI: `servidor/moderador.js`

Test-only `servidor/public/test-sala.html` and root stress scripts are not production units.
