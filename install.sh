#!/usr/bin/env bash
set -e

echo "=== @jeo-code Installation & Setup ==="

# Get absolute path of this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
AGENT_DIR="$SCRIPT_DIR/coding-agent"

echo "Installing Bun dependencies in $AGENT_DIR..."
cd "$AGENT_DIR"
bun install

echo "Making CLI executable..."
chmod +x "$AGENT_DIR/src/cli.ts"

# Setup symlink in ~/.local/bin/
LOCAL_BIN="$HOME/.local/bin"
mkdir -p "$LOCAL_BIN"

echo "Creating symlink for 'joc' in $LOCAL_BIN/joc..."
rm -f "$LOCAL_BIN/joc"
ln -s "$AGENT_DIR/src/cli.ts" "$LOCAL_BIN/joc"

echo ""
echo "[SUCCESS] @jeo-code successfully installed!"
echo "You can now run 'joc' in your terminal."
echo "First run 'joc setup' to configure your API keys."
