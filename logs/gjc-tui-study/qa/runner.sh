#!/bin/bash
set -eo pipefail

PROJECT_DIR="/Users/jangyoung/.superset/projects/jeo-code"
QA_DIR="$PROJECT_DIR/logs/gjc-tui-study/qa"
mkdir -p "$QA_DIR"

REPORT_FILE="$QA_DIR/report.txt"
echo "=== JOC PARITY TUI QA HARNESS REPORT ===" > "$REPORT_FILE"
echo "Date: $(date)" >> "$REPORT_FILE"
echo "========================================" >> "$REPORT_FILE"

log_report() {
  echo "$1"
  echo "$1" >> "$REPORT_FILE"
}

cleanup() {
  echo "Cleaning up any leftover joc-parity- tmux sessions..."
  for sess in $(tmux list-sessions -F '#S' 2>/dev/null | grep '^joc-parity-'); do
    echo "Killing session $sess"
    tmux kill-session -t "$sess" || true
  done
}
trap cleanup EXIT

# Ensure clean start
cleanup

# ----------------------------------------------------------------------
# CASE 1 & 4: GLYPH + RED TEAM CONTRACT PRESERVATION
# ----------------------------------------------------------------------
log_report "----------------------------------------"
log_report "CASE 1 & 4: GLYPH & CONTRACT PRESERVATION"
log_report "----------------------------------------"

SESS_GLYPH="joc-parity-glyph"
log_report "Creating tmux session $SESS_GLYPH (100x30)"
tmux new-session -d -s "$SESS_GLYPH" -x 100 -y 30
tmux send-keys -t "$SESS_GLYPH" "cd $PROJECT_DIR && bun run logs/gjc-tui-study/qa/driver.ts glyph" C-m

log_report "Waiting for driver to emit events mid-turn (4.0s)..."
sleep 4.0

log_report "Capturing alternate_on status..."
ALT_ON=$(tmux display -p -t "$SESS_GLYPH" '#{alternate_on}')
log_report "alternate_on = $ALT_ON"

log_report "Capturing pane history (-S -100)..."
tmux capture-pane -p -S -100 -t "$SESS_GLYPH" > "$QA_DIR/glyph-history.txt"

log_report "Waiting for driver to finish and exit (3s)..."
sleep 3

passed_glyph=true
passed_contract=true

# Assert lines matching ✔ .*GLYPH-OK and ✘/✗ .*GLYPH-FAIL exist in scrollback
if grep -q -E "✔.*GLYPH-OK" "$QA_DIR/glyph-history.txt"; then
  log_report "  [PASS] GLYPH-OK matches found in scrollback:"
  grep -E "✔.*GLYPH-OK" "$QA_DIR/glyph-history.txt" | while read -r line; do
    log_report "    Evidence: $line"
  done
else
  log_report "  [FAIL] Missing ✔.*GLYPH-OK in scrollback!"
  passed_glyph=false
fi

if grep -q -E "[✗✘].*GLYPH-FAIL" "$QA_DIR/glyph-history.txt"; then
  log_report "  [PASS] GLYPH-FAIL matches found in scrollback:"
  grep -E "[✗✘].*GLYPH-FAIL" "$QA_DIR/glyph-history.txt" | while read -r line; do
    log_report "    Evidence: $line"
  done
else
  log_report "  [FAIL] Missing [✗✘].*GLYPH-FAIL in scrollback!"
  passed_glyph=false
fi

# Assert alternate_on is 0
if [ "$ALT_ON" -eq 0 ]; then
  log_report "  [PASS] alternate_on is 0 (no alt screen used)"
else
  log_report "  [FAIL] alternate_on is $ALT_ON (alt screen was incorrectly used!)"
  passed_contract=false
fi

# Assert NO \x1b[0J in mid-turn output
if [ -f "$QA_DIR/raw-output-midturn.txt" ]; then
  if grep -q -F $'\x1b[0J' "$QA_DIR/raw-output-midturn.txt"; then
    log_report "  [FAIL] \\x1b[0J was printed mid-turn!"
    passed_contract=false
  else
    log_report "  [PASS] No \\x1b[0J printed mid-turn"
  fi
