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

if [ "$PURGE" = "1" ]; then
  rm -rf "$HOME/.joc"
  echo "Removed ~/.joc/"
fi
