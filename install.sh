#!/usr/bin/env bash
set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
CANONICAL="$SCRIPT_DIR/scripts/install.sh"

if [ ! -f "$CANONICAL" ]; then
    echo "Error: Canonical installer script not found at $CANONICAL" >&2
    exit 1
fi

echo "=== @jeo-code installer ==="
exec sh "$CANONICAL" --local "$@"