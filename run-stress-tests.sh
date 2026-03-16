#!/bin/bash
# run-stress-tests.sh — Ejecuta los tres tests de carga y guarda los resultados
# Uso: bash run-stress-tests.sh [url]
# Ejemplo: bash run-stress-tests.sh http://localhost:3000

URL="${1:-http://localhost:3000}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/stress-test.js"
FECHA=$(date '+%Y-%m-%d_%H-%M-%S')
OUTPUT="$SCRIPT_DIR/resultados-stress-$FECHA.txt"

echo "=========================================="  | tee -a "$OUTPUT"
echo " BINGOELUS — STRESS TESTS                "  | tee -a "$OUTPUT"
echo " Fecha  : $(date '+%Y-%m-%d %H:%M:%S')   "  | tee -a "$OUTPUT"
echo " Target : $URL                            "  | tee -a "$OUTPUT"
echo "=========================================="  | tee -a "$OUTPUT"
echo ""                                            | tee -a "$OUTPUT"

run_test() {
  local clientes=$1
  local duracion=$2

  echo "------------------------------------------" | tee -a "$OUTPUT"
  echo " TEST: $clientes clientes / ${duracion}s   " | tee -a "$OUTPUT"
  echo "------------------------------------------" | tee -a "$OUTPUT"

  node "$SCRIPT" "$URL" "$clientes" "$duracion" 2>&1 | tee -a "$OUTPUT"

  echo "" | tee -a "$OUTPUT"
  echo "Esperando 10s antes del siguiente test..." | tee -a "$OUTPUT"
  sleep 10
}

run_test 500   30
run_test 2000  60
run_test 10000 90

echo "==========================================" | tee -a "$OUTPUT"
echo " TODOS LOS TESTS COMPLETADOS              " | tee -a "$OUTPUT"
echo " Resultados guardados en:                 " | tee -a "$OUTPUT"
echo " $OUTPUT                                  " | tee -a "$OUTPUT"
echo "==========================================" | tee -a "$OUTPUT"
