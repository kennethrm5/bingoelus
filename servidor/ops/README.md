## Ops: Watchdog + Backup

Guia de despliegue operativo para mantener el tunel de Cloudflare saludable y asegurar respaldos automáticos.

### Requisitos
- Linux con systemd.
- `cloudflared` instalado y configurado como servicio.
- Permisos de `sudo` para instalar units.

### Estructura esperada
- `/srv/bingoelus` (ruta base generica del proyecto).
- `ops/watchdog` y `ops/backup` dentro del repo.

### 1) Instalar scripts y units en la VM

```bash
cd /srv/bingoelus
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
	- `SOURCE_DIRS` (por defecto: `/srv/bingoelus/ganadores:/srv/bingoelus/servidor/resultados`)
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
	- `DISCORD_WINNERS_DIR=/srv/bingoelus/ganadores`
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

### Notas operativas
- El watchdog reinicia el servicio `cloudflared` si detecta fallo del tunel o un `healthz` no valido.
- El backup soporta destinos locales y remotos (GCS o rclone), con retención configurada por días.