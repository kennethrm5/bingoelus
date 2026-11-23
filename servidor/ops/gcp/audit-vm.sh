#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="${BINGOELUS_INSTALL_DIR:-/opt/bingoelus}"
STRICT=0

usage() {
  cat <<'EOF'
Uso: audit-vm.sh [OPCIONES]

Auditoría de solo lectura para la VM de Bingoelus en GCP:
- Forense del último apagado/reinicio y posibles eventos OOM/ACPI
- Metadatos de programación de Compute Engine (Standard vs Preemptible, automatic-restart)
- Memoria RAM, swap y swappiness
- Servicios críticos de arranque (nginx, cloudflared, timers, PM2)
- Estado de persistencia en disco y configuración de backup off-VM

Opciones:
  --install-dir DIR    Ruta de instalación activa (por defecto: /opt/bingoelus)
  --strict             Finaliza con código 1 si existe algún [FAIL]
  -h, --help           Muestra esta ayuda
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir)
      [[ $# -ge 2 ]] || { echo "Error: --install-dir requiere un valor." >&2; exit 2; }
      INSTALL_DIR="$2"
      shift 2
      ;;
    --strict)
      STRICT=1
      shift
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

ok_count=0
warn_count=0
fail_count=0

print_ok()   { ok_count=$((ok_count + 1));   printf '[OK]   %s\n' "$*"; }
print_warn() { warn_count=$((warn_count + 1)); printf '[WARN] %s\n' "$*"; }
print_fail() { fail_count=$((fail_count + 1)); printf '[FAIL] %s\n' "$*"; }
print_info() { printf '[INFO] %s\n' "$*"; }

section() {
  printf '\n=== %s ===\n' "$*"
}

section "1. Forense de arranque y apagados previos"
if command -v who >/dev/null 2>&1; then
  print_info "Último arranque: $(who -b 2>/dev/null | xargs || echo 'desconocido')"
fi
if command -v last >/dev/null 2>&1; then
  print_info "Historial reciente reboot/shutdown:"
  last -x -n 6 reboot shutdown 2>/dev/null | sed 's/^/  /' || true
fi

if [[ -d /var/log/journal ]]; then
  print_ok "Journald persistente habilitado (/var/log/journal existe)."
else
  print_warn "Journald no es persistente (/var/log/journal no existe); los logs de caídas se pierden tras reiniciar."
fi

if command -v journalctl >/dev/null 2>&1; then
  prev_warnings="$(journalctl -b -1 -p warning..emerg --no-pager 2>/dev/null | tail -n 20 || true)"
  if [[ -n "$prev_warnings" ]]; then
    print_info "Últimos avisos/errores del arranque anterior (journalctl -b -1):"
    printf '%s\n' "$prev_warnings" | sed 's/^/  /'
  else
    print_info "No hay registros disponibles del arranque anterior (journalctl -b -1)."
  fi

  kernel_events="$(journalctl -k -b -1 --no-pager 2>/dev/null | grep -iE 'oom|out of memory|killed process|acpi|power|shutdown|reboot' | tail -n 15 || true)"
  if [[ -n "$kernel_events" ]]; then
    print_warn "Eventos de kernel relevantes en el arranque anterior (OOM/ACPI/Power):"
    printf '%s\n' "$kernel_events" | sed 's/^/  /'
  else
    print_info "Sin eventos OOM/ACPI/power destacados en kernel del arranque anterior."
  fi
fi

section "2. Metadatos de instancia GCP"
meta_get() {
  curl -fsS --max-time 2 -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/$1" 2>/dev/null || true
}

if command -v curl >/dev/null 2>&1 && [[ -n "$(meta_get name)" ]]; then
  inst_name="$(meta_get name)"
  inst_zone="$(meta_get zone)"
  inst_type="$(meta_get machine-type)"
  preemptible="$(meta_get scheduling/preemptible)"
  on_host_maint="$(meta_get scheduling/on-host-maintenance)"
  auto_restart="$(meta_get scheduling/automatic-restart)"

  print_info "Instancia: ${inst_name} | Zona: ${inst_zone##*/} | Tipo: ${inst_type##*/}"
  if [[ "$preemptible" == "TRUE" ]]; then
    print_fail "scheduling/preemptible=TRUE (la VM puede apagarse en cualquier momento; migrar a aprovisionamiento Standard)."
  else
    print_ok "scheduling/preemptible=${preemptible:-FALSE} (no es Spot/Preemptible)."
  fi

  if [[ "$on_host_maint" == "MIGRATE" ]]; then
    print_ok "scheduling/on-host-maintenance=MIGRATE."
  else
    print_warn "scheduling/on-host-maintenance=${on_host_maint:-desconocido} (recomendado: MIGRATE)."
  fi

  if [[ "$auto_restart" == "TRUE" ]]; then
    print_ok "scheduling/automatic-restart=TRUE."
  else
    print_fail "scheduling/automatic-restart=${auto_restart:-FALSE} (recomendado: TRUE)."
  fi
else
  print_info "Metadata server de GCP no disponible (no se ejecuta dentro de GCE o acceso bloqueado)."
fi

section "3. Memoria RAM y Swap"
if [[ -r /proc/meminfo ]]; then
  mem_total_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  mem_avail_kb="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
  swap_total_kb="$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)"
  swap_free_kb="$(awk '/^SwapFree:/ {print $2}' /proc/meminfo)"
  print_info "RAM: $((mem_avail_kb / 1024)) MiB libres / $((mem_total_kb / 1024)) MiB totales"
  if [[ "${swap_total_kb:-0}" -gt 0 ]]; then
    print_ok "Swap activo: $((swap_free_kb / 1024)) MiB libres / $((swap_total_kb / 1024)) MiB totales"
  else
    print_warn "No hay swap configurado (SwapTotal=0); un pico de memoria puede disparar el OOM killer."
  fi
fi

if [[ -r /proc/sys/vm/swappiness ]]; then
  print_info "vm.swappiness=$(cat /proc/sys/vm/swappiness)"
fi

section "4. Servicios críticos de arranque y PM2"
check_systemd_unit() {
  local unit="$1"
  local required="${2:-1}"
  if ! command -v systemctl >/dev/null 2>&1; then
    print_info "systemctl no disponible; se omite comprobación de $unit."
    return 0
  fi
  if ! systemctl list-unit-files "$unit" --no-legend 2>/dev/null | grep -q .; then
    if [[ "$required" -eq 1 ]]; then
      print_fail "Unidad systemd no instalada: $unit"
    else
      print_info "Unidad opcional no instalada: $unit"
    fi
    return 0
  fi

  local enabled active
  enabled="$(systemctl is-enabled "$unit" 2>/dev/null || echo 'disabled')"
  active="$(systemctl is-active "$unit" 2>/dev/null || echo 'inactive')"
  if [[ "$enabled" == "enabled" && "$active" == "active" ]]; then
    print_ok "$unit (enabled + active)"
  else
    print_fail "$unit (enabled=${enabled}, active=${active})"
  fi
}

check_systemd_unit "nginx.service" 1
check_systemd_unit "cloudflared.service" 1
check_systemd_unit "cloudflared-clon.service" 0
check_systemd_unit "cloudflared-watchdog.timer" 1
check_systemd_unit "bingoelus-backup.timer" 1

if command -v systemctl >/dev/null 2>&1; then
  pm2_units="$(systemctl list-unit-files 'pm2-*.service' --no-legend 2>/dev/null | awk '{print $1}' || true)"
  if [[ -n "$pm2_units" ]]; then
    for u in $pm2_units; do
      check_systemd_unit "$u" 1
    done
  else
    print_fail "No hay servicio systemd pm2-*.service configurado (ejecutar 'pm2 startup systemd' y 'pm2 save')."
  fi
fi

if command -v pm2 >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  pm2_json="$(pm2 jlist 2>/dev/null || echo '[]')"
  printf '%s' "$pm2_json" | node -e '
    let raw = "";
    process.stdin.on("data", c => raw += c);
    process.stdin.on("end", () => {
      try {
        const list = JSON.parse(raw);
        const app = Array.isArray(list) ? list.find(p => p.name === "bingoelus-server") : null;
        if (!app) {
          console.log("MISSING");
          process.exit(0);
        }
        const status = app.pm2_env?.status || "unknown";
        const restarts = app.pm2_env?.restart_time ?? "?";
        const memMb = app.monit?.memory ? Math.round(app.monit.memory / 1024 / 1024) : "?";
        console.log(`FOUND|${status}|${restarts}|${memMb}`);
      } catch {
        console.log("ERROR");
      }
    });
  ' | while IFS='|' read -r tag status restarts memMb; do
    case "$tag" in
      FOUND)
        if [[ "$status" == "online" ]]; then
          print_ok "PM2 bingoelus-server online (restarts=${restarts}, mem=${memMb}MiB)"
        else
          print_fail "PM2 bingoelus-server estado=${status} (restarts=${restarts})"
        fi
        ;;
      MISSING)
        print_fail "Proceso PM2 'bingoelus-server' no encontrado."
        ;;
      *)
        print_warn "No se pudo consultar el estado de PM2."
        ;;
    esac
  done