else
  log_report "  [FAIL] raw-output-midturn.txt not found!"
  passed_contract=false
fi

if [ "$passed_glyph" = true ]; then
  log_report "CASE 1 VERDICT: PASS"
else
  log_report "CASE 1 VERDICT: FAIL"
fi

if [ "$passed_contract" = true ]; then
  log_report "CASE 4 VERDICT: PASS"
else
  log_report "CASE 4 VERDICT: FAIL"
fi

tmux kill-session -t "$SESS_GLYPH" || true

# ----------------------------------------------------------------------
# CASE 2: RATE
# ----------------------------------------------------------------------
log_report "----------------------------------------"
log_report "CASE 2: RATE"
log_report "----------------------------------------"

SESS_RATE="joc-parity-rate"
log_report "Creating tmux session $SESS_RATE (100x30)"
tmux new-session -d -s "$SESS_RATE" -x 100 -y 30
tmux send-keys -t "$SESS_RATE" "cd $PROJECT_DIR && bun run logs/gjc-tui-study/qa/driver.ts rate" C-m

log_report "Waiting for rate driver to initialize (2.5s)..."
sleep 2.5

log_report "Temporarily resizing window to 120x30 to avoid truncation..."
tmux resize-window -t "$SESS_RATE" -x 120 -y 30
sleep 0.5

log_report "Capturing visible rate frame..."
tmux capture-pane -p -t "$SESS_RATE" > "$QA_DIR/rate-frame.txt"

log_report "Resizing window back to 100x30..."
tmux resize-window -t "$SESS_RATE" -x 100 -y 30
sleep 0.2

log_report "Waiting for rate driver to exit (2s)..."
sleep 2
tmux kill-session -t "$SESS_RATE" || true

# Adversarial: outputTokens: 0
SESS_RATE_ZERO="joc-parity-rate-zero"
log_report "Creating tmux session $SESS_RATE_ZERO (100x30)"
tmux new-session -d -s "$SESS_RATE_ZERO" -x 100 -y 30
tmux send-keys -t "$SESS_RATE_ZERO" "cd $PROJECT_DIR && bun run logs/gjc-tui-study/qa/driver.ts rate-zero" C-m

log_report "Waiting for rate-zero driver to initialize (2.5s)..."
sleep 2.5

log_report "Temporarily resizing window to 120x30 to avoid truncation..."
tmux resize-window -t "$SESS_RATE_ZERO" -x 120 -y 30
sleep 0.5

log_report "Capturing visible rate-zero frame..."
tmux capture-pane -p -t "$SESS_RATE_ZERO" > "$QA_DIR/rate-zero-frame.txt"

log_report "Resizing window back to 100x30..."
tmux resize-window -t "$SESS_RATE_ZERO" -x 100 -y 30
sleep 0.2

log_report "Waiting for rate-zero driver to exit (2s)..."
sleep 2
tmux kill-session -t "$SESS_RATE_ZERO" || true

passed_rate=true

# Assert ⤴ followed by number and /s in [STEP] row
# The [STEP] row starts with [STEP] or STEP.
# Let's search in rate-frame.txt
if grep -q -E "STEP.*[⤴^].*[0-9]+(\.[0-9]+)?/s" "$QA_DIR/rate-frame.txt"; then
  log_report "  [PASS] Found rate display in [STEP] row:"
  grep -E "STEP.*[⤴^].*[0-9]+(\.[0-9]+)?/s" "$QA_DIR/rate-frame.txt" | while read -r line; do
    log_report "    Evidence: $line"
  done
else
  log_report "  [FAIL] Live rate display not found in [STEP] row of rate-frame.txt!"
  passed_rate=false
fi

# Assert adversarial does NOT show /s in [STEP] row
if grep -q -E "STEP.*/s" "$QA_DIR/rate-zero-frame.txt"; then
  log_report "  [FAIL] Found /s in [STEP] row of rate-zero-frame.txt!"
  grep -E "STEP.*/s" "$QA_DIR/rate-zero-frame.txt" | while read -r line; do
    log_report "    Evidence: $line"
  done
  passed_rate=false
