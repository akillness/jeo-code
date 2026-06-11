#!/bin/bash
set -eo pipefail

# Define variables
PROJECT_DIR="/Users/jangyoung/.superset/projects/jeo-code"
OUT_DIR="$PROJECT_DIR/logs/qa-inline-scrollback"
mkdir -p "$OUT_DIR"

echo "=== STARTING TUI INLINE SCROLLBACK QA HARNESS ==="

# Initialize report file
REPORT_FILE="$OUT_DIR/report.txt"
cat <<EOF > "$REPORT_FILE"
=====================================================
TUI INLINE SCROLLBACK QA HARNESS REPORT
Date: $(date)
=====================================================
EOF

# Helper function to write to report
log_report() {
  echo "$1"
  echo "$1" >> "$REPORT_FILE"
}

# Helper to verify clean tmux shutdown on exit
cleanup() {
  echo "Cleaning up any leftover tmux sessions..."
  for sess in $(tmux list-sessions -F '#S' 2>/dev/null | grep '^joc-qa-'); do
    echo "Killing session $sess"
    tmux kill-session -t "$sess" || true
  done
}
trap cleanup EXIT

# ----------------------------------------------------------------------
# CASE 1: HAPPY PATH — mid-turn scrollback
# ----------------------------------------------------------------------
log_report "-----------------------------------------------------"
log_report "CASE 1: HAPPY PATH — mid-turn scrollback"
log_report "-----------------------------------------------------"

SESS="joc-qa-happy-$$"
log_report "Creating tmux session $SESS (100x30)"
tmux new-session -d -s "$SESS" -x 100 -y 30
tmux send-keys -t "$SESS" "cd $PROJECT_DIR && bun run logs/qa-inline-scrollback/driver.ts happy-path" C-m

log_report "Waiting for driver to emit events (4.5s)..."
sleep 4.5

log_report "Capturing pane history (-S -200)..."
tmux capture-pane -p -S -200 -t "$SESS" > "$OUT_DIR/happy-history.txt"

# Assert early markers exist
passed_happy=true
for i in {1..10}; do
  marker=$(printf "LEDGER-%03d" $i)
  if grep -q "$marker" "$OUT_DIR/happy-history.txt"; then
    log_report "  [PASS] Found $marker in history"
  else
    log_report "  [FAIL] Missing $marker in history!"
    passed_happy=false
  fi
done

if [ "$passed_happy" = true ]; then
  log_report "CASE 1 VERDICT: PASSED"
else
  log_report "CASE 1 VERDICT: FAILED"
fi

tmux kill-session -t "$SESS"

# ----------------------------------------------------------------------
# CASE 2: COPY-MODE WHEEL
# ----------------------------------------------------------------------
log_report "-----------------------------------------------------"
log_report "CASE 2: COPY-MODE WHEEL"
log_report "-----------------------------------------------------"

SESS="joc-qa-copymode-$$"
log_report "Creating tmux session $SESS (100x30)"
tmux new-session -d -s "$SESS" -x 100 -y 30
tmux send-keys -t "$SESS" "cd $PROJECT_DIR && bun run logs/qa-inline-scrollback/driver.ts copy-mode" C-m

log_report "Waiting for driver to emit events (4.5s)..."
sleep 4.5

log_report "Entering copy-mode..."
tmux copy-mode -t "$SESS"

# With the ED-flood fixed, history is COMPACT (1 line per ledger flush), so a fixed
# 15-tick wheel no longer reaches the oldest lines. Jump to history-top — the
# deterministic upper bound of what a mouse wheel can reach — then capture the
# region the user actually SEES at that scroll offset. `capture-pane -p` without
# -S/-E captures the LIVE screen, not the copy-mode view; the view at
# scroll_position P covers history rows [-P, -P + height - 1].
log_report "Jumping to history top (wheel upper bound)..."
tmux send-keys -X -t "$SESS" history-top

