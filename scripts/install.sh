#!/bin/sh
# jeo (jeo-code) installer — gjc-style bun global install.
#
# The gjc parity path is a single Bun global install. The published-package form
# (once jeo-code is on npm) is identical to gajae-code's:
#
#   bun install -g jeo-code            # gjc parity: bun install -g gajae-code
#
# Until then this script performs the equivalent global install straight from the
# GitHub repo, auto-installing Bun if missing. Registry flags are explicit and
# safe by default: --registry is one-shot for this install; --persist-registry is
# required before npm's global config is changed.
#
# Usage:
#   curl -fsSL <raw-url>/scripts/install.sh | sh          # git install from GitHub URL
#   sh scripts/install.sh                                 # same as above
#   sh scripts/install.sh --repo https://github.com/akillness/jeo-code.git
#   sh scripts/install.sh --npm --registry https://registry.npmjs.org/
#   sh scripts/install.sh --npm --registry https://npmjs.co.kr
#   sh scripts/install.sh --registry https://your-company-registry.com --persist-registry
#   sh scripts/install.sh --scope @my-org --registry https://your-company-registry.com --project-npmrc
#   sh scripts/install.sh --ref v0.1.0                    # global install of a specific git ref
#   sh scripts/install.sh --local                         # dev: install from this clone (bun link)
#   sh scripts/install.sh --binary                        # compile a standalone binary (no bun at runtime)
set -e

DEFAULT_REPO="https://github.com/akillness/jeo-code.git"
REPO="${JEO_REPO:-${JEO_REPO:-${JEO_REPO_URL:-${JEO_REPO_URL:-$DEFAULT_REPO}}}}"
PKG="${JEO_PKG:-${JEO_PKG:-jeo-code}}"
INSTALL_DIR="${JEO_INSTALL_DIR:-${JEO_INSTALL_DIR:-$HOME/.local/bin}}"
MIN_BUN_VERSION="1.3.14"

MODE="global"
REF=""
SRC_DIR=""
LINKED=""
REGISTRY="${JEO_REGISTRY:-${JEO_REGISTRY:-}}"
SCOPE="${JEO_REGISTRY_SCOPE:-${JEO_REGISTRY_SCOPE:-}}"
PERSIST_REGISTRY=0
PROJECT_NPMRC=0
DRY_RUN=0

usage() {
  cat <<EOF
jeo installer (gjc-style Bun global install)
  (default)            bun global install from $REPO  →  exposes 'jeo'
  --repo <url|owner/repo>  git source (default $DEFAULT_REPO)
  --npm                bun install -g $PKG (npm registry; gjc parity once published)
  --package <name>     npm package name for --npm (default $PKG)
  --registry <url>     one-shot registry for this install (does not mutate npm config)
  --scope <@scope>     registry scope key for persisted/project .npmrc config
  --persist-registry   run 'npm config set registry <url>' (or '<scope>:registry')
  --project-npmrc      write registry=<url> (or <scope>:registry=<url>) to ./.npmrc
  --print-registry     run 'npm config get registry' (or '<scope>:registry') and exit
  --delete-registry    run 'npm config delete registry' (or '<scope>:registry') and exit
  --local              install from current clone via 'bun link' (dev)
  --binary             compile a standalone binary (no bun needed at runtime)
  --ref <ref>          install a specific tag/branch/commit
  --dry-run            print the bun/npm commands without installing
Environment:
  JEO_INSTALL_DIR      (default \$HOME/.local/bin — compatibility symlink; legacy JEO_* names still honored)
  JEO_REPO/JEO_REPO_URL(default $DEFAULT_REPO)
  JEO_PKG             (default $PKG)
  JEO_REGISTRY        one-shot or persisted registry URL
  JEO_REGISTRY_SCOPE  optional scope such as @my-org
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --global)   MODE="global"; shift ;;
    --npm)      MODE="npm"; shift ;;
    --local)    MODE="local"; shift ;;
    --binary)   MODE="binary"; shift ;;
    --repo)     shift; REPO="$1"; shift ;;
    --repo=*)   REPO="${1#*=}"; shift ;;
    --package)  shift; PKG="$1"; shift ;;
    --package=*) PKG="${1#*=}"; shift ;;
    --registry|--npm-registry) shift; REGISTRY="$1"; shift ;;
    --registry=*|--npm-registry=*) REGISTRY="${1#*=}"; shift ;;
    --scope)    shift; SCOPE="$1"; shift ;;
    --scope=*)  SCOPE="${1#*=}"; shift ;;
    --persist-registry) PERSIST_REGISTRY=1; shift ;;
    --project-npmrc) PROJECT_NPMRC=1; shift ;;
    --print-registry) MODE="registry-print"; shift ;;
    --delete-registry) MODE="registry-delete"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --ref)      shift; REF="$1"; shift ;;
    --ref=*)    REF="${1#*=}"; shift ;;
    -r)         shift; REF="$1"; shift ;;
    -h|--help)  usage; exit 0 ;;
    *)
      echo "Unknown option: $1"
      exit 1 ;;
  esac
