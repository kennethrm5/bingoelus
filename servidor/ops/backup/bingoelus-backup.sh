#!/usr/bin/env bash
set -Eeuo pipefail

LOCK_FILE="${LOCK_FILE:-/var/lock/bingoelus-backup.lock}"
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

SOURCE_DIRS="${SOURCE_DIRS:-/opt/bingoelus/ganadores:/opt/bingoelus/servidor/resultados}"
BACKUP_BASE="${BACKUP_BASE:-/opt/bingoelus/backups}"
MIRROR_DIR="${MIRROR_DIR:-$BACKUP_BASE/live}"
ARCHIVE_DIR="${ARCHIVE_DIR:-$BACKUP_BASE/archives}"
STATE_DIR="${STATE_DIR:-/var/lib/bingoelus}"
STATE_FILE="${STATE_FILE:-$STATE_DIR/backup.state}"
ARCHIVE_EVERY_MINUTES="${ARCHIVE_EVERY_MINUTES:-120}"
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

last_archive=0
if [[ -f "$STATE_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$STATE_FILE" || true
fi

[[ "$last_archive" =~ ^[0-9]+$ ]] || last_archive=0

changed=0
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

  if ! rsync_output="$(rsync -a --itemize-changes "$src/" "$target_dir/")"; then
    log_warn "rsync failed for source: $src"
    continue
  fi
  if [[ -n "$rsync_output" ]]; then
    changed=1
  fi
done

now_ts="$(date +%s)"
archive_interval_sec=$((ARCHIVE_EVERY_MINUTES * 60))

if [[ "$changed" -eq 1 || $((now_ts - last_archive)) -ge "$archive_interval_sec" ]]; then
  archive_file="$ARCHIVE_DIR/bingoelus_backup_$(date +%F_%H-%M-%S).tar.gz"
  tar -czf "$archive_file" -C "$MIRROR_DIR" .
  last_archive="$now_ts"
  log_info "Archive created: $archive_file"
fi

find "$ARCHIVE_DIR" -type f -name 'bingoelus_backup_*.tar.gz' -mtime +"$RETENTION_DAYS" -delete

if [[ -n "$GSUTIL_BUCKET" ]]; then
  if command -v "$GSUTIL_BIN" >/dev/null 2>&1; then
    if ! "$GSUTIL_BIN" -m rsync -r "$MIRROR_DIR" "${GSUTIL_BUCKET%/}/live"; then
      log_warn "gsutil sync failed for live mirror: ${GSUTIL_BUCKET%/}/live"
    fi
    if ! "$GSUTIL_BIN" -m rsync -r "$ARCHIVE_DIR" "${GSUTIL_BUCKET%/}/archives"; then
      log_warn "gsutil sync failed for archives: ${GSUTIL_BUCKET%/}/archives"
    fi
    log_info "Remote sync completed via gsutil to ${GSUTIL_BUCKET}"
  else
    log_warn "GSUTIL_BUCKET set but gsutil not found: $GSUTIL_BIN"
  fi
elif [[ -n "$RCLONE_TARGET" ]]; then
  if command -v "$RCLONE_BIN" >/dev/null 2>&1; then
    if ! "$RCLONE_BIN" sync "$MIRROR_DIR" "${RCLONE_TARGET%/}/live" --create-empty-src-dirs; then
      log_warn "rclone sync failed for live mirror: ${RCLONE_TARGET%/}/live"
    fi
    if ! "$RCLONE_BIN" sync "$ARCHIVE_DIR" "${RCLONE_TARGET%/}/archives" --create-empty-src-dirs; then
      log_warn "rclone sync failed for archives: ${RCLONE_TARGET%/}/archives"
    fi
    log_info "Remote sync completed via rclone to ${RCLONE_TARGET}"
  else
    log_warn "RCLONE_TARGET set but rclone not found: $RCLONE_BIN"
  fi
fi

cat > "$STATE_FILE" <<EOF
last_archive=${last_archive}
EOF
