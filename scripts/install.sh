#!/bin/sh
# joc (jeo-code) installer — mirrors gjc's install.sh pattern.
# Usage:
#   curl -fsSL <raw-url>/scripts/install.sh | sh
#   sh scripts/install.sh --local            # install from local clone (dev)
#   sh scripts/install.sh --ref v0.1.0       # install specific git ref
set -e

REPO="${JOC_REPO:-jeo-code/jeo-code}"
INSTALL_DIR="${JOC_INSTALL_DIR:-$HOME/.local/bin}"
MIN_BUN_VERSION="1.3.14"

MODE=""
REF=""
SRC_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --local)    MODE="local"; shift ;;
    --source)   MODE="source"; shift ;;
    --ref)      shift; REF="$1"; shift ;;
    --ref=*)    REF="${1#*=}"; shift ;;
    -r)         shift; REF="$1"; shift ;;
    -h|--help)
      cat <<EOF
joc installer
  --local         install from current clone (uses repo root of this script)
  --source        clone repo and install via bun (default)
  --ref <ref>     install specific tag/branch/commit
Environment:
  JOC_INSTALL_DIR (default \$HOME/.local/bin)
  JOC_REPO        (default jeo-code/jeo-code)
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1"; exit 1 ;;
  esac
done

has_bun() { command -v bun >/dev/null 2>&1; }
has_git() { command -v git >/dev/null 2>&1; }

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

resolve_source_dir() {
  if [ "$MODE" = "local" ]; then
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
    if [ ! -f "$SRC_DIR/src/cli.ts" ]; then
      echo "--local: expected cli.ts at $SRC_DIR/src/cli.ts"
      exit 1
    fi
    return
  fi
  # --source: clone fresh
  if ! has_git; then
    echo "git is required for source install"; exit 1
  fi
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  if [ -n "$REF" ]; then
    git clone "https://github.com/${REPO}.git" "$TMP" >/dev/null
    (cd "$TMP" && git checkout "$REF" >/dev/null)
  else
    git clone --depth 1 "https://github.com/${REPO}.git" "$TMP" >/dev/null
  fi
  if [ ! -f "$TMP/src/cli.ts" ]; then
    echo "Expected src/cli.ts inside cloned repo"; exit 1
  fi
  SRC_DIR="$TMP"
}

install_deps() {
  ( cd "$SRC_DIR" && bun install --silent >/dev/null )
}

install_link() {
  BUN_BIN="${BUN_INSTALL:-$HOME/.bun}/bin"
  # bun-native install: register the package globally and expose its `joc` bin
  # in bun's global bin dir (idiomatic `bun link`, the bun analogue of npm link).
  ( cd "$SRC_DIR" && bun link >/dev/null 2>&1 ) || true

  LINKED=""
  [ -e "$BUN_BIN/joc" ] && LINKED="$BUN_BIN/joc"

  # Compatibility symlink in INSTALL_DIR (default ~/.local/bin) so the documented
  # location keeps working even when bun's global bin is not on PATH.
  mkdir -p "$INSTALL_DIR"
  if [ -n "$LINKED" ]; then
    ln -sf "$LINKED" "$INSTALL_DIR/joc"
  else
    # Fallback for older bun without bin exposure: link the entry directly.
    ln -sf "$SRC_DIR/src/cli.ts" "$INSTALL_DIR/joc"
  fi
  chmod +x "$INSTALL_DIR/joc" 2>/dev/null || true
}

print_done() {
  echo ""
  [ -n "$LINKED" ] && echo "Linked joc via 'bun link' → $LINKED"
  echo "Installed joc → $INSTALL_DIR/joc"
  case ":$PATH:" in
    *":$INSTALL_DIR:"*|*":$BUN_BIN:"*) echo "Run: joc --help" ;;
    *) echo "Add $INSTALL_DIR (or $BUN_BIN) to PATH, then run: joc --help" ;;
  esac
}

[ -z "$MODE" ] && MODE="source"
require_bun
resolve_source_dir
install_deps
install_link
print_done