done

has_bun() { command -v bun >/dev/null 2>&1; }
has_npm() { command -v npm >/dev/null 2>&1; }

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
    echo "Installing Bun (required runtime)..."
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
  fi
  v=$(bun --version 2>/dev/null)
  v_clean=${v%%-*}
  if ! version_ge "$v_clean" "$MIN_BUN_VERSION"; then
    echo "Bun $MIN_BUN_VERSION+ required (found $v_clean). Upgrade: bun upgrade"
    exit 1
  fi
}

bun_bin_dir() { echo "${BUN_INSTALL:-$HOME/.bun}/bin"; }

registry_key() {
  if [ -n "$SCOPE" ]; then
    case "$SCOPE" in
      @*) echo "$SCOPE:registry" ;;
      *) echo "@$SCOPE:registry" ;;
    esac
  else
    echo "registry"
  fi
}

validate_registry_url() {
  [ -z "$REGISTRY" ] && return 0
  case "$REGISTRY" in
    http://*|https://*) return 0 ;;
    *) echo "--registry must start with http:// or https:// (got '$REGISTRY')"; exit 1 ;;
  esac
}

require_npm_config() {
  if ! has_npm; then
    echo "npm is required for npm config operations (--persist-registry/--print-registry/--delete-registry)."
    exit 1
  fi
}

print_registry() {
  require_npm_config
  key=$(registry_key)
  npm config get "$key"
}

delete_registry() {
  require_npm_config
  key=$(registry_key)
  if [ "$DRY_RUN" = "1" ]; then
    echo "+ npm config delete $key"
  else
    npm config delete "$key"
  fi
  echo "Deleted npm config key: $key"
}

persist_registry() {
  [ "$PERSIST_REGISTRY" = "1" ] || return 0
  validate_registry_url
  require_npm_config
  key=$(registry_key)
  if [ "$DRY_RUN" = "1" ]; then
    echo "+ npm config set $key $REGISTRY"
  else
    npm config set "$key" "$REGISTRY"
  fi
  echo "Persisted npm config: $key=$REGISTRY"
}

write_project_npmrc() {
  [ "$PROJECT_NPMRC" = "1" ] || return 0
  validate_registry_url
  key=$(registry_key)
  if [ "$DRY_RUN" = "1" ]; then
    echo "+ printf '%s=%s\\n' '$key' '$REGISTRY' > .npmrc"
  else
    printf '%s=%s\n' "$key" "$REGISTRY" > .npmrc
  fi
  echo "Wrote project registry config: .npmrc ($key=$REGISTRY)"
}