else
  log_report "  [PASS] No rate display shown when outputTokens is 0"
fi

if [ "$passed_rate" = true ]; then
  log_report "CASE 2 VERDICT: PASS"
else
  log_report "CASE 2 VERDICT: FAIL"
fi

# ----------------------------------------------------------------------
# CASE 3: RESUME HINT
# ----------------------------------------------------------------------
log_report "----------------------------------------"
log_report "CASE 3: RESUME HINT"
log_report "----------------------------------------"

SESS_RESUME="joc-parity-resume"
log_report "Creating tmux session $SESS_RESUME (100x30)"
tmux new-session -d -s "$SESS_RESUME" -x 100 -y 30
tmux send-keys -t "$SESS_RESUME" "cd $PROJECT_DIR && bun src/cli.ts launch --no-tui" C-m

log_report "Waiting for REPL prompt (12s)..."
sleep 12

log_report "Sending /exit to REPL..."
tmux send-keys -t "$SESS_RESUME" "/exit" C-m
sleep 2

log_report "Capturing resume scrollback..."
tmux capture-pane -p -S -100 -t "$SESS_RESUME" > "$QA_DIR/resume-exit.txt"
tmux kill-session -t "$SESS_RESUME" || true

# Rerun with --no-session
SESS_NOSESS="joc-parity-nosession"
log_report "Creating tmux session $SESS_NOSESS (100x30)"
tmux new-session -d -s "$SESS_NOSESS" -x 100 -y 30
tmux send-keys -t "$SESS_NOSESS" "cd $PROJECT_DIR && bun src/cli.ts launch --no-tui --no-session" C-m

log_report "Waiting for REPL prompt (12s)..."
sleep 12

log_report "Sending /exit to REPL..."
tmux send-keys -t "$SESS_NOSESS" "/exit" C-m
sleep 2

log_report "Capturing no-session resume scrollback..."
tmux capture-pane -p -S -100 -t "$SESS_NOSESS" > "$QA_DIR/resume-nosession.txt"
tmux kill-session -t "$SESS_NOSESS" || true

passed_resume=true

# Assert Resume with: joc launch --resume <uuid>
if grep -q -E "Resume with: joc launch --resume [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" "$QA_DIR/resume-exit.txt"; then
  log_report "  [PASS] Found resume hint in scrollback:"
  grep -E "Resume with: joc launch --resume" "$QA_DIR/resume-exit.txt" | while read -r line; do
    log_report "    Evidence: $line"
  done
else
  log_report "  [FAIL] Resume hint not found or invalid format in resume-exit.txt!"
  passed_resume=false
fi

# Assert no hint is printed with --no-session
if grep -q "Resume with:" "$QA_DIR/resume-nosession.txt"; then
  log_report "  [FAIL] Found resume hint in resume-nosession.txt even though --no-session was used!"
  grep "Resume with:" "$QA_DIR/resume-nosession.txt" | while read -r line; do
    log_report "    Evidence: $line"
  done
  passed_resume=false
else
  log_report "  [PASS] No resume hint printed under --no-session flag"
fi

if [ "$passed_resume" = true ]; then
  log_report "CASE 3 VERDICT: PASS"
else
  log_report "CASE 3 VERDICT: FAIL"
fi

log_report "========================================"
log_report "FINAL VERDICTS:"
log_report "  CASE 1 (GLYPH): $([ "$passed_glyph" = true ] && echo "PASS" || echo "FAIL")"
log_report "  CASE 2 (RATE): $([ "$passed_rate" = true ] && echo "PASS" || echo "FAIL")"
log_report "  CASE 3 (RESUME HINT): $([ "$passed_resume" = true ] && echo "PASS" || echo "FAIL")"
log_report "  CASE 4 (CONTRACT PRESERVATION): $([ "$passed_contract" = true ] && echo "PASS" || echo "FAIL")"
log_report "========================================"
