#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
INSTALL_DIR="${BINGOELUS_INSTALL_DIR:-/opt/bingoelus}"
CONFIG_FILE="$INSTALL_DIR/config.json"
CONFIG_EXAMPLE="$REPO_DIR/servidor/config.example.json"

if [[ ! -f "$CONFIG_FILE" ]]; then
  sudo install -d -m 755 "$INSTALL_DIR"
  sudo install -m 600 "$CONFIG_EXAMPLE" "$CONFIG_FILE"
  sudo chown "$USER":"$(id -gn)" "$CONFIG_FILE"
  cat >&2 <<EOF
Se creó $CONFIG_FILE con valores de ejemplo.
Edita ese archivo y configura gestorToken, clientId, clientSecret y baseUrl.
Después vuelve a ejecutar: bash $SCRIPT_DIR/install.sh
EOF
  exit 1
fi

exec bash "$SCRIPT_DIR/update.sh"
