# Operación en GCP: Cloudflare Tunnel y copias de seguridad

La VM de producción conserva el clon Git en `/opt/bingoelus-repo` y los archivos activos en `/opt/bingoelus`. El servidor de juego corre bajo PM2 desde `/opt/bingoelus/ecosystem.config.cjs`; `cloudflared` permanece como servicio independiente de systemd para mantener sus credenciales fuera del repositorio.

## Actualizar la aplicación

Desde la raíz clonada:

```bash
bash /opt/bingoelus-repo/servidor/ops/gcp/update.sh
```

El script hace `git pull --ff-only`, sincroniza los archivos versionados de `servidor/` al directorio activo, instala las dependencias de producción, recarga el proceso PM2 `bingoelus-server` y valida `http://127.0.0.1:3000/healthz`. Preserva `config.json`, `datos/`, `resultados/` y `node_modules/` en `/opt/bingoelus`.

## Watchdog y backup de systemd

Estos servicios se instalan una vez en la VM. Las plantillas viven junto a sus scripts en `ops/` dentro de `/opt/bingoelus`; los valores locales se guardan en `/etc/default` y no deben reemplazarse durante las actualizaciones. Si ya se habían instalado con una ruta o cadencia anterior, vuelve a copiar las units y ejecuta `daemon-reload`.

```bash
cd /opt/bingoelus
sudo cp ops/watchdog/cloudflared-watchdog.service /etc/systemd/system/
sudo cp ops/watchdog/cloudflared-watchdog.timer /etc/systemd/system/
sudo cp ops/backup/bingoelus-backup.service /etc/systemd/system/
sudo cp ops/backup/bingoelus-backup.timer /etc/systemd/system/

sudo cp -n ops/watchdog/bingoelus-cloudflared-watchdog.env.example /etc/default/bingoelus-cloudflared-watchdog
sudo cp -n ops/backup/bingoelus-backup.env.example /etc/default/bingoelus-backup
```

`cp -n` evita sobrescribir archivos de configuración existentes. Revisa y edita las copias de `/etc/default` antes de habilitar los timers.

## Auditoría y endurecimiento de la VM (P1)

Para diagnosticar apagados previos (OOM, ACPI o expulsión Spot/Preemptible) y aplicar el endurecimiento base de la VM:

```bash
# 1. Auditoría de solo lectura (forense, metadatos GCE, swap, servicios, persistencia)
bash /opt/bingoelus/ops/gcp/audit-vm.sh

# 2. Simulación de endurecimiento (--dry-run no modifica nada)
bash /opt/bingoelus/ops/gcp/harden-vm.sh --dry-run

# 3. Aplicar endurecimiento (journald persistente, swap 2 GiB, swappiness=10, Restart=always en nginx y timers)
sudo bash /opt/bingoelus/ops/gcp/harden-vm.sh
```

Si `audit-vm.sh` detecta que falta `pm2-*.service`, ejecuta `pm2 startup systemd` y `pm2 save`. Si `preemptible=TRUE` o falta `automatic-restart`, actualiza la VM a aprovisionamiento Standard con `--maintenance-policy=MIGRATE --restart-on-failure`.

### Watchdog de Cloudflare

Edita `/etc/default/bingoelus-cloudflared-watchdog`:

- `PRIMARY_SERVICE` y, si corresponde, `CLONE_SERVICE`.
- `PUBLIC_HEALTH_URL`, con la URL pública de producción y `/healthz`.
- `PRIMARY_TUNNEL` y `CLONE_TUNNEL`, opcionales para comprobar las conexiones activas.
- `CHECK_CLONE=1` solo si la VM tiene realmente el servicio `cloudflared-clon`; usa `0` si solo existe el servicio principal.

El watchdog consulta el health check local y público. Tras fallos repetidos, reinicia únicamente los servicios cloudflared configurados.

### Copias de seguridad en vivo y restauración de emergencia (P2)

El timer `bingoelus-backup.timer` se ejecuta cada **1 minuto** e incluye `/opt/bingoelus/datos` en `SOURCE_DIRS` junto con `ganadores` y `resultados`:

- `SOURCE_DIRS`: por defecto `/opt/bingoelus/ganadores:/opt/bingoelus/resultados:/opt/bingoelus/datos`.
- `LIVE_ONLY_DIRS`: por defecto `/opt/bingoelus/datos` (actualiza el mirror local y el prefijo `live/` en GCS/rclone sin generar `.tar.gz` cada minuto).
- `REMOTE_SYNC_EVERY_MINUTES`: sincronización periódica completa cada 10 minutos (además de sincronizar `live/` al instante cuando hay cambios en la partida).
- `BACKUP_BASE` y `RETENTION_DAYS`.
- `GSUTIL_BUCKET` para sincronizar en Google Cloud Storage; alternativamente, `RCLONE_TARGET`.

Para recuperar una partida en caso de pérdida de la VM o corrupción local usando `restore-state.sh`:

```bash
# Validar antes sin tocar /opt/bingoelus/datos
bash /opt/bingoelus/ops/backup/restore-state.sh --from-gcs --dry-run

# Restaurar desde GCS (o --from-local / --from-rclone) y reiniciar bingoelus-server en PM2
sudo bash /opt/bingoelus/ops/backup/restore-state.sh --from-gcs --restart-pm2
```

### Activar y comprobar los timers

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-watchdog.timer
sudo systemctl enable --now bingoelus-backup.timer

curl -fsS http://127.0.0.1:3000/healthz
sudo systemctl status cloudflared-watchdog.timer --no-pager
sudo systemctl status bingoelus-backup.timer --no-pager
```

Consulta los logs con `journalctl -u cloudflared-watchdog.service` y `journalctl -u bingoelus-backup.service`. Los tokens de Cloudflare, secretos de Twitch, tokens del gestor y webhooks deben residir en configuraciones locales ignoradas por Git o en `/etc/default`, nunca en el repositorio.
