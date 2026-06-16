#!/usr/bin/env bash
# jeo --tmux live-verification harness.
#
# Codifies the launch -> send-keys -> capture -> cleanup loop used to verify jeo's
# interactive TUI behaviour, so stability + behaviour checks are a repeatable command
# instead of hand-rolled one-off bash. macOS-safe: no GNU `timeout` (bash watchdog
# polling instead). Boots jeo in a DETACHED tmux session inside a throwaway cwd so it
# never edits the real repo, and only ever kills the session it created (never a
# user-owned `jeo-main-*` session).
#
# Usage:
#   scripts/tmux-verify.sh smoke
#       Boot the TUI and assert it renders cleanly (input box + model bar, no crash).
#       Exit 0 on a healthy boot, 1 otherwise. The stability gate.
#
#   scripts/tmux-verify.sh check "<input line>" "<extended-regex>" [--ansi] [--wait N]
#       Boot, type <input line> + Enter, wait, and assert the pane matches <regex>.
#       --ansi captures SGR/escape codes (for color assertions); --wait overrides the
#       settle seconds (default 2). The behaviour-verification primitive.
#
#   scripts/tmux-verify.sh capture [--ansi] [--wait N]
#       Boot, wait, and print the settled frame (debugging).
#
# Env:
#   JEO_VERIFY_BOOT_TIMEOUT   seconds to wait for the session to appear (default 12)
#   JEO_CLI                   override the cli entry (default: bun <repo>/src/cli.ts)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BOOT_TIMEOUT="${JEO_VERIFY_BOOT_TIMEOUT:-12}"

die() { echo "tmux-verify: $*" >&2; exit 2; }
command -v tmux >/dev/null 2>&1 || die "tmux not found on PATH"

# Globals populated by launch_session / cleared by cleanup_session.
SESSION=""
LAUNCH_PID=""
WORK=""
LOG=""

# Boot jeo --tmux detached; discover the session name it prints; wait until tmux
# actually has it. Extra args are passed through to the cli (e.g. a model flag).
launch_session() {
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/jeo-verify.XXXXXX")"
  LOG="$(mktemp "${TMPDIR:-/tmp}/jeo-verify-log.XXXXXX")"
  local cli="${JEO_CLI:-bun "$ROOT/src/cli.ts"}"
  # Detach from ambient tmux/launch markers so jeo spawns its OWN session. NOTE: jeo
  # attaches to the already-running tmux SERVER, which does NOT inherit this launcher's
  # env, so config CANNOT be isolated via JEO_CONFIG_DIR here — the harness drives the
  # user's REAL ~/.jeo. Therefore every probe MUST be non-mutating (no /model thinking,
  # /agents writes, /provider login, etc.). The cwd is still a throwaway dir (no repo edits).
  ( cd "$WORK" && env -u TMUX -u JEO_TMUX_LAUNCHED $cli --tmux "$@" </dev/null >"$LOG" 2>&1 ) &
  LAUNCH_PID=$!
  local waited=0
  while [ "$waited" -lt "$((BOOT_TIMEOUT * 2))" ]; do
    sleep 0.5
    waited=$((waited + 1))
    SESSION="$(grep -oE 'jeo-[A-Za-z0-9._-]+' "$LOG" 2>/dev/null | head -1)"
    if [ -n "$SESSION" ] && tmux has-session -t "=$SESSION" 2>/dev/null; then
      # The launcher process has handed the pane to tmux; reap it so it can't linger.
      kill "$LAUNCH_PID" 2>/dev/null || true
      wait "$LAUNCH_PID" 2>/dev/null || true
      LAUNCH_PID=""
      return 0
    fi
  done
  echo "tmux-verify: session did not start within ${BOOT_TIMEOUT}s. Launcher log:" >&2
  sed 's/^/  /' "$LOG" >&2
  return 1
}

# Kill ONLY the session we created — never a user-owned jeo-main-* session.
cleanup_session() {
  if [ -n "$SESSION" ]; then
    case "$SESSION" in
      jeo-main-*) : ;;  # safety: never touch a user's primary session
      jeo-*) tmux kill-session -t "=$SESSION" 2>/dev/null || true ;;
    esac
  fi
  [ -n "$LAUNCH_PID" ] && { kill "$LAUNCH_PID" 2>/dev/null || true; }
  [ -n "$WORK" ] && rm -rf "$WORK"
  [ -n "$LOG" ] && rm -f "$LOG"
  SESSION=""; LAUNCH_PID=""; WORK=""; LOG=""
}
trap cleanup_session EXIT INT TERM

