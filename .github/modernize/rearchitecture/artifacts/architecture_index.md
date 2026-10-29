# Bingoelus — Implementation Guide

This index is not the full contract. Do not implement from this file alone; follow the artifact paths below.

## Scope and evidence

The deployed application described here is `servidor/`: a Node.js/Express/Socket.IO process serving browser clients from a GCP VM behind Cloudflare Tunnel. The Electron manager is a separate desktop client in the repository root. See `project-structure.md` and `tech-stack.md` for the source-backed topology.

The mobile-player symptom is consistent with two independent code paths:

- After a Socket.IO reconnect, the player client only logs `connect`; it does not emit `jugador:unirse` again. The server keys `estado.jugadores` by the new `socket.id`, deletes the previous entry on disconnect, and ignores mark updates when that ID is not registered. Read `units/player-web/behavior.yaml`, `units/game-server/behavior.yaml`, and the player Socket.IO rows in `wire_contracts.yaml`.
- Mark updates are optimistic in the browser and have no acknowledgement. The browser throttles at a fixed 120 ms; the server may require 160 or 220 ms under configured online thresholds and silently drops too-early events. Read the same unit behavior files and the `jugador:actualizar-marcadas` contract.

These are static-code findings, not proof of a particular mobile OS, network, or Cloudflare incident. The watchdog checks HTTP health and tunnel services; it does not exercise Socket.IO join/mark flows.

## Global artifacts

- `project-structure.md` — project boundaries, layers, and evidence relevant to the reported behavior.
- `tech-stack.md` — observed languages, runtime declarations, frameworks, dependencies, and deployment notes.
- `unit_graph.yaml` — externally triggered application and operations units; use unit names as filter keys.
- `wire_contracts.yaml` — REST and Socket.IO contract shapes; filter rows by `unit`.
- `shared_modules.yaml` — source modules shared by multiple units. It is empty because no shared source file was found across the units.
- `cross_unit_state.yaml` — implicit state shared across units. Explicit HTTP/Socket.IO boundaries are recorded in `wire_contracts.yaml`; no additional implicit cross-unit flow was found.

No `data-model.md` is emitted: the repository contains no database client, ORM, or persisted entity schema. Game state and player tokens are held in process memory.
No `migration_boundary.yaml` or `seams.yaml` is emitted: this task requests analysis, not a migration or partial rewrite.

## Unit guide

### `game-server`
- External triggers: Express HTTP routes and Socket.IO namespaces `/jugador` and `/gestor`.
- Read `units/game-server/behavior.yaml` for state transitions, rate limiting, disconnect cleanup, and runtime caveats.
- Read `units/game-server/bindings.yaml` for routes, namespaces, and environment settings.
- Filter `wire_contracts.yaml` to `unit: game-server`; it includes player updates and manager broadcasts.
- `units/game-server/unit_decomposition.yaml` contains advisory split candidates only (`commit: false`).
- Before marking work done, report the server behavior/contracts read, every preserved side effect, unresolved runtime-only checks, and test/build/runtime evidence.

### `player-web`
- External trigger: browser page `/` or `/jugador`; mobile and desktop use the same page.
- Read `units/player-web/behavior.yaml` for local marking, join/reconnect lifecycle, and UI/server divergence.
- Read `units/player-web/bindings.yaml` for page and Socket.IO setup.
- Filter `wire_contracts.yaml` to `unit: game-server` for the endpoint this client consumes.
- `units/player-web/unit_decomposition.yaml` is advisory only (`commit: false`).
- Before marking work done, report the join/reconnect and marking contracts preserved, any unresolved client/server delivery behavior, and browser/runtime verification evidence.

### `moderator-web`
- External trigger: browser page `/moderador`; uses `/gestor` for state and player-list updates.
- Read `units/moderator-web/behavior.yaml` and `units/moderator-web/bindings.yaml`.
- Filter `wire_contracts.yaml` to `unit: game-server`; the player list and mark deltas are server-originated events.
- `units/moderator-web/unit_decomposition.yaml` is advisory only (`commit: false`).
- Before marking work done, report the player-list and mark-delta behavior verified and reconnect/runtime evidence.

### `desktop-gestor`
- External trigger: Electron application loads local `gestor.html`, then connects to a configured remote `/gestor` namespace.
- Read `units/desktop-gestor/behavior.yaml` and `units/desktop-gestor/bindings.yaml`.
- Filter `wire_contracts.yaml` to `unit: game-server`.
- `units/desktop-gestor/unit_decomposition.yaml` is advisory only (`commit: false`).
- Before marking work done, report manager state synchronization and remote reconnection verification.

### `terminal-moderator`
- External trigger: direct Node.js execution of `servidor/moderador.js`.
- Read `units/terminal-moderator/behavior.yaml` and `units/terminal-moderator/bindings.yaml`.
- Filter `wire_contracts.yaml` to `unit: game-server`.
- `units/terminal-moderator/unit_decomposition.yaml` is advisory only (`commit: false`).
- Before marking work done, report whether this optional CLI is actually used in deployment; its default endpoint is localhost.

### `cloudflared-watchdog`
- External trigger: systemd timer, configured for every 30 seconds in the checked-in timer file.
- Read `units/cloudflared-watchdog/behavior.yaml` and `units/cloudflared-watchdog/bindings.yaml`.
- It probes HTTP health and cloudflared service/tunnel status; it does not check player namespace or event delivery.
- `units/cloudflared-watchdog/unit_decomposition.yaml` is advisory only (`commit: false`).
- Before marking work done, report the installed VM environment values and actual systemd service names; the checked-in environment file is an example.

### `backup-job`
- External trigger: systemd timer.
- Read `units/backup-job/behavior.yaml` and `units/backup-job/bindings.yaml`.
- It archives configured filesystem paths, not in-memory game sessions or the player token map.
- `units/backup-job/unit_decomposition.yaml` is advisory only (`commit: false`).
- Before marking work done, report the installed source paths, destination, retention, and job logs; repository defaults differ between `/opt` and `/srv` documentation.
