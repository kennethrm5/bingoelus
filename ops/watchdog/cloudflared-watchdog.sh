#!/usr/bin/env bash
set -Eeuo pipefail

LOCK_FILE="${LOCK_FILE:-/var/lock/bingoelus-cloudflared-watchdog.lock}"
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

STATE_DIR="${STATE_DIR:-/var/lib/bingoelus}"
STATE_FILE="${STATE_FILE:-$STATE_DIR/cloudflared-watchdog.state}"
PRIMARY_SERVICE="${PRIMARY_SERVICE:-cloudflared}"
CLONE_SERVICE="${CLONE_SERVICE:-cloudflared-clon}"
CHECK_CLONE="${CHECK_CLONE:-1}"
PRIMARY_TUNNEL="${PRIMARY_TUNNEL:-}"
CLONE_TUNNEL="${CLONE_TUNNEL:-}"
MIN_CONNECTIONS="${MIN_CONNECTIONS:-4}"
FAILURE_THRESHOLD="${FAILURE_THRESHOLD:-3}"
RESTART_COOLDOWN_SEC="${RESTART_COOLDOWN_SEC:-120}"
LOCAL_HEALTH_URL="${LOCAL_HEALTH_URL:-http://127.0.0.1:3000/healthz}"
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL:-}"
CURL_TIMEOUT_SEC="${CURL_TIMEOUT_SEC:-6}"
LOG_TAG="${LOG_TAG:-bingoelus-watchdog}"

mkdir -p "$STATE_DIR"

log_info() {
  logger -t "$LOG_TAG" "[INFO] $*"
}

log_warn() {
  logger -t "$LOG_TAG" "[WARN] $*"
}

probe_url() {
  local url="$1"
  curl -fsS --max-time "$CURL_TIMEOUT_SEC" "$url" >/dev/null
}

service_is_active() {
  local service_name="$1"
  systemctl is-active --quiet "$service_name"
}

connection_count() {
  local tunnel_name="$1"
  if [[ -z "$tunnel_name" ]]; then
    echo "-1"
    return 0
  fi

  local info_json
  if ! info_json="$(cloudflared tunnel info --output json "$tunnel_name" 2>/dev/null)"; then
    echo "0"
    return 1
  fi

  printf '%s' "$info_json" | node -e '
let data = "";
process.stdin.on("data", chunk => data += chunk);
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(data);
    const count = Array.isArray(parsed.connections) ? parsed.connections.length : 0;
    process.stdout.write(String(count));
  } catch {
    process.stdout.write("0");
    process.exitCode = 1;
  }
});
'
}

failures=0
last_restart=0
if [[ -f "$STATE_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$STATE_FILE" || true
fi

[[ "$failures" =~ ^[0-9]+$ ]] || failures=0
[[ "$last_restart" =~ ^[0-9]+$ ]] || last_restart=0

now_ts="$(date +%s)"
health_ok=1
reasons=()

if ! probe_url "$LOCAL_HEALTH_URL"; then
  health_ok=0
  reasons+=("local-health")
fi

if [[ -n "$PUBLIC_HEALTH_URL" ]] && ! probe_url "$PUBLIC_HEALTH_URL"; then
  health_ok=0
  reasons+=("public-health")
fi

if ! service_is_active "$PRIMARY_SERVICE"; then
  health_ok=0
  reasons+=("service:${PRIMARY_SERVICE}")
fi

if [[ "$CHECK_CLONE" == "1" ]] && ! service_is_active "$CLONE_SERVICE"; then
  health_ok=0
  reasons+=("service:${CLONE_SERVICE}")
fi

if [[ -n "$PRIMARY_TUNNEL" ]]; then
  primary_conn="$(connection_count "$PRIMARY_TUNNEL" || true)"
  if [[ "$primary_conn" -lt "$MIN_CONNECTIONS" ]]; then
    health_ok=0
    reasons+=("conn:${PRIMARY_TUNNEL}=${primary_conn}")
  fi
fi

if [[ "$CHECK_CLONE" == "1" && -n "$CLONE_TUNNEL" ]]; then
  clone_conn="$(connection_count "$CLONE_TUNNEL" || true)"
  if [[ "$clone_conn" -lt "$MIN_CONNECTIONS" ]]; then
    health_ok=0
    reasons+=("conn:${CLONE_TUNNEL}=${clone_conn}")
  fi
fi

if [[ "$health_ok" -eq 1 ]]; then
  if [[ "$failures" -gt 0 ]]; then
    log_info "Recovered. Clearing failure counter (${failures} -> 0)."
  fi
  failures=0
  cat > "$STATE_FILE" <<EOF
failures=${failures}
last_restart=${last_restart}
EOF
  exit 0
fi

failures=$((failures + 1))
log_warn "Watchdog check failed (${failures}/${FAILURE_THRESHOLD}): ${reasons[*]}"

if [[ "$failures" -ge "$FAILURE_THRESHOLD" ]]; then
  since_restart=$((now_ts - last_restart))
  if [[ "$since_restart" -ge "$RESTART_COOLDOWN_SEC" ]]; then
    restart_targets="$PRIMARY_SERVICE"
    if [[ "$CHECK_CLONE" == "1" ]]; then
      restart_targets+=", ${CLONE_SERVICE}"
    fi
    log_warn "Restarting tunnel services: ${restart_targets}"
    systemctl restart "$PRIMARY_SERVICE"
    if [[ "$CHECK_CLONE" == "1" ]]; then
      systemctl restart "$CLONE_SERVICE"
    fi
    last_restart="$now_ts"
    failures=0
    log_info "Tunnel services restarted successfully."
  else
    log_warn "Restart skipped due to cooldown (${since_restart}s < ${RESTART_COOLDOWN_SEC}s)."
  fi
fi

cat > "$STATE_FILE" <<EOF
failures=${failures}
last_restart=${last_restart}
EOF
