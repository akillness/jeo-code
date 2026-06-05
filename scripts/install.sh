#!/bin/sh
# joc (jeo-code) installer — gjc-style bun global install.
#
# The gjc parity path is a single bun global install. The published-package form
# (once jeo-code is on npm) is identical to gajae-code's:
#
#   bun install -g jeo-code            # gjc parity: bun install -g gajae-code
#
# Until then this script performs the equivalent global install straight from the
# GitHub repo, auto-installing bun if missing.
#
# Usage:
#   curl -fsSL <raw-url>/scripts/install.sh | sh   # global install from GitHub (default)
#   sh scripts/install.sh                          # same as above
#   sh scripts/install.sh --npm                    # bun install -g jeo-code (npm registry)
#   sh scripts/install.sh --ref v0.1.0             # global install of a specific git ref
#   sh scripts/install.sh --local                  # dev: install from this clone (bun link)
#   sh scripts/install.sh --binary                 # compile a standalone binary (no bun at runtime)
set -e

REPO="${JOC_REPO:-akillness/jeo-code}"
PKG="${JOC_PKG:-jeo-code}"
INSTALL_DIR="${JOC_INSTALL_DIR:-$HOME/.local/bin}"
MIN_BUN_VERSION="1.3.14"

MODE="global"
REF=""
SRC_DIR=""
LINKED=""

while [ $# -gt 0 ]; do
  case "$1" in
    --global)   MODE="global"; shift ;;
    --npm)      MODE="npm"; shift ;;
    --local)    MODE="local"; shift ;;
    --binary)   MODE="binary"; shift ;;
    --ref)      shift; REF="$1"; shift ;;
    --ref=*)    REF="${1#*=}"; shift ;;
    -r)         shift; REF="$1"; shift ;;
    -h|--help)
      cat <<EOF
joc installer (gjc-style bun global install)
  (default)       bun global install from github:$REPO  →  exposes 'joc'
  --npm           bun install -g $PKG (npm registry; gjc parity once published)
  --local         install from current clone via 'bun link' (dev)
  --binary        compile a standalone binary (no bun needed at runtime)
  --ref <ref>     install a specific tag/branch/commit
Environment:
  JOC_INSTALL_DIR (default \$HOME/.local/bin — compatibility symlink)
  JOC_REPO        (default $REPO)
  JOC_PKG         (default $PKG)
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1"; exit 1 ;;
  esac
done

has_bun() { command -v bun >/dev/null 2>&1; }

version_ge() {
  cur="$1"; min="$2"
  cm="${cur%%.*}";  rest="${cur#*.}";  cn="${rest%%.*}";  cp="${rest#*.}"; cp="${cp%%.*}"
  mm="${min%%.*}";  rest="${min#*.}";  mn="${rest%%.*}";  mp="${rest#*.}"; mp="${mp%%.*}"
  [ "$cm" -ne "$mm" ] && { [ "$cm" -gt "$mm" ]; return $?; }
  [ "$cn" -ne "$mn" ] && { [ "$cn" -gt "$mn" ]; return $?; }
  [ "$cp" -ge "$mp" ]
}

require_bun() {
  if ! has_bun; then
    echo "Installing bun (required runtime)..."
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
  fi
  v=$(bun --version 2>/dev/null | head -1)
  v_clean=${v%%-*}
  if ! version_ge "$v_clean" "$MIN_BUN_VERSION"; then
    echo "Bun $MIN_BUN_VERSION+ required (found $v_clean). Upgrade: bun upgrade"
    exit 1
  fi
}

bun_bin_dir() { echo "${BUN_INSTALL:-$HOME/.bun}/bin"; }

# bun global install (the gjc-idiomatic path). Exposes the package's `joc` bin
# in bun's global bin dir (~/.bun/bin/joc).
install_global() {
  spec="github:$REPO"
  [ -n "$REF" ] && spec="github:$REPO#$REF"
  echo "Installing $PKG globally via bun ($spec)..."
  bun add -g "$spec"
}

install_npm() {
  spec="$PKG"
  [ -n "$REF" ] && spec="$PKG@$REF"
  echo "Installing $PKG globally via bun ($spec)..."
  bun add -g "$spec"
}

# Dev install from the current clone: register the package globally with
# `bun link` so source edits are picked up immediately.
install_local() {
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  if [ ! -f "$SRC_DIR/src/cli.ts" ]; then
    echo "--local: expected cli.ts at $SRC_DIR/src/cli.ts"
    exit 1
  fi
  ( cd "$SRC_DIR" && bun install --silent >/dev/null )
  ( cd "$SRC_DIR" && bun link >/dev/null 2>&1 ) || true
}

install_binary() {
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  if [ ! -f "$SRC_DIR/src/cli.ts" ]; then
    echo "--binary must be run from a clone (expected $SRC_DIR/src/cli.ts)"
    exit 1
  fi
  ( cd "$SRC_DIR" && bun install --silent >/dev/null )
  mkdir -p "$INSTALL_DIR"
  echo "Compiling standalone binary → $INSTALL_DIR/joc ..."
  ( cd "$SRC_DIR" && bun build src/cli.ts --compile --outfile "$INSTALL_DIR/joc" >/dev/null )
  chmod +x "$INSTALL_DIR/joc" 2>/dev/null || true
}

# Add a compatibility symlink in INSTALL_DIR so the documented location keeps
# working even when bun's global bin dir is not on PATH.
link_compat() {
  BUN_BIN="$(bun_bin_dir)"
  [ -e "$BUN_BIN/joc" ] && LINKED="$BUN_BIN/joc"
  mkdir -p "$INSTALL_DIR"
  if [ -n "$LINKED" ]; then
    ln -sf "$LINKED" "$INSTALL_DIR/joc"
    chmod +x "$INSTALL_DIR/joc" 2>/dev/null || true
  fi
}

print_done() {
  BUN_BIN="$(bun_bin_dir)"
  echo ""
  [ -n "$LINKED" ] && echo "Linked joc via bun → $LINKED"
  [ -e "$INSTALL_DIR/joc" ] && echo "Compatibility symlink → $INSTALL_DIR/joc"
  case ":$PATH:" in
    *":$BUN_BIN:"*|*":$INSTALL_DIR:"*) echo "Run: joc --help" ;;
    *) echo "Add $BUN_BIN (or $INSTALL_DIR) to PATH, then run: joc --help" ;;
  esac
}

require_bun
case "$MODE" in
  global) install_global; link_compat ;;
  npm)    install_npm;    link_compat ;;
  local)  install_local;  link_compat ;;
  binary) install_binary ;;
esac
print_done