fi

section "5. Persistencia de partida y backup off-VM"
if command -v curl >/dev/null 2>&1 && health_json="$(curl -fsS --max-time 3 http://127.0.0.1:3000/healthz 2>/dev/null)"; then
  print_ok "/healthz local responde 200: ${health_json}"
else
  print_fail "/healthz local (http://127.0.0.1:3000/healthz) no responde."
fi

for file in estado-partida.json estado-partida.json.bak cuentas-baneadas.json; do
  full="$INSTALL_DIR/datos/$file"
  if [[ -f "$full" ]]; then
    size_bytes="$(wc -c < "$full" | tr -d ' ')"
    print_ok "Archivo presente: $full (${size_bytes} bytes)"
  else
    print_info "Archivo aún no presente (normal si no ha habido partida/baneos): $full"
  fi
done

backup_env="/etc/default/bingoelus-backup"
if [[ -r "$backup_env" ]]; then
  if grep -Eq '^SOURCE_DIRS=.*(/opt/bingoelus/datos|datos)' "$backup_env"; then
    print_ok "$backup_env incluye datos vivos en SOURCE_DIRS."
  else
    print_warn "$backup_env no incluye /opt/bingoelus/datos en SOURCE_DIRS."
  fi
  if grep -Eq '^(GSUTIL_BUCKET|RCLONE_TARGET)=.+[^[:space:]]' "$backup_env"; then
    print_ok "$backup_env tiene destino remoto configurado (GSUTIL_BUCKET o RCLONE_TARGET)."
  else
    print_warn "$backup_env no tiene GSUTIL_BUCKET ni RCLONE_TARGET configurado (solo backup local)."
  fi
else
  print_warn "No existe $backup_env; el backup off-VM aún no está configurado."
fi

printf '\nResumen auditoría: OK=%d | WARN=%d | FAIL=%d\n' "$ok_count" "$warn_count" "$fail_count"
if [[ "$STRICT" -eq 1 && "$fail_count" -gt 0 ]]; then
  exit 1
fi
