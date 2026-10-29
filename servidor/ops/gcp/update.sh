#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
SOURCE_DIR="$REPO_DIR/servidor"
INSTALL_DIR="${BINGOELUS_INSTALL_DIR:-/opt/bingoelus}"
CONFIG_FILE="$INSTALL_DIR/config.json"
REPO_REAL="$(realpath "$REPO_DIR")"
INSTALL_REAL="$(realpath -m "$INSTALL_DIR")"

case "$INSTALL_REAL/" in
  "$REPO_REAL/"*)
    echo "El directorio activo no puede estar dentro del clon Git: $INSTALL_REAL" >&2
    exit 1
    ;;
esac
case "$REPO_REAL/" in
  "$INSTALL_REAL/"*)
    echo "El directorio activo no puede contener el clon Git: $INSTALL_REAL" >&2
    exit 1
    ;;
esac

for command in git node npm pm2 curl rsync; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Falta el comando requerido: $command" >&2
    exit 1
  fi
done

if ! git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "No se encontró un repositorio Git en $REPO_DIR" >&2
  exit 1
fi

git -C "$REPO_DIR" pull --ff-only

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Falta $CONFIG_FILE. Ejecuta primero el script install.sh del repositorio." >&2
  exit 1
fi

if ! node - "$CONFIG_FILE" <<'NODE'
const fs = require('node:fs');
let config;
try {
  config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
} catch {
  console.error('config.json no contiene JSON válido.');
  process.exit(1);
}
if (!config.gestorToken || config.gestorToken === 'CAMBIAR_POR_UN_TOKEN_SECRETO_LARGO') {
  console.error('config.json debe contener un gestorToken real.');
  process.exit(1);
}
NODE
then
  echo "La configuración privada no es válida; no se reinició el servidor." >&2
  exit 1
fi

sudo install -d -m 755 "$INSTALL_DIR"
sudo rsync -a --delete \
  --exclude='/config.json' \
  --exclude='/datos/' \
  --exclude='/resultados/' \
  --exclude='/ganadores/' \
  --exclude='/backups/' \
  --exclude='/node_modules/' \
  "$SOURCE_DIR/" "$INSTALL_DIR/"
sudo chown -R "$USER":"$(id -gn)" "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/datos" "$INSTALL_DIR/resultados" "$INSTALL_DIR/ganadores"
npm ci --omit=dev --prefix "$INSTALL_DIR"
pm2 startOrReload "$INSTALL_DIR/ecosystem.config.cjs" --update-env
pm2 save

for attempt in {1..10}; do
  if curl --fail --silent --show-error http://127.0.0.1:3000/healthz >/dev/null; then
    echo "Bingoelus actualizado y saludable."
    exit 0
  fi
  sleep 2
done

echo "El servidor no respondió en /healthz después de actualizar." >&2
pm2 logs bingoelus-server --lines 50 --nostream >&2 || true
exit 1
