# ── OS / platform detection ──────────────────────────────────
_OS="$(uname -s 2>/dev/null || echo Windows)"
case "$_OS" in
  Darwin*)               PLATFORM="macos"   ;;
  Linux*)                PLATFORM="linux"   ;;
  MINGW*|MSYS*|CYGWIN*)  PLATFORM="windows" ;;
  *)                     PLATFORM="windows" ;;
esac
echo "=== OS: $PLATFORM ==="

# Platform-specific home and skills root
# macOS / Linux : $HOME/.agents/skills
# Windows (Git Bash / WSL) : $USERPROFILE/.agents/skills
if [ "$PLATFORM" = "windows" ]; then
  _HOME="${USERPROFILE:-$HOME}"
else
  _HOME="$HOME"
fi
SKILLS_ROOT="$_HOME/.agents/skills"
REPO_URL="https://github.com/akillness/oh-my-skills"
echo "SKILLS_ROOT: $SKILLS_ROOT"

# Claude Code config root (platform-specific)
if [ "$PLATFORM" = "windows" ]; then
  CLAUDE_CONFIG_DIR="${APPDATA:-$_HOME/AppData/Roaming}/Claude"
elif [ "$PLATFORM" = "macos" ]; then
  CLAUDE_CONFIG_DIR="$_HOME/.claude"
else
  CLAUDE_CONFIG_DIR="$_HOME/.claude"
fi
echo "CLAUDE_CONFIG_DIR: $CLAUDE_CONFIG_DIR"

# ── Agent detection ───────────────────────────────────────────
echo ""
echo "=== Platform Detection ==="
DETECTED_AGENTS=""
if command -v claude   &>/dev/null; then echo "✅ Claude Code";  DETECTED_AGENTS="${DETECTED_AGENTS:+$DETECTED_AGENTS,}claude-code"; fi
if command -v codex    &>/dev/null; then echo "✅ Codex CLI";    DETECTED_AGENTS="${DETECTED_AGENTS:+$DETECTED_AGENTS,}codex"; fi
# agy is the canonical binary name (not antigravity); some Linux packagers ship antigravity as an alias.
# Dir-only existence is NOT enough — stale `~/.gemini/antigravity/` from a failed prior install would
# trigger a false positive. Require the binary OR the authoritative config marker.
if command -v agy &>/dev/null \
  || command -v antigravity &>/dev/null \
  || [ -f "$_HOME/.gemini/antigravity-cli/settings.json" ]; then
  echo "✅ Antigravity CLI (agy)"
  DETECTED_AGENTS="${DETECTED_AGENTS:+$DETECTED_AGENTS,}antigravity"
fi
if command -v opencode &>/dev/null; then echo "✅ OpenCode";     DETECTED_AGENTS="${DETECTED_AGENTS:+$DETECTED_AGENTS,}opencode"; fi
if command -v gjc      &>/dev/null; then echo "✅ Gajae Code (gjc)"; DETECTED_AGENTS="${DETECTED_AGENTS:+$DETECTED_AGENTS,}gjc"; fi

[ -z "$DETECTED_AGENTS" ] && { echo "⚠️  No AI agents detected. Install at least one platform first."; exit 1; }
echo ""
echo "Target agents: $DETECTED_AGENTS"

# Snapshot existing skills BEFORE installation (for preservation check)
echo ""
echo "=== Existing Skills (will be preserved) ==="
if [ -d "$SKILLS_ROOT" ]; then
  ls "$SKILLS_ROOT" 2>/dev/null | sort > /tmp/skills_before.txt
  cat /tmp/skills_before.txt
  echo "($(wc -l < /tmp/skills_before.txt | tr -d ' ') skills found — none will be removed)"
else
  echo "(skills directory not yet created)"
  touch /tmp/skills_before.txt
fi

# Ensure skills CLI is available
if ! command -v skills &>/dev/null; then
  echo ""
  echo "Installing skills CLI..."
  npm install -g skills
fi
# ────────────────────────────────────────────────────────
# Flag reference:
#   -g          : install to global location (~/.agents/skills/)
#   -a <agents> : link to specific agents (comma-separated, or '*' for all)
#   --skill <s> : select specific skills (comma-separated, or '*' for all)
#   --yes       : skip interactive prompts
#   --copy      : copy files instead of symlinks (robust overwrite)
# ────────────────────────────────────────────────────────

# Install ALL 137 skills to global store, link shared skills to all detected agents
# --full-depth: discovers nested skills (7 skills require this to be found)
# Platform-specific skills (omc, ohmg, omx) are re-targeted in Step 2
skills add -g "$REPO_URL" --skill '*' -a '*' --yes --copy --full-depth
skills add -g "$REPO_URL" --skill deepinit --skill deep-dive -a claude-code --yes --copy --full-depth
# ╔══════════════════════════════════════════════════════════════╗
# ║  Platform Skill Mapping (from SKILL.md metadata)            ║
# ║                                                              ║
# ║  omc       → Claude Code only                               ║
# ║  ohmg      → Gemini CLI (+ Antigravity)                     ║
# ║  omx       → Codex + Claude Code + Gemini CLI               ║
# ╚══════════════════════════════════════════════════════════════╝

# omc — Claude Code only
skills add -g "$REPO_URL" --skill omc -a 'claude-code' --yes --copy

# ohmg — Antigravity CLI
# Binary: agy (canonical); some Linux distros also ship as 'antigravity' alias
# skills CLI globalSkillsDir = ~/.gemini/antigravity/skills; detection requires `agy` or
#   ~/.gemini/antigravity-cli/settings.json (config root for agy lifecycle hooks).
# Older Vercel skills CLI versions reject `-a antigravity`; fall back to gemini-cli and
# mirror the install into the antigravity skills dir so `agy` discovers it.
mkdir -p "$_HOME/.gemini/antigravity/skills"
mkdir -p "$_HOME/.gemini/antigravity-cli/hooks"
# Capture stderr so we can distinguish "unknown agent" rejection from real failures
# (network / source / install errors) — the latter must surface, not silently fall back.
_OHMG_ERR="$(mktemp -t ohmg_skills_err.XXXXXX 2>/dev/null || echo /tmp/ohmg_skills_err.$$)"
if skills add -g "$REPO_URL" --skill ohmg -a 'antigravity' --yes --copy 2>"$_OHMG_ERR"; then
  rm -f "$_OHMG_ERR"
