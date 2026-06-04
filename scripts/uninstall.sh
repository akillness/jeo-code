#!/bin/sh
# joc uninstaller — removes binary symlink and optionally global config.
# Usage:
#   sh scripts/uninstall.sh              # remove binary only
#   sh scripts/uninstall.sh --purge      # also remove ~/.joc/
set -e
INSTALL_DIR="${JOC_INSTALL_DIR:-$HOME/.local/bin}"
PURGE=0
[ "$1" = "--purge" ] && PURGE=1

if [ -L "$INSTALL_DIR/joc" ] || [ -f "$INSTALL_DIR/joc" ]; then
  rm -f "$INSTALL_DIR/joc"
  echo "Removed $INSTALL_DIR/joc"
else
  echo "No joc binary at $INSTALL_DIR/joc"
fi

# Remove the bun-native link (bin + global registry entry).
BUN_BIN="${BUN_INSTALL:-$HOME/.bun}/bin"
if [ -L "$BUN_BIN/joc" ] || [ -f "$BUN_BIN/joc" ]; then
  rm -f "$BUN_BIN/joc"
  echo "Removed $BUN_BIN/joc (bun link)"
fi
GLOBAL_PKG="${BUN_INSTALL:-$HOME/.bun}/install/global/node_modules/jeo-code"
[ -e "$GLOBAL_PKG" ] && rm -rf "$GLOBAL_PKG" && echo "Unregistered jeo-code from bun global"

if [ "$PURGE" = "1" ]; then
  rm -rf "$HOME/.joc"
  echo "Removed ~/.joc/"
fi
