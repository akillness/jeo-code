#!/bin/sh
# Smoke-test installer modes in isolated temp dirs (no network, host arch).
#   sh scripts/smoke-test.sh
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== --binary (compiled standalone, no bun at runtime) =="
JOC_INSTALL_DIR="$TMP/bin" sh "$ROOT/scripts/install.sh" --binary >/dev/null
V="$(env -i PATH=/usr/bin:/bin "$TMP/bin/joc" --version)"
echo "  joc --version → $V"
case "$V" in
  "joc v"*) echo "  OK: binary runs without bun on PATH" ;;
  *) echo "  FAIL: unexpected version output"; exit 1 ;;
esac

echo "Smoke test passed."