elif grep -qiE 'unknown agent|invalid agent|unsupported agent|agent .* not (recognized|supported|found)' "$_OHMG_ERR"; then
  echo "ℹ️  skills CLI does not recognize '-a antigravity' — using '-a gemini-cli' + refresh mirror"
  rm -f "$_OHMG_ERR"
  skills add -g "$REPO_URL" --skill ohmg -a 'gemini-cli' --yes --copy
  if [ -d "$_HOME/.gemini/skills/ohmg" ]; then
    # Refresh (not append) — older mirrors must not shadow the new install
    rm -rf "$_HOME/.gemini/antigravity/skills/ohmg"
    cp -R "$_HOME/.gemini/skills/ohmg" "$_HOME/.gemini/antigravity/skills/ohmg"
    echo "✅ ohmg mirrored to $_HOME/.gemini/antigravity/skills/ohmg"
  fi
else
  echo "❌ ohmg install failed (non-agent error):" >&2
  cat "$_OHMG_ERR" >&2
  rm -f "$_OHMG_ERR"
  # Do not mask network/source failures with a silent fallback
fi

# omx — Codex CLI primary, also usable from Claude Code
# NOTE: Codex CLI does NOT auto-load `~/.codex/skills/`. The omx skill ships its own
# runtime via `omx setup` (Step 3g via oh-my-codex). Writing to ~/.codex/skills/ is
# kept for parity with other agents but only takes effect through OMX's loader.
skills add -g "$REPO_URL" --skill omx -a 'codex,claude-code' --yes --copy

# ── Clean stale symlinks from non-target agents ──
echo ""
echo "=== Cleaning duplicate platform skill links ==="