SCROLL_POS=$(tmux display -p -t "$SESS" '#{scroll_position}')
PANE_H=$(tmux display -p -t "$SESS" '#{pane_height}')
log_report "Capturing copy-mode view (scroll_position=$SCROLL_POS, height=$PANE_H)..."
tmux capture-pane -p -S "-$SCROLL_POS" -E "$(( PANE_H - 1 - SCROLL_POS ))" -t "$SESS" > "$OUT_DIR/copymode-screen.txt"

log_report "Cancelling copy-mode..."
tmux send-keys -X -t "$SESS" cancel

log_report "Waiting for repaint (0.5s)..."
sleep 0.5

log_report "Capturing pane again after cancel..."
tmux capture-pane -p -t "$SESS" > "$OUT_DIR/copymode-screen-resumed.txt"

# Assert earlier markers are visible on screen in copy-mode
passed_copymode=true
for i in {1..10}; do
  marker=$(printf "LEDGER-%03d" $i)
  if grep -q "$marker" "$OUT_DIR/copymode-screen.txt"; then
    log_report "  [PASS] Found $marker on screen during copy-mode"
  else
    log_report "  [FAIL] Missing $marker on screen during copy-mode!"
    passed_copymode=false
  fi
done

# Verify after cancel the live frame resumed rendering (footer/spinner present)
# The footer contains "qa" (the model name)
if grep -q "qa" "$OUT_DIR/copymode-screen-resumed.txt"; then
  log_report "  [PASS] Found footer ('qa') after cancel"
else
  log_report "  [FAIL] Missing footer ('qa') after cancel!"
  passed_copymode=false
fi

if [ "$passed_copymode" = true ]; then
  log_report "CASE 2 VERDICT: PASSED"
else
  log_report "CASE 2 VERDICT: FAILED"
fi

tmux kill-session -t "$SESS"

# ----------------------------------------------------------------------
# CASE 3: NO ALT SCREEN
# ----------------------------------------------------------------------
log_report "-----------------------------------------------------"
log_report "CASE 3: NO ALT SCREEN"
log_report "-----------------------------------------------------"

passed_alt=true

# Sub-case 3a: NORMAL env (should be 0)
SESS="joc-qa-alt0-$$"
log_report "Creating tmux session $SESS (100x30) for normal env"
tmux new-session -d -s "$SESS" -x 100 -y 30
tmux send-keys -t "$SESS" "cd $PROJECT_DIR && bun run logs/qa-inline-scrollback/driver.ts no-alt-screen" C-m

log_report "Waiting for driver to start (2s)..."
sleep 2

ALT_ON=$(tmux display -p -t "$SESS" '#{alternate_on}')
log_report "alternate_on value under normal env: $ALT_ON"
if [ "$ALT_ON" -eq 0 ]; then
  log_report "  [PASS] alternate_on is 0 (no alt screen used)"
else
  log_report "  [FAIL] alternate_on is $ALT_ON (alt screen was incorrectly used!)"
  passed_alt=false
fi
tmux kill-session -t "$SESS"

# Sub-case 3b: JOC_TUI_ALT_SCREEN=1 env (should be 1)
SESS="joc-qa-alt1-$$"
log_report "Creating tmux session $SESS (100x30) for JOC_TUI_ALT_SCREEN=1"
tmux new-session -d -s "$SESS" -x 100 -y 30
tmux send-keys -t "$SESS" "cd $PROJECT_DIR && env JOC_TUI_ALT_SCREEN=1 bun run logs/qa-inline-scrollback/driver.ts no-alt-screen" C-m

log_report "Waiting for driver to start (2s)..."
sleep 2

ALT_ON_ALT=$(tmux display -p -t "$SESS" '#{alternate_on}')
log_report "alternate_on value under JOC_TUI_ALT_SCREEN=1: $ALT_ON_ALT"
if [ "$ALT_ON_ALT" -eq 1 ]; then
  log_report "  [PASS] alternate_on is 1 (alt screen legacy fallback intact)"
