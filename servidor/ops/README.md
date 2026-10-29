# Operación en GCP: Cloudflare Tunnel y copias de seguridad

La VM de producción conserva el clon Git en `/opt/bingoelus-repo` y los archivos activos en `/opt/bingoelus`. El servidor de juego corre bajo PM2 desde `/opt/bingoelus/ecosystem.config.cjs`; `cloudflared` permanece como servicio independiente de systemd para mantener sus credenciales fuera del repositorio.

## Actualizar la aplicación

Desde la raíz clonada:

```bash
bash /opt/bingoelus-repo/servidor/ops/gcp/update.sh
```

El script hace `git pull --ff-only`, sincroniza los archivos versionados de `servidor/` al directorio activo, instala las dependencias de producción, recarga el proceso PM2 `bingoelus-server` y valida `http://127.0.0.1:3000/healthz`. Preserva `config.json`, `datos/`, `resultados/` y `node_modules/` en `/opt/bingoelus`.

## Watchdog y backup de systemd

Estos servicios se instalan una vez en la VM. Las plantillas viven junto a sus scripts en `servidor/ops`; los valores locales se guardan en `/etc/default` y no deben reemplazarse durante las actualizaciones. Si ya se habían instalado con una ruta anterior, vuelve a copiar las units y ejecuta `daemon-reload`.

```bash
cd /opt/bingoelus
sudo cp servidor/ops/watchdog/cloudflared-watchdog.service /etc/systemd/system/
sudo cp servidor/ops/watchdog/cloudflared-watchdog.timer /etc/systemd/system/
sudo cp servidor/ops/backup/bingoelus-backup.service /etc/systemd/system/
sudo cp servidor/ops/backup/bingoelus-backup.timer /etc/systemd/system/

sudo cp -n servidor/ops/watchdog/bingoelus-cloudflared-watchdog.env.example /etc/default/bingoelus-cloudflared-watchdog
sudo cp -n servidor/ops/backup/bingoelus-backup.env.example /etc/default/bingoelus-backup
```

`cp -n` evita sobrescribir archivos de configuración existentes. Revisa y edita las copias de `/etc/default` antes de habilitar los timers.

### Watchdog de Cloudflare

Edita `/etc/default/bingoelus-cloudflared-watchdog`:

- `PRIMARY_SERVICE` y, si corresponde, `CLONE_SERVICE`.
- `PUBLIC_HEALTH_URL`, con la URL pública de producción y `/healthz`.
- `PRIMARY_TUNNEL` y `CLONE_TUNNEL`, opcionales para comprobar las conexiones activas.
- `CHECK_CLONE=1` solo si la VM tiene realmente el servicio `cloudflared-clon`; usa `0` si solo existe el servicio principal.

El watchdog consulta el health check local y público. Tras fallos repetidos, reinicia únicamente los servicios cloudflared configurados.

### Copias de seguridad

Edita `/etc/default/bingoelus-backup`:

- `SOURCE_DIRS`: por defecto incluye `/opt/bingoelus/ganadores` y `/opt/bingoelus/resultados`.
- `BACKUP_BASE` y `RETENTION_DAYS`.
- `GSUTIL_BUCKET` para sincronizar en Google Cloud Storage; alternativamente, `RCLONE_TARGET`.
- Opcionalmente, `DISCORD_WEBHOOK_URL` y los ajustes `DISCORD_*` para avisos y adjuntos.

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