cleanup_skill_link() {
  local skill="$1"; shift
  local allowed=("$@")

  for agent_dir in "${CLAUDE_CONFIG_DIR:-$_HOME/.claude}/skills" "$_HOME/.codex/skills" "$_HOME/.gemini/antigravity/skills" "$_HOME/.config/opencode/skills"; do
    local agent_name
    case "$agent_dir" in
      */.claude/*|*/Claude/*)         agent_name="claude-code" ;;
      */.codex/*)                     agent_name="codex" ;;
      */.gemini/antigravity/*)        agent_name="antigravity" ;;
      */.config/opencode/*)           agent_name="opencode" ;;
    esac

    local is_allowed=false
    for a in "${allowed[@]}"; do
      [[ "$a" == "$agent_name" ]] && is_allowed=true
    done

    if ! $is_allowed && [ -e "$agent_dir/$skill" ]; then
      rm -rf "$agent_dir/$skill"
      echo "  Removed $skill from $agent_name (not a target platform)"
    fi
  done
}

cleanup_skill_link "omc"       "claude-code"
cleanup_skill_link "ohmg"      "antigravity"
cleanup_skill_link "omx"       "codex" "claude-code"

echo "✅ Platform skill deduplication complete"
echo "=== Installing RTK ==="
_HOME="${_HOME:-${USERPROFILE:-$HOME}}"
# WARNING: `brew install rtk` installs the wrong package (Rust Type Kit, not Rust Token Killer).
# Use cargo or the official installer on all platforms.
case "$PLATFORM" in
  macos|linux)
    if command -v cargo &>/dev/null; then
      cargo install rtk
    else
      curl -fsSL https://raw.githubusercontent.com/crates-io/rtk/main/install.sh | sh
    fi
    export PATH="$_HOME/.cargo/bin:$PATH"
    ;;
  windows)
    if command -v cargo &>/dev/null; then
      cargo install rtk
      export PATH="${_HOME//\\//}/.cargo/bin:$PATH"
    else
      echo "⚠️  Install rtk: cargo install rtk  OR  https://github.com/crates-io/rtk/releases"
    fi
    ;;
esac

# Initialize globally (adds rtk hook to shell profile / PowerShell profile on Windows)
if command -v rtk &>/dev/null; then
  rtk init -g
  echo "✅ rtk installed and initialized"
  rtk gain
else
  echo "⚠️  rtk not found — re-run after manual install"
fi
echo "=== Installing Graphify ==="
# Package name: graphifyy — but import name is: graphify (not graphifyy)
# Install into a dedicated venv to avoid PEP 668 restrictions on managed Python installs.
_HOME="${_HOME:-${USERPROFILE:-$HOME}}"
GRAPHIFY_VENV="$_HOME/.agents/venvs/graphify"
if [ "$PLATFORM" = "windows" ]; then
  GRAPHIFY_PY="$GRAPHIFY_VENV/Scripts/python.exe"
else
  GRAPHIFY_PY="$GRAPHIFY_VENV/bin/python"
fi
uv venv "$GRAPHIFY_VENV" 2>/dev/null || true
uv pip install graphifyy --python "$GRAPHIFY_PY" 2>&1 | tail -2
echo "✅ graphify installed (venv: $GRAPHIFY_VENV)"
"$GRAPHIFY_PY" -c "import graphify; print('graphify import OK')"
echo "=== Installing ooo (Ouroboros) ==="
_HOME="${_HOME:-${USERPROFILE:-$HOME}}"
# Verify a pip command actually exists before invoking it — prior code fell back to
# `pip` without checking, which crashed on systems with only `python3 -m pip` available.
if command -v pip3 &>/dev/null; then
  PIP_CMD="pip3"
elif command -v pip &>/dev/null; then
  PIP_CMD="pip"
elif command -v python3 &>/dev/null && python3 -m pip --version &>/dev/null; then
  PIP_CMD="python3 -m pip"
else
  echo "❌ No pip found — install Python 3 + pip first (https://pip.pypa.io/en/stable/installation/)" >&2
  return 1 2>/dev/null || exit 1
fi
$PIP_CMD install "ouroboros-ai[all]"
echo "✅ ouroboros-ai installed"

# MCP config paths per platform
CODEX_MCP_DIR="$_HOME/.codex"

# Register ooo MCP with Claude Code
if command -v claude &>/dev/null; then
  claude mcp add ooo -s user -- ouroboros mcp serve
  echo "✅ ooo MCP registered with Claude Code"
fi

# Register ooo MCP with Codex.
# IMPORTANT: Codex CLI reads `~/.codex/config.toml` with `[mcp_servers.<name>]` blocks,
# NOT `~/.codex/mcp.json`. Earlier setup wrote a JSON file that Codex silently ignored,
# so the `ooo` server never registered. Append a TOML block instead, idempotently.
if command -v codex &>/dev/null; then
  mkdir -p "$CODEX_MCP_DIR"
  CODEX_TOML="$CODEX_MCP_DIR/config.toml"
  touch "$CODEX_TOML"
  if ! grep -q '^\[mcp_servers\.ooo\]' "$CODEX_TOML" 2>/dev/null; then
    {
      printf '\n[mcp_servers.ooo]\n'
      printf 'command = "ouroboros"\n'
      printf 'args = ["mcp", "serve"]\n'
    } >> "$CODEX_TOML"
    echo "✅ ooo MCP registered with Codex ($CODEX_TOML)"
  else
    echo "ℹ️  ooo MCP already in $CODEX_TOML — skipping"
  fi
  # Remove obsolete JSON file from older installs (never read by Codex)
  [ -f "$CODEX_MCP_DIR/mcp.json" ] && rm -f "$CODEX_MCP_DIR/mcp.json" \
    && echo "🧹 Removed obsolete $CODEX_MCP_DIR/mcp.json (unused by Codex)"
fi

ouroboros --version 2>/dev/null && echo "✅ ouroboros ready" || echo "⚠️  ouroboros not in PATH — restart shell"
echo "=== Installing Obsidian CLI ==="
_HOME="${_HOME:-${USERPROFILE:-$HOME}}"
case "$PLATFORM" in
  macos)
    # Obsidian is a cask (GUI app), not a formula — --cask is required
    command -v brew &>/dev/null && brew install --cask obsidian \
      || echo "ℹ️  brew not found — install Obsidian from https://obsidian.md/download"
    ;;
  linux)
    # Obsidian is NOT on the Snap Store — use flatpak only
    if command -v flatpak &>/dev/null; then
      flatpak install flathub md.obsidian.Obsidian -y
    else
      echo "ℹ️  Install Obsidian AppImage from https://obsidian.md/download"
    fi
    ;;
  windows)
    if command -v winget &>/dev/null; then
      winget install Obsidian.Obsidian
    elif command -v choco &>/dev/null; then
      choco install obsidian -y
    else
      echo "ℹ️  Install Obsidian from https://obsidian.md/download"
    fi
    ;;
esac

command -v obsidian &>/dev/null \
  && echo "✅ obsidian CLI available" \
  || echo "ℹ️  obsidian desktop CLI not in PATH — URI fallback (obsidian://) will be used"
echo "=== Bootstrapping llm-wiki vault ==="
# Defensive home guard (safe when run standalone without Step 0 context)
_HOME="${_HOME:-${USERPROFILE:-$HOME}}"
# Platform-aware default vault location — all platforms use ~/wiki for cross-platform Obsidian compatibility
case "$PLATFORM" in
  windows|macos|linux) WIKI_DEFAULT="$_HOME/wiki" ;;
esac
WIKI_VAULT="${LLM_WIKI_VAULT:-$WIKI_DEFAULT}"

if [ ! -d "$WIKI_VAULT" ]; then
  mkdir -p "$WIKI_VAULT/raw" "$WIKI_VAULT/wiki"
  touch "$WIKI_VAULT/index.md" "$WIKI_VAULT/log.md"
  echo "✅ wiki vault bootstrapped at $WIKI_VAULT"
else
  echo "✅ wiki vault exists at $WIKI_VAULT"
fi
echo "   Set LLM_WIKI_VAULT to override the default location."
echo "=== Registering semble MCP ==="
_HOME="${_HOME:-${USERPROFILE:-$HOME}}"
# Re-derive PLATFORM so this step works when re-run standalone after a shell restart
if [ -z "${PLATFORM:-}" ]; then
  case "$(uname -s 2>/dev/null || echo Windows)" in
    Darwin*)              PLATFORM="macos"   ;;
    Linux*)               PLATFORM="linux"   ;;
    MINGW*|MSYS*|CYGWIN*) PLATFORM="windows" ;;
    *)                    PLATFORM="windows" ;;
  esac
fi
# Uses uvx (part of uv) — install uv if missing
if ! command -v uvx &>/dev/null; then
  case "$PLATFORM" in
    macos|linux)
      curl -LsSf https://astral.sh/uv/install.sh | sh
      export PATH="$_HOME/.local/bin:$_HOME/.cargo/bin:$PATH"
      ;;
    windows)
      PS_CMD="pwsh"; command -v pwsh &>/dev/null || PS_CMD="powershell"
      $PS_CMD -c "irm https://astral.sh/uv/install.ps1 | iex"
      _WIN="${_HOME//\\//}"
      export PATH="$_WIN/.local/bin:$_WIN/.cargo/bin:${LOCALAPPDATA//\\//}/uv/bin:${LOCALAPPDATA//\\//}/Programs/uv:$PATH"
      ;;
  esac
fi
if ! command -v uvx &>/dev/null; then
  echo "⚠️  uvx not found after install — restart shell then re-run Step 3f"; return 0 2>/dev/null || exit 0
fi

# Install the semble CLI too (not just MCP) so shell-side `semble search` /
# `semble find-related` work alongside rtk-wrapped commands in the same shell.
if ! command -v semble &>/dev/null; then
  uv tool install semble && echo "✅ semble CLI installed (uv tool, isolated env)" \
    || echo "⚠️  semble CLI install failed — MCP still works via uvx"
fi

if command -v claude &>/dev/null; then
  claude mcp add semble -s user -- uvx --from "semble[mcp]" semble
  echo "✅ semble MCP registered with Claude Code"
fi

# Register semble MCP with Codex via config.toml (same constraint as ooo: codex reads TOML, not JSON)
if command -v codex &>/dev/null; then
  mkdir -p "$_HOME/.codex"
  CODEX_TOML="$_HOME/.codex/config.toml"
  touch "$CODEX_TOML"
  if ! grep -q '^\[mcp_servers\.semble\]' "$CODEX_TOML" 2>/dev/null; then
    {
      printf '\n[mcp_servers.semble]\n'
      printf 'command = "uvx"\n'
      printf 'args = ["--from", "semble[mcp]", "semble"]\n'
    } >> "$CODEX_TOML"
    echo "✅ semble MCP registered with Codex ($CODEX_TOML)"
  fi
fi

# Register semble MCP with Gemini CLI via settings.json (idempotent jq merge) —
# keeps MCP parity with Claude/Codex on machines where the rtk Gemini hook is active
GEMINI_JSON="$_HOME/.gemini/settings.json"
if [ -f "$GEMINI_JSON" ] && command -v jq &>/dev/null; then
  if jq -e '.mcpServers.semble' "$GEMINI_JSON" >/dev/null 2>&1; then
    echo "ℹ️  semble MCP already registered with Gemini"
  else
    TMP_JSON="$(mktemp)"
    jq '.mcpServers.semble = {"command":"uvx","args":["--from","semble[mcp]","semble"]}' \
      "$GEMINI_JSON" > "$TMP_JSON" && mv "$TMP_JSON" "$GEMINI_JSON"
    echo "✅ semble MCP registered with Gemini ($GEMINI_JSON)"
  fi
fi
echo "=== RTK × semble compatibility wiring ==="
_HOME="${_HOME:-${USERPROFILE:-$HOME}}"

# 1) Verify both tools coexist on PATH
RTK_OK=0; SEMBLE_OK=0
command -v rtk    &>/dev/null && RTK_OK=1
command -v semble &>/dev/null && SEMBLE_OK=1
[ "$RTK_OK" = 1 ]    && echo "✅ rtk on PATH ($(rtk --version 2>/dev/null | head -1))" \
                     || echo "⚠️  rtk missing — re-run Step 3a"
[ "$SEMBLE_OK" = 1 ] && echo "✅ semble on PATH" \
                     || echo "⚠️  semble CLI missing — re-run Step 3f (MCP-only still works via uvx)"

# 2) Inject the division-of-labor routing rule into each installed agent's
#    instruction file (marker-guarded: safe to re-run, never duplicates)
RULE_BLOCK='<!-- RTK-SEMBLE:START -->
## Code Search & Shell Output (rtk × semble division of labor)
- **Code discovery** (where is X implemented, find a symbol, explore unfamiliar code):
  `semble search "<query>" <path>` FIRST; expand from a hit with
  `semble find-related <file> <line> <path>`. Do not grep+read full files for discovery.
- **Exact pattern / regex verification and all other shell work**: use the normal
  commands — the rtk hook auto-wraps them (`rtk grep`, `rtk git status`, `rtk read`,
  `rtk test`, `rtk lint`) and compresses their output.
- The rtk hook does NOT rewrite `semble` invocations; both tools stay active in the
  same session. semble = first pass (what to read), rtk = every pass (output density).
- If `semble` is not on PATH, substitute `uvx --from "semble[mcp]" semble`.
- Check combined savings anytime with `rtk gain` and `semble savings`.
<!-- RTK-SEMBLE:END -->'

for f in "$_HOME/.claude/CLAUDE.md" "$_HOME/.codex/AGENTS.md" "$_HOME/.gemini/GEMINI.md" "$_HOME/.agents/AGENTS.md"; do
  [ -f "$f" ] || continue
  if grep -q 'RTK-SEMBLE:START' "$f" 2>/dev/null; then
    echo "ℹ️  routing rule already present: $f"
  else
    printf '\n%s\n' "$RULE_BLOCK" >> "$f"
    echo "✅ routing rule injected: $f"
  fi
done

# 3) Smoke check: rtk hook must leave semble invocations untouched
if [ "$RTK_OK" = 1 ] && [ "$SEMBLE_OK" = 1 ]; then
  semble --help >/dev/null 2>&1 && echo "✅ semble runs cleanly alongside the rtk hook" \
    || echo "⚠️  semble failed under the rtk shell hook — run 'rtk proxy semble --help' to debug"
fi
echo "=== Platform Plugin Setup ==="
_HOME="${_HOME:-${USERPROFILE:-$HOME}}"

# ── Claude Code: oh-my-claudecode plugin ─────────────────────────
# Provides /team, /autopilot, /ralph, /ultrawork, /ultraqa slash commands.
# Slash commands (/plugin, /omc:omc-setup) only execute INSIDE a Claude Code
# session — they fail with "No such file or directory" when run in bash.
# Use the `claude plugin` CLI subcommand for automated install; if the local
# Claude CLI version does not support it, print the in-session fallback.
if command -v claude &>/dev/null; then
  if claude plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode 2>/dev/null \
     && claude plugin install oh-my-claudecode 2>/dev/null; then
    echo "✅ Claude Code: oh-my-claudecode plugin installed"
    echo "   Open Claude Code once and run: /omc:omc-setup"
  else
    echo "ℹ️  'claude plugin' CLI unavailable in this Claude version."
    echo "   Open Claude Code and run these three slash commands manually:"
    echo "     /plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode"
    echo "     /plugin install oh-my-claudecode"
    echo "     /omc:omc-setup"
  fi
fi

# ── Codex CLI: oh-my-codex (OMX) ─────────────────────────────────
# Without OMX, the skill manuals for omx ship to ~/.codex/skills/ but the
# actual $team / $autopilot / $ulw / $ultraqa workflows have no runtime —
# Codex sees the keywords as unknown. OMX provides the loader + prompts.
if command -v codex &>/dev/null; then
  if command -v npm &>/dev/null; then
    npm install -g oh-my-codex 2>&1 | tail -3
    if command -v omx &>/dev/null; then
      omx setup
      echo "✅ Codex: oh-my-codex (omx) configured — \$team / \$autopilot / \$ulw / \$ultraqa available"
    else
      echo "⚠️  omx CLI not on PATH after install — restart shell, then run: omx setup"
    fi
  else
    echo "⚠️  npm not found — install Node.js to enable OMX workflows on Codex"
    echo "   https://nodejs.org/"
  fi
fi

# ── Antigravity / Gemini CLI: oh-my-agent (OMA) ──────────────────
# Without OMA, the ohmg skill manual lives in ~/.gemini/antigravity/skills/
# but /team /orchestrate /plan /work /ultrawork /review have no implementation.
# Install order preference: bun → npm → curl installer (each is documented upstream).
if command -v agy &>/dev/null || command -v antigravity &>/dev/null \
   || [ -f "$_HOME/.gemini/antigravity-cli/settings.json" ] \
   || command -v gemini &>/dev/null; then
  if command -v bun &>/dev/null; then
    bun install --global oh-my-agent 2>&1 | tail -3
  elif command -v npm &>/dev/null; then
    npm install -g oh-my-agent 2>&1 | tail -3
  else
    curl -fsSL https://raw.githubusercontent.com/first-fluke/oh-my-agent/main/cli/install.sh | bash
  fi
  if command -v oma &>/dev/null; then
    echo "✅ Antigravity/Gemini: oh-my-agent (oma) installed — run 'oma link' inside a project"
  else
    echo "⚠️  oma CLI not on PATH — restart shell, then verify with: oma --version"
  fi
fi

# ── OpenCode: oh-my-opencode ─────────────────────────────────────
if command -v opencode &>/dev/null; then
  echo "ℹ️  OpenCode — manual install required:"
  echo "   https://github.com/code-yeongyu/oh-my-opencode/blob/master/docs/guide/installation.md"
  echo "   After installing, run: skills add -g $REPO_URL --yes --copy"
fi

# ── agentation Official Skill (UI annotation) ────────────────────
npx -y skills add benjitaylor/agentation -g
echo "✅ agentation skill installed"
echo "=== Configuring Gajae Code (GJC) skill discovery ==="
_HOME="${_HOME:-${USERPROFILE:-$HOME}}"
SKILLS_ROOT="${SKILLS_ROOT:-$_HOME/.agents/skills}"

if command -v gjc &>/dev/null; then
  GJC_AGENT_DIR="$_HOME/.gjc/agent"
  GJC_CONFIG="$GJC_AGENT_DIR/config.yml"
  mkdir -p "$GJC_AGENT_DIR/skills"

  # Enable skill discovery and point customDirectories at the shared $SKILLS_ROOT.
  # Prefer a YAML-aware idempotent merge (correctly fixes a pre-existing or disabled
  # `skills:` block); fall back to a safe text append when PyYAML is unavailable.
  if command -v python3 &>/dev/null && python3 -c "import yaml" 2>/dev/null; then
    GJC_CONFIG="$GJC_CONFIG" SKILLS_ROOT="$SKILLS_ROOT" python3 - <<'PY'
import os, pathlib, yaml
cfg = pathlib.Path(os.environ["GJC_CONFIG"])
root = os.environ["SKILLS_ROOT"]
raw = cfg.read_text(encoding="utf-8") if cfg.exists() else ""
data = yaml.safe_load(raw) if raw.strip() else {}
if not isinstance(data, dict):
    raise SystemExit(f"refusing to edit non-mapping YAML at {cfg}")
sk = data.get("skills")
if not isinstance(sk, dict):
    sk = {}
    data["skills"] = sk
sk["enabled"] = True
sk.setdefault("enablePiUser", True)
sk.setdefault("enablePiProject", True)
dirs = sk.get("customDirectories")
if not isinstance(dirs, list):
    dirs = []
    sk["customDirectories"] = dirs
if root not in dirs:
    dirs.append(root)
cfg.parent.mkdir(parents=True, exist_ok=True)
cfg.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding="utf-8")
print(f"\u2705 GJC skill discovery enabled (YAML merge) \u2192 {cfg}")
print(f"   customDirectories includes \u2192 {root}")
PY
  elif [ -f "$GJC_CONFIG" ] && grep -q '^skills:' "$GJC_CONFIG"; then
    if grep -qE '^[[:space:]]+enabled:[[:space:]]*true' "$GJC_CONFIG"; then
      echo "ℹ️  skills block already enabled in $GJC_CONFIG — leaving as-is"
    else
      echo "⚠️  $GJC_CONFIG has a 'skills:' block but discovery may be OFF and PyYAML is unavailable."
      echo "    Set 'skills.enabled: true' and add '$SKILLS_ROOT' under 'skills.customDirectories',"
      echo "    or run: pip install pyyaml  &&  re-run Step 3h."
    fi
  else
    touch "$GJC_CONFIG"
    cat >>"$GJC_CONFIG" <<YAML

skills:
  enabled: true
  enablePiUser: true
  enablePiProject: true
  customDirectories:
    - $SKILLS_ROOT
YAML
    echo "✅ GJC skill discovery enabled (appended block) → $GJC_CONFIG"
    echo "   customDirectories → $SKILLS_ROOT"
  fi

  echo "   Skills become reachable in GJC as /skill:<name> (skills.enableSkillCommands is on by default)."
  echo "   Each SKILL.md must carry a frontmatter 'description' (GJC requires it); the oh-my-skills set already does."
  echo "ℹ️  Optional: run 'gjc setup defaults' once in a free shell to add GJC's bundled"
  echo "    workflow skills (deep-interview, ralplan, team, ultragoal) under ~/.gjc/agent/skills/."
  echo "ℹ️  Hook model: GJC native hooks are pre/post TOOL hooks under .gjc/hooks/{pre,post}/"
  echo "    (user scope: ~/.gjc/agent/hooks/{pre,post}/). GJC has no UserPromptSubmit-style"
  echo "    prompt-ingest hook, so the Knowledge Pipeline is applied to GJC via RULES.md in Step 6."
else
  echo "ℹ️  gjc not installed — skipping Gajae Code skill discovery"
fi
_HOME="${_HOME:-${USERPROFILE:-$HOME}}"
SKILLS_ROOT="${SKILLS_ROOT:-$_HOME/.agents/skills}"
REPO_URL="https://github.com/akillness/oh-my-skills"

# Core skill check
echo ""
echo "=== Core Skill Check ==="
for skill in omc ohmg omx ooo stitch-skills compresso pretext god-tibo-imagen zeude plannotator agentation bmad spec-kit spec-stack opik cli-anything survey harness rtk graphify obsidian llm-wiki semble; do
  [ -f "$SKILLS_ROOT/$skill/SKILL.md" ] \
    && echo "✅ $skill" \
    || echo "❌ $skill — re-run: skills add -g $REPO_URL --skill $skill --yes --copy"
done

# Platform dedup check
echo ""
echo "=== Platform Dedup Check ==="
check_no_dup() {
  local skill="$1" agent_dir="$2" agent_name="$3"
  [ -e "$agent_dir/$skill" ] && echo "⚠️  $skill found on $agent_name (should not be there)"
}
check_no_dup "omc"  "$_HOME/.gemini/antigravity/skills"             "antigravity"
check_no_dup "omc"  "$_HOME/.codex/skills"                        "codex"
check_no_dup "omc"  "$_HOME/.config/opencode/skills"              "opencode"
check_no_dup "ohmg" "${CLAUDE_CONFIG_DIR:-$_HOME/.claude}/skills" "claude-code"
check_no_dup "ohmg" "$_HOME/.codex/skills"                        "codex"
echo "✅ Platform dedup verified"

# Preservation check
if [ -f /tmp/skills_before.txt ] && [ -s /tmp/skills_before.txt ]; then
  echo ""
  echo "=== Preservation Check ==="
  ls "$SKILLS_ROOT" 2>/dev/null | sort > /tmp/skills_after.txt
  MISSING=$(comm -23 /tmp/skills_before.txt /tmp/skills_after.txt)
  if [ -z "$MISSING" ]; then
    echo "✅ All pre-existing skills preserved — nothing was removed"
  else
    echo "⚠️  Missing skills (were present before):"
    echo "$MISSING"
    echo "Restore: skills add -g <source> --skill <name> --yes --copy"
  fi
  rm -f /tmp/skills_before.txt /tmp/skills_after.txt
fi

# GJC (Gajae Code) skill-discovery check
if command -v gjc &>/dev/null; then
  echo ""
  echo "=== Gajae Code (GJC) Skill Discovery Check ==="
  GJC_CONFIG="$_HOME/.gjc/agent/config.yml"
  if [ -f "$GJC_CONFIG" ] && grep -q '^skills:' "$GJC_CONFIG" && grep -qE '^[[:space:]]+enabled:[[:space:]]*true' "$GJC_CONFIG"; then
    echo "✅ GJC skill discovery enabled ($GJC_CONFIG)"
    # GJC expands `~` in skills.customDirectories (src: extensibility/skills.ts → expandTilde),
    # so both "~/.agents/skills" and the absolute form are valid. A plain grep for the
    # absolute path false-negatives when the config stores the tilde form.
    GJC_CUSTOM_TILDE="~${SKILLS_ROOT#$_HOME}"
    if grep -qF "$SKILLS_ROOT" "$GJC_CONFIG" || grep -qF "$GJC_CUSTOM_TILDE" "$GJC_CONFIG"; then
      echo "✅ GJC customDirectories references $SKILLS_ROOT (tilde or absolute form)"
      # GJC requires a frontmatter 'description' per skill (requireDescription: true), so a
      # SKILL.md count under the dir is a faithful proxy for "discoverable by GJC".
      GJC_SKILL_COUNT=$(find "$SKILLS_ROOT" -maxdepth 2 -name SKILL.md 2>/dev/null | wc -l | tr -d ' ')
      echo "✅ $GJC_SKILL_COUNT discoverable skills under $SKILLS_ROOT"
    else
      echo "⚠️  GJC customDirectories missing $SKILLS_ROOT — re-run Step 3h"
    fi
    # IMPORTANT: 'gjc skills list' shows ONLY the 4 bundled workflow skills
    # (deep-interview, ralplan, team, ultragoal). oh-my-skills are loaded on demand
    # from customDirectories and surface in-session as /skill:<name> — they will NOT
    # appear in 'gjc skills list'. Seeing only 4 there is expected, not a failure.
    echo "ℹ️  'gjc skills list' lists only bundled workflow skills; oh-my-skills load on"
    echo "    demand and surface as /skill:<name> in-session (not via 'gjc skills list')."
  else
    echo "❌ GJC skill discovery not enabled — re-run Step 3h"
  fi
fi

# Final count
echo ""
TOTAL=$(ls "$SKILLS_ROOT" 2>/dev/null | wc -l | tr -d ' ')
echo "=== Installation Complete: $TOTAL skills installed ==="
STAR_GUARD="$HOME/.omc/state/oh-my-skills-star-prompted"
STAR_REPO="akillness/oh-my-skills"

if [ -f "$STAR_GUARD" ]; then
  echo "(star prompt already shown — skipping)"
else
  mkdir -p "$(dirname "$STAR_GUARD")"

  if ! command -v gh &>/dev/null; then
    echo "gh CLI not found. To star later: brew install gh && gh auth login"
    echo "  gh api --method PUT /user/starred/$STAR_REPO"
    touch "$STAR_GUARD"

  elif ! gh auth status &>/dev/null 2>&1; then
    echo "gh CLI not authenticated. To star later: gh auth login"
    echo "  gh api --method PUT /user/starred/$STAR_REPO"
    touch "$STAR_GUARD"

  else
    if [ -t 0 ]; then
      read -p "Star $STAR_REPO? [Y/n] " -n 1 -r REPLY; echo ""
      if [[ -z "$REPLY" || "$REPLY" =~ ^[Yy]$ ]]; then
        gh api --silent --method PUT "/user/starred/$STAR_REPO" 2>/dev/null \
          && echo "⭐ Starred $STAR_REPO" \
          || echo "Star failed — try: gh api --method PUT /user/starred/$STAR_REPO"
      fi
    else
      echo "Run this to star: gh api --method PUT /user/starred/$STAR_REPO"
    fi
    touch "$STAR_GUARD"
  fi
fi
# Purpose: reduce ambiguity, freeze the contract, execute, and verify before done
# Activation: "ooo", "ouroboros", "ooo ralph", "ooo interview"

# Good defaults:
# - clarify before coding when the request is vague
# - freeze acceptance criteria before larger implementation work
# - keep looping until verification actually passes
# Purpose: maintain durable graph artifacts and relationship visibility
# Activation: "graphify", "GRAPH_REPORT.md", "graph.json", "graph.html"

# Artifact read order:
# 1. graphify-out/GRAPH_REPORT.md
# 2. graphify-out/graph.html
# 3. graphify-out/graph.json
# Purpose: reduce shell-output tokens without losing signal
# Activation: prefix shell commands with rtk

rtk git status
rtk gain
rtk read setup-all-skills-prompt.md
# Purpose: official desktop Obsidian CLI/URI control
# Activation: "obsidian cli", "obsidian terminal", "obsidian://"

# Deterministic targeting:
obsidian vault="My Vault" read path="Inbox/Capture.md"
obsidian vault="My Vault" search query="workflow rules"
# Purpose: accumulate reusable knowledge in markdown, not chat history
# Activation: "llm-wiki", "obsidian wiki", "research vault"

# Core workflow:
# raw/ stays immutable
# wiki/ is the maintained synthesis layer
# index.md and log.md must stay current
# Re-use PLATFORM / _HOME / SKILLS_ROOT from Step 0 if already set
_OS_STEP6="$(uname -s 2>/dev/null || echo Windows)"
case "$_OS_STEP6" in
  Darwin*)               PLATFORM="${PLATFORM:-macos}"   ;;
  Linux*)                PLATFORM="${PLATFORM:-linux}"   ;;
  MINGW*|MSYS*|CYGWIN*)  PLATFORM="${PLATFORM:-windows}" ;;
  *)                     PLATFORM="${PLATFORM:-windows}" ;;
esac
_HOME="${_HOME:-${USERPROFILE:-$HOME}}"
SKILLS_ROOT="${SKILLS_ROOT:-$_HOME/.agents/skills}"
REPO_URL="${REPO_URL:-https://github.com/akillness/oh-my-skills}"

# Verify the default operating-rule skills are installed
for skill in ooo graphify rtk obsidian llm-wiki semble; do
  [ -f "$SKILLS_ROOT/$skill/SKILL.md" ] \
    && echo "✅ $skill" \
    || echo "❌ $skill — run: skills add -g $REPO_URL --skill $skill --yes --copy"
done

# Initialize RTK when available
if command -v rtk &>/dev/null; then
  rtk init -g && echo "✅ rtk initialized"
else
  echo "⚠️  RTK not found — run Step 3a to install"
fi

# Confirm ooo MCP is registered
if command -v claude &>/dev/null; then
  claude mcp list 2>/dev/null | grep -q "^ooo" \
    && echo "✅ ooo MCP registered with Claude Code" \
    || echo "⚠️  ooo MCP not found — run Step 3c to register"
fi

# ── Knowledge Pipeline Enforcement ───────────────────────────────
# Wire every prompt through: prompt → RTK (bash hook, already installed)
# → graphify (structural graph rebuild) → llm-wiki at ~/vaults/llm-wiki/
# (Obsidian-managed vault). Per-agent hook events:
#   Claude Code   : UserPromptSubmit
#   Codex CLI     : UserPromptSubmit (via ~/.codex/config.toml)
#   Antigravity / : BeforeAgent      (Gemini CLI shares ~/.gemini/settings.json)
#   Gemini CLI

KP_VAULT="$_HOME/vaults/llm-wiki"
KP_SCRIPTS="$KP_VAULT/scripts"
KP_INGEST="$KP_SCRIPTS/ingest-prompt.py"
KP_RAW_URL="https://raw.githubusercontent.com/akillness/oh-my-skills/main/hooks/ingest-prompt.py"

# 1. Bootstrap vault skeleton via llm-wiki skill (or minimal fallback)
if [ ! -f "$KP_VAULT/index.md" ]; then
  if [ -x "$SKILLS_ROOT/llm-wiki/scripts/bootstrap-vault.sh" ]; then
    bash "$SKILLS_ROOT/llm-wiki/scripts/bootstrap-vault.sh" "$KP_VAULT" \
      && echo "✅ vault bootstrapped → $KP_VAULT"
  else
    mkdir -p "$KP_VAULT"/raw/sources "$KP_VAULT"/raw/assets \
             "$KP_VAULT"/wiki/sources "$KP_VAULT"/wiki/entities \
             "$KP_VAULT"/wiki/concepts "$KP_VAULT"/wiki/queries "$KP_VAULT"/wiki/reports
    [ -f "$KP_VAULT/index.md" ] || printf '# Index\n\n<!-- SOURCES:END -->\n<!-- QUERIES:END -->\n' > "$KP_VAULT/index.md"
    [ -f "$KP_VAULT/log.md" ]   || printf '# Log\n' > "$KP_VAULT/log.md"
    echo "ℹ️  llm-wiki skill missing — created minimal vault skeleton"
  fi
fi

# 2. Install graphifyy (best-effort; the ingest script degrades gracefully)
if command -v pipx &>/dev/null; then
  pipx list 2>/dev/null | grep -q graphifyy \
    || pipx install graphifyy 2>/dev/null \
    && echo "✅ graphifyy available via pipx"
else
  command -v graphify &>/dev/null \
    || echo "ℹ️  graphifyy not installed — run: pipx install graphifyy"
fi

# 3. Place the shared ingest script under the vault
mkdir -p "$KP_SCRIPTS"
if [ ! -f "$KP_INGEST" ]; then
  if command -v curl &>/dev/null; then
    curl -fsSL "$KP_RAW_URL" -o "$KP_INGEST" 2>/dev/null \
      && chmod +x "$KP_INGEST" \
      && echo "✅ ingest-prompt.py fetched → $KP_INGEST" \
      || echo "⚠️  could not fetch ingest-prompt.py — copy hooks/ingest-prompt.py manually"
  fi
fi

# 4. Per-agent wrapper installer (forwards stdin to the shared script)
install_kp_wrapper() {
  local dest="$1"
  mkdir -p "$(dirname "$dest")"
  cat >"$dest" <<EOF
#!/bin/bash
set -euo pipefail
INGEST="$KP_INGEST"
[ -x "\$INGEST" ] || exit 0
if [ -n "\${1:-}" ]; then INPUT="\$1"; else INPUT="\$(cat 2>/dev/null || true)"; fi
LLM_WIKI_VAULT="$KP_VAULT" printf '%s' "\$INPUT" | python3 "\$INGEST" >/dev/null 2>&1 || true
exit 0
EOF
  chmod +x "$dest"
}

# 5. Register the hook in each agent's settings (idempotent JSON/TOML edit)
if command -v claude &>/dev/null && command -v python3 &>/dev/null; then
  CLAUDE_HOOK="${CLAUDE_CONFIG_DIR:-$_HOME/.claude}/hooks/llm-wiki-ingest.sh"
  install_kp_wrapper "$CLAUDE_HOOK"
  CLAUDE_SETTINGS="${CLAUDE_CONFIG_DIR:-$_HOME/.claude}/settings.json"
  python3 - "$CLAUDE_SETTINGS" "$CLAUDE_HOOK" <<'PY' && echo "✅ Claude: UserPromptSubmit hook registered"
import json, sys, pathlib
p, wrapper = pathlib.Path(sys.argv[1]), sys.argv[2]
data = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
ups = data.setdefault("hooks", {}).setdefault("UserPromptSubmit", [])
cmd = f'bash "{wrapper}"'
if not any(any(h.get("command") == cmd for h in e.get("hooks", [])) for e in ups):
    ups.append({"hooks": [{"type": "command", "command": cmd}]})
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2), encoding="utf-8")
PY
fi

if command -v codex &>/dev/null && command -v python3 &>/dev/null; then
  CODEX_HOOK="$_HOME/.codex/hooks/llm-wiki-ingest.sh"
  install_kp_wrapper "$CODEX_HOOK"
  CODEX_HOOKS_JSON="$_HOME/.codex/hooks.json"
  python3 - "$CODEX_HOOKS_JSON" "$CODEX_HOOK" <<'PY' && echo "✅ Codex: UserPromptSubmit hook registered in hooks.json"
import json, sys, pathlib
p, wrapper = pathlib.Path(sys.argv[1]), sys.argv[2]
data = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
ups = data.setdefault("hooks", {}).setdefault("UserPromptSubmit", [])
if not any(any(h.get("command") == wrapper for h in e.get("hooks", [])) for e in ups):
    ups.append({"hooks": [{"type": "command", "command": wrapper}]})
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
fi

if (command -v gemini &>/dev/null || command -v agy &>/dev/null) && command -v python3 &>/dev/null; then
  GEMINI_HOOK="$_HOME/.gemini/hooks/llm-wiki-ingest.sh"
  install_kp_wrapper "$GEMINI_HOOK"
  GEMINI_SETTINGS="$_HOME/.gemini/settings.json"
  python3 - "$GEMINI_SETTINGS" "$GEMINI_HOOK" <<'PY' && echo "✅ Gemini/Antigravity: BeforeAgent hook registered"
import json, sys, pathlib
p, wrapper = pathlib.Path(sys.argv[1]), sys.argv[2]
data = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
ba = data.setdefault("hooks", {}).setdefault("BeforeAgent", [])
cmd = f'bash "{wrapper}"'
if not any(any(h.get("command") == cmd for h in e.get("hooks", [])) for e in ba):
    ba.append({"matcher": "", "hooks": [{"name": "llm-wiki-ingest", "type": "command", "command": cmd}]})
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2), encoding="utf-8")
PY
fi

# 6. Inject the Knowledge Pipeline rule block into each agent's rules file
KP_RULES="$(cat <<'RULES'

## Knowledge Pipeline (auto-applied)

All prompts in this agent are captured into the canonical vault at
`~/vaults/llm-wiki/` (Obsidian-managed) and indexed by graphify. Before
answering any question, read `~/vaults/llm-wiki/index.md` first, then
the relevant `wiki/` pages. File durable findings back into
`wiki/queries/` or `wiki/reports/`. Shell commands route through `rtk`
for token-compact output.

RULES
)"
inject_kp_rules() {
  local file="$1"
  [ -f "$file" ] || return 0
  grep -q "Knowledge Pipeline (auto-applied)" "$file" && return 0
  printf '%s\n' "$KP_RULES" >>"$file"
  echo "✅ rules injected → $file"
}
inject_kp_rules "${CLAUDE_CONFIG_DIR:-$_HOME/.claude}/CLAUDE.md"
inject_kp_rules "$_HOME/.codex/AGENTS.md"
inject_kp_rules "$_HOME/.gemini/GEMINI.md"

# Gajae Code (GJC): RULES.md is a sticky always-apply rule (user scope: ~/.gjc/agent/RULES.md).
# GJC has no UserPromptSubmit hook, so the Knowledge Pipeline reaches GJC through this rule file.
if command -v gjc &>/dev/null; then
  mkdir -p "$_HOME/.gjc/agent"
  [ -f "$_HOME/.gjc/agent/RULES.md" ] || printf '# RULES\n' > "$_HOME/.gjc/agent/RULES.md"
  inject_kp_rules "$_HOME/.gjc/agent/RULES.md"
fi

echo ""
echo "✅ Default operating rules configured (platform: $PLATFORM)"
echo "   Baseline flow: \$ooo → \$graphify → \$rtk → \$obsidian → \$llm-wiki"
echo "   Vault         : $KP_VAULT"
echo "   Ingest hook   : $KP_INGEST"
