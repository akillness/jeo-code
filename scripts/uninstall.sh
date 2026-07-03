#!/bin/sh
# jeo uninstaller — removes binary symlink and optionally global config.
# Usage:
#   sh scripts/uninstall.sh              # remove binary only
#   sh scripts/uninstall.sh --purge      # also remove ~/.jeo/
set -e
INSTALL_DIR="${JEO_INSTALL_DIR:-$HOME/.local/bin}"
PURGE=0
[ "$1" = "--purge" ] && PURGE=1

for BIN_NAME in jeo joc; do
  if [ -L "$INSTALL_DIR/$BIN_NAME" ] || [ -f "$INSTALL_DIR/$BIN_NAME" ]; then
    rm -f "$INSTALL_DIR/$BIN_NAME"
    echo "Removed $INSTALL_DIR/$BIN_NAME"
  fi
done

# Remove the bun-native link (bin + global registry entry).
BUN_BIN="${BUN_INSTALL:-$HOME/.bun}/bin"
for BIN_NAME in jeo joc; do
  if [ -L "$BUN_BIN/$BIN_NAME" ] || [ -f "$BUN_BIN/$BIN_NAME" ]; then
    rm -f "$BUN_BIN/$BIN_NAME"
    echo "Removed $BUN_BIN/$BIN_NAME (bun link)"
  fi
done
GLOBAL_PKG="${BUN_INSTALL:-$HOME/.bun}/install/global/node_modules/jeo-code"
[ -e "$GLOBAL_PKG" ] && rm -rf "$GLOBAL_PKG" && echo "Unregistered jeo-code from bun global"

if [ "$PURGE" = "1" ]; then
  rm -rf "$HOME/.jeo"
  echo "Removed ~/.jeo/"
fi
