#!/usr/bin/env bash
set -Eeuo pipefail

LOCK_FILE="${LOCK_FILE:-/var/lock/bingoelus-backup.lock}"
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

SOURCE_DIRS="${SOURCE_DIRS:-/opt/bingoelus/ganadores:/opt/bingoelus/resultados:/opt/bingoelus/datos}"
LIVE_ONLY_DIRS="${LIVE_ONLY_DIRS:-/opt/bingoelus/datos}"
BACKUP_BASE="${BACKUP_BASE:-/opt/bingoelus/backups}"
MIRROR_DIR="${MIRROR_DIR:-$BACKUP_BASE/live}"
ARCHIVE_DIR="${ARCHIVE_DIR:-$BACKUP_BASE/archives}"
STATE_DIR="${STATE_DIR:-/var/lib/bingoelus}"
STATE_FILE="${STATE_FILE:-$STATE_DIR/backup.state}"
ARCHIVE_EVERY_MINUTES="${ARCHIVE_EVERY_MINUTES:-120}"
REMOTE_SYNC_EVERY_MINUTES="${REMOTE_SYNC_EVERY_MINUTES:-10}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
GSUTIL_BUCKET="${GSUTIL_BUCKET:-}"
GSUTIL_BIN="${GSUTIL_BIN:-gsutil}"
RCLONE_TARGET="${RCLONE_TARGET:-}"
RCLONE_BIN="${RCLONE_BIN:-rclone}"
LOG_TAG="${LOG_TAG:-bingoelus-backup}"

mkdir -p "$MIRROR_DIR" "$ARCHIVE_DIR" "$STATE_DIR"

log_info() {
  logger -t "$LOG_TAG" "[INFO] $*"
}

log_warn() {
  logger -t "$LOG_TAG" "[WARN] $*"
}

sanitize_name() {
  printf '%s' "$1" | sed 's#^/##' | sed 's#/#_#g'
}

normalize_path() {
  local p="${1%/}"
  printf '%s' "${p:-/}"
}

is_live_only_dir() {
  local needle
  needle="$(normalize_path "$1")"
  local item
  local -a live_dirs=()
  IFS=':' read -r -a live_dirs <<< "$LIVE_ONLY_DIRS"
  for item in "${live_dirs[@]}"; do
    [[ -z "$item" ]] && continue
    if [[ "$(normalize_path "$item")" == "$needle" ]]; then
      return 0
    fi
  done
  return 1
}

