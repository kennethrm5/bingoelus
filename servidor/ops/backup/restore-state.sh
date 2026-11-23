#!/usr/bin/env bash
set -Eeuo pipefail

BACKUP_ENV_FILE="${BINGOELUS_BACKUP_ENV:-/etc/default/bingoelus-backup}"
if [[ -r "$BACKUP_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$BACKUP_ENV_FILE" || true
fi

MIRROR_DIR="${MIRROR_DIR:-/opt/bingoelus/backups/live}"
GSUTIL_BUCKET="${GSUTIL_BUCKET:-}"
GSUTIL_BIN="${GSUTIL_BIN:-gsutil}"
RCLONE_TARGET="${RCLONE_TARGET:-}"
RCLONE_BIN="${RCLONE_BIN:-rclone}"
TARGET_DIR="/opt/bingoelus/datos"
SOURCE_MODE=""
SOURCE_LOCATION=""
RESTART_PM2=0
DRY_RUN=0

usage() {
  cat <<'EOF'
Uso: restore-state.sh [OPCIONES]

Restaura el estado vivo de la partida (estado-partida.json y cuentas-baneadas.json)
desde un mirror local, Google Cloud Storage o rclone, validando el JSON antes de tocar
el directorio de destino.

Opciones de origen (elige exactamente una):
  --from-local [DIR]   Restaura desde el mirror local (por defecto: $MIRROR_DIR/opt_bingoelus_datos)
  --from-gcs [URI]     Restaura desde GCS (por defecto: $GSUTIL_BUCKET/live/opt_bingoelus_datos)
  --from-rclone [URI]  Restaura desde rclone (por defecto: $RCLONE_TARGET/live/opt_bingoelus_datos)

Opciones generales:
  --target-dir DIR     Directorio de datos destino (por defecto: /opt/bingoelus/datos)
  --restart-pm2        Reinicia bingoelus-server con PM2 tras restaurar y verifica /healthz
  --dry-run            Descarga/prepara y valida sin escribir en el destino
  -h, --help           Muestra esta ayuda
EOF
}

to_node_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s' "$1"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-local)
      [[ -z "$SOURCE_MODE" ]] || { echo "Error: especifica solo un origen (--from-local / --from-gcs / --from-rclone)." >&2; exit 2; }
      SOURCE_MODE="local"
      if [[ $# -ge 2 && "$2" != --* ]]; then
        SOURCE_LOCATION="$2"
        shift 2
      else
        SOURCE_LOCATION="${MIRROR_DIR%/}/opt_bingoelus_datos"
        shift
      fi
      ;;
    --from-gcs)
      [[ -z "$SOURCE_MODE" ]] || { echo "Error: especifica solo un origen (--from-local / --from-gcs / --from-rclone)." >&2; exit 2; }
      SOURCE_MODE="gcs"
      if [[ $# -ge 2 && "$2" != --* ]]; then
        SOURCE_LOCATION="$2"
        shift 2
      else
        if [[ -z "$GSUTIL_BUCKET" ]]; then
          echo "Error: falta URI en --from-gcs y GSUTIL_BUCKET no está configurado." >&2
          exit 2
        fi
        SOURCE_LOCATION="${GSUTIL_BUCKET%/}/live/opt_bingoelus_datos"
        shift
      fi
      ;;
    --from-rclone)
      [[ -z "$SOURCE_MODE" ]] || { echo "Error: especifica solo un origen (--from-local / --from-gcs / --from-rclone)." >&2; exit 2; }
      SOURCE_MODE="rclone"
      if [[ $# -ge 2 && "$2" != --* ]]; then
        SOURCE_LOCATION="$2"
        shift 2
      else
        if [[ -z "$RCLONE_TARGET" ]]; then
          echo "Error: falta URI en --from-rclone y RCLONE_TARGET no está configurado." >&2
          exit 2
        fi
        SOURCE_LOCATION="${RCLONE_TARGET%/}/live/opt_bingoelus_datos"
        shift
      fi
      ;;
    --target-dir)
      [[ $# -ge 2 ]] || { echo "Error: --target-dir requiere un valor." >&2; exit 2; }
      TARGET_DIR="$2"
      shift 2
      ;;
    --restart-pm2)
      RESTART_PM2=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
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

if [[ -z "$SOURCE_MODE" ]]; then
  echo "Error: debes indicar un origen (--from-local, --from-gcs o --from-rclone)." >&2
  usage >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Error: se requiere Node.js (node) para validar los snapshots." >&2
  exit 1
fi

STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

case "$SOURCE_MODE" in
  local)
    if [[ ! -d "$SOURCE_LOCATION" ]]; then
      echo "Error: no existe el directorio origen: $SOURCE_LOCATION" >&2
      exit 1
    fi
    for fname in estado-partida.json estado-partida.json.bak cuentas-baneadas.json; do
      if [[ -f "$SOURCE_LOCATION/$fname" ]]; then
        cp -f "$SOURCE_LOCATION/$fname" "$STAGE_DIR/$fname"
      fi
    done
    ;;
  gcs)
    command -v "$GSUTIL_BIN" >/dev/null 2>&1 || { echo "Error: no se encontró $GSUTIL_BIN." >&2; exit 1; }
    for fname in estado-partida.json estado-partida.json.bak cuentas-baneadas.json; do
      "$GSUTIL_BIN" cp "${SOURCE_LOCATION%/}/$fname" "$STAGE_DIR/$fname" >/dev/null 2>&1 || true
    done
    if [[ ! -f "$STAGE_DIR/estado-partida.json" && ! -f "$STAGE_DIR/estado-partida.json.bak" ]]; then
      echo "Error: no se pudo descargar estado-partida.json ni .bak desde ${SOURCE_LOCATION}" >&2
      exit 1
    fi
    ;;
  rclone)
    command -v "$RCLONE_BIN" >/dev/null 2>&1 || { echo "Error: no se encontró $RCLONE_BIN." >&2; exit 1; }
    "$RCLONE_BIN" copy "$SOURCE_LOCATION" "$STAGE_DIR" \
      --include 'estado-partida.json' \
      --include 'estado-partida.json.bak' \
      --include 'cuentas-baneadas.json'
    ;;
esac

STAGE_DIR_NODE="$(to_node_path "$STAGE_DIR")"

node - "$STAGE_DIR_NODE" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const stageDir = process.argv[2];
const primaryPath = path.join(stageDir, 'estado-partida.json');
const bakPath = path.join(stageDir, 'estado-partida.json.bak');
const bansPath = path.join(stageDir, 'cuentas-baneadas.json');

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function isValidCard(carton) {
  return Array.isArray(carton) &&
    carton.length === 5 &&
    carton.every(row => Array.isArray(row) && row.length === 5 && row.every(cell => typeof cell === 'string'));
}

function validateSnapshot(raw) {
  if (!isPlainObject(raw)) throw new Error('Snapshot raíz no es un objeto.');
  if (!Array.isArray(raw.frases) || !raw.frases.every(f => typeof f === 'string')) {
    throw new Error('Campo frases inválido.');
  }
  if (!isPlainObject(raw.tokens)) throw new Error('Campo tokens inválido.');
  for (const [login, data] of Object.entries(raw.tokens)) {
    if (!login || !isPlainObject(data) || !isValidCard(data.carton)) {
      throw new Error(`Entrada de cartón inválida para "${login}".`);
    }
  }
  return raw;
}

let chosenName = null;
let chosenData = null;
let primaryError = null;

for (const [name, candidate] of [['estado-partida.json', primaryPath], ['estado-partida.json.bak', bakPath]]) {
  if (!fs.existsSync(candidate)) continue;
  try {
    const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    chosenData = validateSnapshot(parsed);
    chosenName = name;
    break;
  } catch (err) {
    if (name === 'estado-partida.json') {
      primaryError = err.message;
      console.warn(`[Restore] estado-partida.json inválido (${err.message}); intentando respaldo .bak...`);
    } else {
      console.error(`[Restore] Respaldo .bak inválido (${err.message}).`);
    }
  }
}

if (!chosenData) {
  console.error(`[Restore] ERROR: No hay ningún snapshot válido en ${stageDir}${primaryError ? ` (${primaryError})` : ''}.`);
  process.exit(1);
}

if (fs.existsSync(bansPath)) {
  const bans = JSON.parse(fs.readFileSync(bansPath, 'utf8'));
  if (!Array.isArray(bans) || bans.some(b => !isPlainObject(b) || typeof b.login !== 'string' || !Number.isFinite(b.bannedAt))) {
    console.error('[Restore] ERROR: cuentas-baneadas.json tiene formato inválido.');
    process.exit(1);
  }
}

const savedIso = Number.isFinite(chosenData.savedAt) && chosenData.savedAt > 0
  ? new Date(chosenData.savedAt).toISOString()
  : 'desconocido';
const cantadasCount = Array.isArray(chosenData.cantadas) ? chosenData.cantadas.length : 0;
const jugadoresCount = Object.keys(chosenData.tokens).length;

fs.copyFileSync(path.join(stageDir, chosenName), path.join(stageDir, 'validated-estado-partida.json'));

console.log(
  `[Restore] Snapshot válido (${chosenName}): savedAt=${savedIso}, partidaActiva=${Boolean(chosenData.partidaActiva)}, ` +
  `frases=${chosenData.frases.length}, cantadas=${cantadasCount}, jugadores=${jugadoresCount}`
);
NODE

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[DRY-RUN] Validación correcta desde ${SOURCE_MODE} (${SOURCE_LOCATION}). No se modificó ${TARGET_DIR}."
  exit 0
fi

mkdir -p "$TARGET_DIR"
UTC_TS="$(date -u +%Y%m%dT%H%M%SZ)"

if [[ -f "$TARGET_DIR/estado-partida.json" ]]; then
  cp -f "$TARGET_DIR/estado-partida.json" "$TARGET_DIR/estado-partida.json.pre-restore-${UTC_TS}"
fi

cp -f "$STAGE_DIR/validated-estado-partida.json" "$TARGET_DIR/estado-partida.json.restore.tmp"
chmod 600 "$TARGET_DIR/estado-partida.json.restore.tmp" || true
mv -f "$TARGET_DIR/estado-partida.json.restore.tmp" "$TARGET_DIR/estado-partida.json"

cp -f "$TARGET_DIR/estado-partida.json" "$TARGET_DIR/estado-partida.json.bak.restore.tmp"
chmod 600 "$TARGET_DIR/estado-partida.json.bak.restore.tmp" || true
mv -f "$TARGET_DIR/estado-partida.json.bak.restore.tmp" "$TARGET_DIR/estado-partida.json.bak"

if [[ -f "$STAGE_DIR/cuentas-baneadas.json" ]]; then
  if [[ -f "$TARGET_DIR/cuentas-baneadas.json" ]]; then
    cp -f "$TARGET_DIR/cuentas-baneadas.json" "$TARGET_DIR/cuentas-baneadas.json.pre-restore-${UTC_TS}"
  fi
  cp -f "$STAGE_DIR/cuentas-baneadas.json" "$TARGET_DIR/cuentas-baneadas.json.restore.tmp"
  chmod 600 "$TARGET_DIR/cuentas-baneadas.json.restore.tmp" || true
  mv -f "$TARGET_DIR/cuentas-baneadas.json.restore.tmp" "$TARGET_DIR/cuentas-baneadas.json"
fi

echo "[Restore] Estado restaurado correctamente en $TARGET_DIR."

if [[ "$RESTART_PM2" -eq 1 ]]; then
  command -v pm2 >/dev/null 2>&1 || { echo "Error: no se encontró pm2 para reiniciar." >&2; exit 1; }
  pm2 restart bingoelus-server --update-env
  for attempt in {1..10}; do
    if curl --fail --silent --show-error http://127.0.0.1:3000/healthz >/dev/null; then
      echo "[Restore] Servidor bingoelus-server reiniciado y saludable en /healthz."
      exit 0
    fi
    sleep 2
  done
  echo "Error: el servidor no respondió en /healthz tras reiniciar con PM2." >&2
  exit 1
fi