else
  log_report "  [FAIL] alternate_on is $ALT_ON_ALT (alt screen was NOT used under JOC_TUI_ALT_SCREEN=1!)"
  passed_alt=false
fi
tmux kill-session -t "$SESS"

if [ "$passed_alt" = true ]; then
  log_report "CASE 3 VERDICT: PASSED"
else
  log_report "CASE 3 VERDICT: FAILED"
fi

# ----------------------------------------------------------------------
# CASE 4: RED TEAM — resize mid-turn
# ----------------------------------------------------------------------
log_report "-----------------------------------------------------"
log_report "CASE 4: RED TEAM — resize mid-turn"
log_report "-----------------------------------------------------"

SESS="joc-qa-resize-$$"
log_report "Creating tmux session $SESS (100x30)"
tmux new-session -d -s "$SESS" -x 100 -y 30
tmux send-keys -t "$SESS" "cd $PROJECT_DIR && bun run logs/qa-inline-scrollback/driver.ts resize" C-m

log_report "Waiting for driver to start (2s)..."
sleep 2

log_report "Resizing window to 80x20..."
tmux resize-window -t "$SESS" -x 80 -y 20
sleep 1

log_report "Resizing window back to 100x30..."
tmux resize-window -t "$SESS" -x 100 -y 30
sleep 1

log_report "Capturing visible screen..."
tmux capture-pane -p -t "$SESS" > "$OUT_DIR/resize-screen.txt"

# Count occurrences of the live footer line.
# The footer contains "qa".
qa_count=$(grep -c "qa" "$OUT_DIR/resize-screen.txt" || true)
log_report "Found 'qa' in visible screen $qa_count times"

passed_resize=true
# Checking if process crashed (pane should still exist)
if tmux list-panes -t "$SESS" >/dev/null 2>&1; then
  log_report "  [PASS] Process did not crash"
else
  log_report "  [FAIL] Process crashed!"
  passed_resize=false
fi

# The footer should appear exactly once during live drawing
if [ "$qa_count" -eq 1 ]; then
  log_report "  [PASS] Exactly one footer line present (no stacked duplicate footers)"
else
  log_report "  [FAIL] Expected exactly 1 footer line, found $qa_count! Possible stacked duplicates."
  passed_resize=false
fi

if [ "$passed_resize" = true ]; then
  log_report "CASE 4 VERDICT: PASSED"
else
  log_report "CASE 4 VERDICT: FAILED"
fi

tmux kill-session -t "$SESS"

# ----------------------------------------------------------------------
# CASE 5: RED TEAM — burst flushes
# ----------------------------------------------------------------------
log_report "-----------------------------------------------------"
log_report "CASE 5: RED TEAM — burst flushes"
log_report "-----------------------------------------------------"

SESS="joc-qa-burst-$$"
log_report "Creating tmux session $SESS (100x30)"
tmux new-session -d -s "$SESS" -x 100 -y 30
tmux send-keys -t "$SESS" "cd $PROJECT_DIR && bun run logs/qa-inline-scrollback/driver.ts burst" C-m

log_report "Waiting for burst flushes to complete (2.5s)..."
sleep 2.5

log_report "Capturing pane history (-S -300)..."
tmux capture-pane -p -S -300 -t "$SESS" > "$OUT_DIR/burst-history.txt"

log_report "Capturing visible screen..."
tmux capture-pane -p -t "$SESS" > "$OUT_DIR/burst-screen.txt"

passed_burst=true

# Assert history contains first and last markers
if grep -q "LEDGER-001" "$OUT_DIR/burst-history.txt"; then
  log_report "  [PASS] Found first marker (LEDGER-001) in history"
else
  log_report "  [FAIL] Missing first marker (LEDGER-001) in history!"
  passed_burst=false
fi