normalize_repo_spec() {
  repo="$1"
  case "$repo" in
    github:*|git+*|ssh://*|git@*) spec="$repo" ;;
    http://*|https://*) spec="git+$repo" ;;
    */*) spec="github:$repo" ;;
    *) spec="$repo" ;;
  esac
  [ -n "$REF" ] && spec="$spec#$REF"
  echo "$spec"
}

run_bun_global_add() {
  spec="$1"
  if [ -n "$REGISTRY" ]; then
    validate_registry_url
    if [ -n "$SCOPE" ] && [ "$PERSIST_REGISTRY" != "1" ] && [ "$PROJECT_NPMRC" != "1" ]; then
      echo "Note: scoped registries need --persist-registry or --project-npmrc for npm-compatible scope config; using $REGISTRY as this install's one-shot registry."
    fi
    if [ "$DRY_RUN" = "1" ]; then
      echo "+ NPM_CONFIG_REGISTRY=$REGISTRY npm_config_registry=$REGISTRY bun add -g $spec"
    else
      NPM_CONFIG_REGISTRY="$REGISTRY" npm_config_registry="$REGISTRY" bun add -g "$spec"
    fi
  else
    if [ "$DRY_RUN" = "1" ]; then
      echo "+ bun add -g $spec"
    else
      bun add -g "$spec"
    fi
  fi
}

# Bun global install (the gjc-idiomatic path). Exposes the package's `jeo` bin
# in Bun's global bin dir (~/.bun/bin/jeo).
install_global() {
  spec=$(normalize_repo_spec "$REPO")
  echo "Installing $PKG globally via Bun ($spec)..."
  run_bun_global_add "$spec"
}

install_npm() {
  spec="$PKG"
  [ -n "$REF" ] && spec="$PKG@$REF"
  echo "Installing $PKG globally via Bun ($spec)..."
  run_bun_global_add "$spec"
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
  if [ "$DRY_RUN" = "1" ]; then
    echo "+ ( cd $SRC_DIR && bun install --silent )"
    echo "+ ( cd $SRC_DIR && bun link )"
  else
    ( cd "$SRC_DIR" && bun install --silent >/dev/null )
    ( cd "$SRC_DIR" && bun link >/dev/null 2>&1 ) || true
  fi
}

install_binary() {
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  if [ ! -f "$SRC_DIR/src/cli.ts" ]; then
    echo "--binary must be run from a clone (expected $SRC_DIR/src/cli.ts)"
    exit 1
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "+ ( cd $SRC_DIR && bun install --silent )"
    echo "+ bun build src/cli.ts --compile --outfile $INSTALL_DIR/jeo"
  else
    ( cd "$SRC_DIR" && bun install --silent >/dev/null )
    mkdir -p "$INSTALL_DIR"
    echo "Compiling standalone binary → $INSTALL_DIR/jeo ..."
    ( cd "$SRC_DIR" && bun build src/cli.ts --compile --outfile "$INSTALL_DIR/jeo" >/dev/null )
    chmod +x "$INSTALL_DIR/jeo" 2>/dev/null || true
  fi
}

# Add a compatibility symlink in INSTALL_DIR so the documented location keeps
# working even when Bun's global bin dir is not on PATH.
link_compat() {
  [ "$DRY_RUN" = "1" ] && return 0
  BUN_BIN="$(bun_bin_dir)"
  [ -e "$BUN_BIN/jeo" ] && LINKED="$BUN_BIN/jeo"
  [ -z "$LINKED" ] && [ -e "$BUN_BIN/joc" ] && LINKED="$BUN_BIN/joc"
  mkdir -p "$INSTALL_DIR"
  if [ -n "$LINKED" ]; then
    ln -sf "$LINKED" "$INSTALL_DIR/jeo"
    chmod +x "$INSTALL_DIR/jeo" 2>/dev/null || true
    # Legacy alias: `joc` keeps working after the jeo rename.
    ln -sf "$LINKED" "$INSTALL_DIR/joc"
    chmod +x "$INSTALL_DIR/joc" 2>/dev/null || true
  fi
}

print_done() {
  BUN_BIN="$(bun_bin_dir)"
  echo ""
  if [ "$DRY_RUN" = "1" ]; then
    echo "Dry run complete; no install changes were made."
    return 0
  fi
  [ -n "$LINKED" ] && echo "Linked jeo via Bun → $LINKED"
  [ -e "$INSTALL_DIR/jeo" ] && echo "Compatibility symlink → $INSTALL_DIR/jeo"
  case ":$PATH:" in
    *":$BUN_BIN:"*|*":$INSTALL_DIR:"*) echo "Run: jeo --help" ;;
    *) echo "Add $BUN_BIN (or $INSTALL_DIR) to PATH, then run: jeo --help" ;;
  esac
}

case "$MODE" in
  registry-print) print_registry; exit 0 ;;
  registry-delete) delete_registry; exit 0 ;;
esac

persist_registry
write_project_npmrc
require_bun
case "$MODE" in
  global) install_global; link_compat ;;
  npm)    install_npm;    link_compat ;;
  local)  install_local;  link_compat ;;
  binary) install_binary ;;
esac
print_done
