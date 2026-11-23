#!/usr/bin/env bash
set -Eeuo pipefail

DRY_RUN=0
SWAP_MB=2048
SKIP_SWAP=0
SKIP_BACKUP_ENV=0
INSTALL_DIR="${BINGOELUS_INSTALL_DIR:-/opt/bingoelus}"

usage() {
  cat <<'EOF'
Uso: harden-vm.sh [OPCIONES]

Endurecimiento idempotente para la VM de Bingoelus en GCP:
1. Activa journald persistente (/var/log/journal)
2. Crea /swapfile de 2048 MiB (si no hay swap) y configura vm.swappiness=10
3. Habilita arranque automático de nginx, cloudflared, timers de watchdog/backup y Restart=always en nginx
4. Actualiza /etc/default/bingoelus-backup para incluir /opt/bingoelus/datos en vivo
5. Verifica PM2 startup y sugiere comandos gcloud si falta automatic-restart / MIGRATE

Opciones:
  --dry-run            Muestra todas las acciones sin modificar el sistema
  --swap-mb N          Tamaño del archivo swap en MiB (por defecto: 2048)
  --skip-swap          Omite la creación/configuración de swap
  --skip-backup-env    Omite la actualización de /etc/default/bingoelus-backup
  --install-dir DIR    Ruta de instalación activa (por defecto: /opt/bingoelus)
  -h, --help           Muestra esta ayuda
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --swap-mb)
      [[ $# -ge 2 && "$2" =~ ^[0-9]+$ && "$2" -ge 128 ]] || { echo "Error: --swap-mb debe ser un entero >= 128." >&2; exit 2; }
      SWAP_MB="$2"
      shift 2
      ;;
    --skip-swap)
      SKIP_SWAP=1
      shift
      ;;
    --skip-backup-env)
      SKIP_BACKUP_ENV=1
      shift
      ;;
    --install-dir)
      [[ $# -ge 2 ]] || { echo "Error: --install-dir requiere un valor." >&2; exit 2; }
      INSTALL_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Opción no reconocida: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$DRY_RUN" -eq 0 && "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Error: harden-vm.sh debe ejecutarse como root (usa sudo) o con --dry-run." >&2
  exit 1
fi

run_cmd() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[DRY-RUN] %s\n' "$*"
  else
    "$@"
  fi
}

write_file_if_changed() {
  local target="$1"
  local content="$2"
  local mode="${3:-0644}"
  local current=""
  if [[ -r "$target" ]]; then
    current="$(cat "$target")"
  fi
  if [[ "$current" == "$content" ]]; then
    return 1
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[DRY-RUN] Escribir %s (mode %s)\n' "$target" "$mode"
    return 0
  fi
  mkdir -p "$(dirname "$target")"
  printf '%s\n' "$content" > "${target}.tmp"
  chmod "$mode" "${target}.tmp"
  mv -f "${target}.tmp" "$target"
  return 0
}

echo "=== 1. Journald persistente ==="
if [[ ! -d /var/log/journal ]]; then
  run_cmd mkdir -p /var/log/journal
fi
journal_cfg=$'[Journal]\nStorage=persistent\nSystemMaxUse=256M\nMaxRetentionSec=14day'
if write_file_if_changed "/etc/systemd/journald.conf.d/bingoelus-persistent.conf" "$journal_cfg" 0644; then
  run_cmd systemctl restart systemd-journald
  echo "[OK] Configurado journald persistente."
else
  echo "[OK] Journald persistente ya estaba configurado."
fi

echo "=== 2. Swap (${SWAP_MB} MiB) y vm.swappiness=10 ==="
if [[ "$SKIP_SWAP" -eq 1 ]]; then
  echo "[INFO] --skip-swap activo; se omite configuración de swap."
else
  has_swap=0
  if command -v swapon >/dev/null 2>&1 && swapon --show --noheadings 2>/dev/null | grep -q .; then
    has_swap=1
  fi

  if [[ "$has_swap" -eq 0 ]]; then
    if [[ ! -f /swapfile ]]; then
      if command -v fallocate >/dev/null 2>&1; then
        run_cmd fallocate -l "${SWAP_MB}M" /swapfile || run_cmd dd if=/dev/zero of=/swapfile bs=1M count="$SWAP_MB" status=progress
      else
        run_cmd dd if=/dev/zero of=/swapfile bs=1M count="$SWAP_MB" status=progress
      fi
    fi
    run_cmd chmod 600 /swapfile
    run_cmd mkswap /swapfile
    run_cmd swapon /swapfile
    if ! grep -qE '^/swapfile[[:space:]]' /etc/fstab 2>/dev/null; then
      if [[ "$DRY_RUN" -eq 1 ]]; then
        echo "[DRY-RUN] Añadir '/swapfile none swap sw 0 0' a /etc/fstab"
      else
        printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
      fi
    fi
    echo "[OK] Swap /swapfile (${SWAP_MB} MiB) activado."
  else
    echo "[OK] Ya existe swap activo en el sistema."
  fi

  sysctl_cfg='vm.swappiness=10'
  if write_file_if_changed "/etc/sysctl.d/99-bingoelus-swap.conf" "$sysctl_cfg" 0644; then
    run_cmd sysctl -w vm.swappiness=10
  else
    echo "[OK] vm.swappiness=10 ya estaba configurado."
  fi
fi

echo "=== 3. Servicios systemd, Nginx Restart=always y timers ==="
nginx_override=$'[Service]\nRestart=always\nRestartSec=3'
write_file_if_changed "/etc/systemd/system/nginx.service.d/bingoelus-restart.conf" "$nginx_override" 0644 || true

if command -v systemctl >/dev/null 2>&1; then
  for svc in nginx.service cloudflared.service; do
    if systemctl list-unit-files "$svc" --no-legend 2>/dev/null | grep -q .; then
      run_cmd systemctl enable "$svc"
    fi
  done
  if systemctl list-unit-files cloudflared-clon.service --no-legend 2>/dev/null | grep -q .; then
    run_cmd systemctl enable cloudflared-clon.service
  fi
fi

for unit in \
  "$INSTALL_DIR/ops/watchdog/cloudflared-watchdog.service" \
  "$INSTALL_DIR/ops/watchdog/cloudflared-watchdog.timer" \
  "$INSTALL_DIR/ops/backup/bingoelus-backup.service" \
  "$INSTALL_DIR/ops/backup/bingoelus-backup.timer"; do
  if [[ -f "$unit" ]]; then
    run_cmd cp -f "$unit" /etc/systemd/system/
  else
    echo "[WARN] No se encontró unit file en $unit"
  fi
done

if [[ -f "$INSTALL_DIR/ops/watchdog/bingoelus-cloudflared-watchdog.env.example" ]]; then
  run_cmd cp -n "$INSTALL_DIR/ops/watchdog/bingoelus-cloudflared-watchdog.env.example" /etc/default/bingoelus-cloudflared-watchdog || true
fi
if [[ -f "$INSTALL_DIR/ops/backup/bingoelus-backup.env.example" ]]; then
  run_cmd cp -n "$INSTALL_DIR/ops/backup/bingoelus-backup.env.example" /etc/default/bingoelus-backup || true
fi

if command -v systemctl >/dev/null 2>&1; then
  run_cmd systemctl daemon-reload
  run_cmd systemctl enable --now cloudflared-watchdog.timer
  run_cmd systemctl enable --now bingoelus-backup.timer
fi

echo "=== 4. Actualizar /etc/default/bingoelus-backup para datos en vivo ==="
BACKUP_ENV="/etc/default/bingoelus-backup"
if [[ "$SKIP_BACKUP_ENV" -eq 1 ]]; then
  echo "[INFO] --skip-backup-env activo."
elif [[ -f "$BACKUP_ENV" ]]; then
  if ! grep -Eq '^SOURCE_DIRS=.*(/opt/bingoelus/datos|datos)' "$BACKUP_ENV"; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "[DRY-RUN] Respaldar $BACKUP_ENV a ${BACKUP_ENV}.bak y añadir :/opt/bingoelus/datos en SOURCE_DIRS"
    else
      cp -f "$BACKUP_ENV" "${BACKUP_ENV}.bak"
      node - "$BACKUP_ENV" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
let text = fs.readFileSync(file, 'utf8');
if (/^SOURCE_DIRS=.*$/m.test(text)) {
  text = text.replace(/^SOURCE_DIRS=(.*)$/m, (_, val) => {
    const clean = val.trim().replace(/^["']|["']$/g, '');
    return `SOURCE_DIRS=${clean ? `${clean}:` : ''}/opt/bingoelus/datos`;
  });
} else {
  text = `SOURCE_DIRS=/opt/bingoelus/ganadores:/opt/bingoelus/resultados:/opt/bingoelus/datos\n${text}`;
}
if (!/^LIVE_ONLY_DIRS=/m.test(text)) {
  text += `${text.endsWith('\n') ? '' : '\n'}LIVE_ONLY_DIRS=/opt/bingoelus/datos\n`;
}
if (!/^REMOTE_SYNC_EVERY_MINUTES=/m.test(text)) {
  text += `${text.endsWith('\n') ? '' : '\n'}REMOTE_SYNC_EVERY_MINUTES=10\n`;
}
fs.writeFileSync(file, text, 'utf8');
NODE
      echo "[OK] Actualizado $BACKUP_ENV para respaldar /opt/bingoelus/datos en vivo."
    fi
  else
    echo "[OK] $BACKUP_ENV ya incluye /opt/bingoelus/datos."
  fi
else
  echo "[INFO] No existe $BACKUP_ENV (se creará al copiar la plantilla)."
fi

echo "=== 5. Comprobaciones finales (PM2 & GCP scheduling) ==="
if command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files 'pm2-*.service' --no-legend 2>/dev/null | grep -q .; then
    echo "[OK] Unidad systemd de PM2 detectada."
  else
    echo "[ACCION REQUERIDA] No se detectó pm2-*.service. Ejecuta con tu usuario operativo:"
    echo "  pm2 startup systemd"
    echo "  # (ejecuta el comando sudo que muestre PM2)"
    echo "  pm2 save"
  fi
fi

if command -v curl >/dev/null 2>&1 && inst_name="$(curl -fsS --max-time 2 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/name 2>/dev/null)"; then
  inst_zone="$(curl -fsS --max-time 2 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/zone 2>/dev/null || true)"
  preemptible="$(curl -fsS --max-time 2 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/scheduling/preemptible 2>/dev/null || true)"
  on_host_maint="$(curl -fsS --max-time 2 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/scheduling/on-host-maintenance 2>/dev/null || true)"
  auto_restart="$(curl -fsS --max-time 2 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/scheduling/automatic-restart 2>/dev/null || true)"

  if [[ "$preemptible" == "TRUE" ]]; then
    echo "[ALERTA GCP] La VM es Spot/Preemptible (scheduling/preemptible=TRUE). Migra a aprovisionamiento Standard para evitar apagados repentinos."
  fi
  if [[ "$auto_restart" != "TRUE" || "$on_host_maint" != "MIGRATE" ]]; then
    echo "[ACCION REQUERIDA GCP] Ajusta la política de mantenimiento/reinicio ejecutando desde Cloud Shell o tu PC:"
    echo "  gcloud compute instances set-scheduling ${inst_name} --zone=${inst_zone##*/} --maintenance-policy=MIGRATE --restart-on-failure"
  else
    echo "[OK] Scheduling de GCE correcto (MIGRATE + automatic-restart=TRUE)."
  fi
fi