if grep -q "LEDGER-200" "$OUT_DIR/burst-history.txt"; then
  log_report "  [PASS] Found last marker (LEDGER-200) in history"
else
  log_report "  [FAIL] Missing last marker (LEDGER-200) in history!"
  passed_burst=false
fi

# Assert visible screen still shows exactly one live frame (no torn duplicate footer rows)
qa_count_burst=$(grep -c "qa" "$OUT_DIR/burst-screen.txt" || true)
log_report "Found 'qa' in visible screen $qa_count_burst times"
if [ "$qa_count_burst" -eq 1 ]; then
  log_report "  [PASS] Exactly one footer line present (no torn duplicate footers)"
else
  log_report "  [FAIL] Expected exactly 1 footer line, found $qa_count_burst! Possible torn footer."
  passed_burst=false
fi

if [ "$passed_burst" = true ]; then
  log_report "CASE 5 VERDICT: PASSED"
else
  log_report "CASE 5 VERDICT: FAILED"
fi

tmux kill-session -t "$SESS"

# ----------------------------------------------------------------------
# CASE 6: RED TEAM — finish dedupe
# ----------------------------------------------------------------------
log_report "-----------------------------------------------------"
log_report "CASE 6: RED TEAM — finish dedupe"
log_report "-----------------------------------------------------"

SESS="joc-qa-dedupe-$$"
log_report "Creating tmux session $SESS (100x30)"
tmux new-session -d -s "$SESS" -x 100 -y 30
tmux send-keys -t "$SESS" "cd $PROJECT_DIR && bun run logs/qa-inline-scrollback/driver.ts dedupe" C-m

log_report "Waiting for driver to finish and exit (3s)..."
sleep 3

log_report "Capturing full history..."
tmux capture-pane -p -S -200 -t "$SESS" > "$OUT_DIR/dedupe-history.txt"

# Count occurrences of a unique marker (e.g. LEDGER-001)
marker_count=$(sed 's/\x1b\[[0-9;]*m//g' "$OUT_DIR/dedupe-history.txt" | grep -c -E '^\[TOOL\] \[DONE\] LEDGER-001$' || true)
log_report "Found static ledger line '[TOOL] [DONE] LEDGER-001' $marker_count times in history"

passed_dedupe=true
if [ "$marker_count" -eq 1 ]; then
  log_report "  [PASS] Marker LEDGER-001 appeared exactly once in scrollback (no duplicates)"
else
  log_report "  [FAIL] Expected exactly 1 occurrence of LEDGER-001, found $marker_count!"
  passed_dedupe=false
fi

if [ "$passed_dedupe" = true ]; then
  log_report "CASE 6 VERDICT: PASSED"
else
  log_report "CASE 6 VERDICT: FAILED"
fi

tmux kill-session -t "$SESS"

# ----------------------------------------------------------------------
# FINAL SUMMARY
# ----------------------------------------------------------------------
log_report "====================================================="
log_report "FINAL RESULTS:"
log_report "  CASE 1 (HAPPY PATH): $([ "$passed_happy" = true ] && echo "PASSED" || echo "FAILED")"
log_report "  CASE 2 (COPY-MODE WHEEL): $([ "$passed_copymode" = true ] && echo "PASSED" || echo "FAILED")"
log_report "  CASE 3 (NO ALT SCREEN): $([ "$passed_alt" = true ] && echo "PASSED" || echo "FAILED")"
log_report "  CASE 4 (RED TEAM RESIZE): $([ "$passed_resize" = true ] && echo "PASSED" || echo "FAILED")"
log_report "  CASE 5 (RED TEAM BURST): $([ "$passed_burst" = true ] && echo "PASSED" || echo "FAILED")"
log_report "  CASE 6 (RED TEAM DEDUPE): $([ "$passed_dedupe" = true ] && echo "PASSED" || echo "FAILED")"
log_report "====================================================="

echo "=== QA RUN COMPLETE ==="