last_archive=0
last_remote_sync=0
if [[ -f "$STATE_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$STATE_FILE" || true
fi

[[ "$last_archive" =~ ^[0-9]+$ ]] || last_archive=0
[[ "$last_remote_sync" =~ ^[0-9]+$ ]] || last_remote_sync=0
[[ "$ARCHIVE_EVERY_MINUTES" =~ ^[0-9]+$ ]] || ARCHIVE_EVERY_MINUTES=120
[[ "$REMOTE_SYNC_EVERY_MINUTES" =~ ^[0-9]+$ ]] || REMOTE_SYNC_EVERY_MINUTES=10

changed_live=0
changed_archive=0
IFS=':' read -r -a sources <<< "$SOURCE_DIRS"

for src in "${sources[@]}"; do
  if [[ -z "$src" ]]; then
    continue
  fi

  if [[ ! -d "$src" ]]; then
    log_warn "Source dir not found, skipping: $src"
    continue
  fi

  target_name="$(sanitize_name "$src")"
  target_dir="$MIRROR_DIR/$target_name"
  mkdir -p "$target_dir"

  if ! rsync_output="$(rsync -a --itemize-changes --exclude='*.tmp' "$src/" "$target_dir/")"; then
    log_warn "rsync failed for source: $src"
    continue
  fi
  if [[ -n "$rsync_output" ]]; then
    changed_live=1
    if ! is_live_only_dir "$src"; then
      changed_archive=1
    fi
  fi
done

now_ts="$(date +%s)"
archive_interval_sec=$((ARCHIVE_EVERY_MINUTES * 60))
remote_sync_interval_sec=$((REMOTE_SYNC_EVERY_MINUTES * 60))
archive_created=0

if [[ "$changed_archive" -eq 1 || $((now_ts - last_archive)) -ge "$archive_interval_sec" ]]; then
  archive_file="$ARCHIVE_DIR/bingoelus_backup_$(date +%F_%H-%M-%S).tar.gz"
  tar -czf "$archive_file" -C "$MIRROR_DIR" .
  last_archive="$now_ts"
  archive_created=1
  log_info "Archive created: $archive_file"
fi

find "$ARCHIVE_DIR" -type f -name 'bingoelus_backup_*.tar.gz' -mtime +"$RETENTION_DAYS" -delete

sync_live_due=0
if [[ "$changed_live" -eq 1 || "$archive_created" -eq 1 || $((now_ts - last_remote_sync)) -ge "$remote_sync_interval_sec" ]]; then
  sync_live_due=1
fi
sync_archives_due=0
if [[ "$archive_created" -eq 1 || $((now_ts - last_remote_sync)) -ge "$remote_sync_interval_sec" ]]; then
  sync_archives_due=1
fi

if [[ -n "$GSUTIL_BUCKET" && ( "$sync_live_due" -eq 1 || "$sync_archives_due" -eq 1 ) ]]; then
  if command -v "$GSUTIL_BIN" >/dev/null 2>&1; then
    remote_ok=1
    if [[ "$sync_live_due" -eq 1 ]]; then
      if ! "$GSUTIL_BIN" -m rsync -r -x '.*\.tmp$' "$MIRROR_DIR" "${GSUTIL_BUCKET%/}/live"; then
        log_warn "gsutil sync failed for live mirror: ${GSUTIL_BUCKET%/}/live"
        remote_ok=0
      fi
    fi
    if [[ "$sync_archives_due" -eq 1 ]]; then
      if ! "$GSUTIL_BIN" -m rsync -r "$ARCHIVE_DIR" "${GSUTIL_BUCKET%/}/archives"; then
        log_warn "gsutil sync failed for archives: ${GSUTIL_BUCKET%/}/archives"
        remote_ok=0
      fi
    fi
    if [[ "$remote_ok" -eq 1 ]]; then
      last_remote_sync="$now_ts"
      log_info "Remote sync completed via gsutil to ${GSUTIL_BUCKET}"
    fi
  else
    log_warn "GSUTIL_BUCKET set but gsutil not found: $GSUTIL_BIN"
  fi
elif [[ -n "$RCLONE_TARGET" && ( "$sync_live_due" -eq 1 || "$sync_archives_due" -eq 1 ) ]]; then
  if command -v "$RCLONE_BIN" >/dev/null 2>&1; then
    remote_ok=1
    if [[ "$sync_live_due" -eq 1 ]]; then
      if ! "$RCLONE_BIN" sync "$MIRROR_DIR" "${RCLONE_TARGET%/}/live" --exclude '*.tmp' --create-empty-src-dirs; then
        log_warn "rclone sync failed for live mirror: ${RCLONE_TARGET%/}/live"
        remote_ok=0
      fi
    fi
    if [[ "$sync_archives_due" -eq 1 ]]; then
      if ! "$RCLONE_BIN" sync "$ARCHIVE_DIR" "${RCLONE_TARGET%/}/archives" --create-empty-src-dirs; then
        log_warn "rclone sync failed for archives: ${RCLONE_TARGET%/}/archives"
        remote_ok=0
      fi
    fi
    if [[ "$remote_ok" -eq 1 ]]; then
      last_remote_sync="$now_ts"
      log_info "Remote sync completed via rclone to ${RCLONE_TARGET}"
    fi
  else
    log_warn "RCLONE_TARGET set but rclone not found: $RCLONE_BIN"
  fi
fi

cat > "$STATE_FILE" <<EOF
last_archive=${last_archive}
last_remote_sync=${last_remote_sync}
EOF