send_line() { tmux send-keys -t "$SESSION" "$1"; sleep 0.3; tmux send-keys -t "$SESSION" Enter; }
# Capture the visible pane PLUS scrollback history (-S -300) so assertions still match
# output that scrolled above the fold (e.g. the long `/help` menu); -e keeps SGR/escapes.
capture()   { if [ "${1:-}" = "--ansi" ]; then tmux capture-pane -t "$SESSION" -e -p -S -300 2>/dev/null; else tmux capture-pane -t "$SESSION" -p -S -300 2>/dev/null; fi; }

cmd_smoke() {
  launch_session || return 1
  sleep 2
  local frame; frame="$(capture)"
  local ok=1
  echo "$frame" | grep -qiE 'Type your (message|next message)' || { echo "smoke: input box not rendered" >&2; ok=0; }
  echo "$frame" | grep -qE '⬢|claude|gpt|gemini|ollama|antigravity' || { echo "smoke: model bar not rendered" >&2; ok=0; }
  if grep -qiE 'error|throw|undefined is not|cannot read|stack trace' "$LOG"; then echo "smoke: launcher log shows an error" >&2; ok=0; fi
  if [ "$ok" = 1 ]; then echo "smoke: OK — jeo --tmux booted and rendered cleanly (session $SESSION)"; return 0; fi
  echo "=== settled frame ===" >&2; echo "$frame" | sed 's/^/  /' >&2
  return 1
}

cmd_check() {
  local input="${1:-}" regex="${2:-}"; shift 2 || true
  [ -n "$input" ] && [ -n "$regex" ] || die "check needs: \"<input>\" \"<regex>\" [--ansi] [--wait N]"
  local ansi="" wait=2
  while [ $# -gt 0 ]; do case "$1" in --ansi) ansi="--ansi";; --wait) wait="${2:-2}"; shift;; esac; shift; done
  launch_session || return 1
  send_line "$input"
  sleep "$wait"
  local frame; frame="$(capture $ansi)"
  if echo "$frame" | grep -qE "$regex"; then
    echo "check: OK — input '$input' produced output matching /$regex/"
    return 0
  fi
  echo "check: FAIL — /$regex/ not found after '$input'" >&2
  echo "=== settled frame ===" >&2; echo "$frame" | sed 's/^/  /' >&2
  return 1
}

cmd_capture() {
  local ansi="" wait=2
  while [ $# -gt 0 ]; do case "$1" in --ansi) ansi="--ansi";; --wait) wait="${2:-2}"; shift;; esac; shift; done
  launch_session || return 1
  sleep "$wait"
  capture $ansi
}

# One battery probe in an ISOLATED session: boot, optionally type INPUT+Enter, then
# assert the pane matches REGEX (empty REGEX = boot-only) AND that the input box
# survived (no mid-flow crash). Prints ✓/✗ and returns 0/1.
_probe() {
  local label="$1" input="$2" regex="${3:-}" wait="${4:-2}"
  if ! launch_session; then echo "  ✗ ${label}  (boot failed)"; cleanup_session; return 1; fi
  [ -n "$input" ] && send_line "$input"
  sleep "$wait"
  local frame rc=0; frame="$(capture)"
  [ -n "$regex" ] && { echo "$frame" | grep -qE "$regex" || rc=1; }
  echo "$frame" | grep -qiE 'Type your (message|next message)' || rc=1
  cleanup_session
  if [ "$rc" = 0 ]; then echo "  ✓ ${label}"; else echo "  ✗ ${label}  (/${regex}/)"; fi
  return $rc
}

# Curated stability + behavior suite. Each probe boots its OWN isolated session, so a
# crash in one can't poison the next. All checks are client-side (no model call needed).
cmd_battery() {
  echo "jeo --tmux verification battery"
  local pass=0 fail=0
  _bp() { if _probe "$@"; then pass=$((pass+1)); else fail=$((fail+1)); fi; }
  _bp "boot: input box + model bar render" ""                       '⬢|claude|gpt|gemini|ollama|antigravity'
  _bp "/help renders command groups"       "/help"                  'Subagents:|Code tools:'
  _bp "unknown \$skill → clear feedback"   '$nope build'            'No skill'
  _bp "/agents lists subagent roster"      "/agents"                'executor|planner|architect|critic'
  _bp "\$ultragoal dispatches the workflow" '$ultragoal hi'          'workflow:ultragoal|Skill: ultragoal'
  _bp "unresolved /command is reported"    "/zzznope"               "Unknown command|No skill"
  echo ""
  if [ "$fail" = 0 ]; then echo "battery: ALL ${pass} PASSED"; return 0; fi
  echo "battery: ${pass} passed, ${fail} FAILED"; return 1
}
case "${1:-}" in
  smoke)   shift; cmd_smoke "$@" ;;
  battery) shift; cmd_battery "$@" ;;
  check)   shift; cmd_check "$@" ;;
  capture) shift; cmd_capture "$@" ;;
  ""|-h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown subcommand '$1' (smoke|battery|check|capture)" ;;
esac
