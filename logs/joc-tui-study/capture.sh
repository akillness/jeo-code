#!/bin/bash
# JOC TUI Capture Script
# Created for Joc TUI study.

SESSION="joc-study-capture-$$"
LOG_DIR="/Users/jangyoung/.superset/projects/jeo-code/logs/joc-tui-study"

mkdir -p "$LOG_DIR"

echo "1. Creating tmux session..."
tmux new-session -d -s "$SESSION" -x 120 -y 35 -c /Users/jangyoung/.superset/projects/jeo-code

echo "2. Launching joc..."
# JOC_TUI_ALT_SCREEN=1 is NOT set by default to allow inline main-buffer scrollback,
# but we can set any env variables needed.
tmux send-keys -t "$SESSION" "bun src/cli.ts launch" Enter
sleep 8

echo "3. Capturing startup screens..."
tmux capture-pane -t "$SESSION" -p > "$LOG_DIR/01-startup.txt"
tmux capture-pane -t "$SESSION" -p -e > "$LOG_DIR/01-startup-ansi.txt"

echo "4. Driving turn..."
tmux send-keys -t "$SESSION" "read package.json and tell me the name and version" Enter

# Sleep a little to capture live execution frames
sleep 5
echo "Capturing live mid-turn..."
tmux capture-pane -t "$SESSION" -p > "$LOG_DIR/02-live.txt"
tmux capture-pane -t "$SESSION" -p -e > "$LOG_DIR/02-live-ansi.txt"
tmux display -p -t "$SESSION" '#{alternate_on}' > "$LOG_DIR/alternate_on.txt"

# Loop to wait for completion (no longer working spinner or active tool)
# Let's capture live turns along the way too, just in case
for i in {1..20}; do
  sleep 3
  tmux capture-pane -t "$SESSION" -p > "$LOG_DIR/02-live-tmp-$i.txt"
  # Check if we are back at the prompt or done. Typically we'll see the input box prompt "joc>" or similar.
  # Let's inspect the layout once it starts, but a safe check is to sleep and let it complete.
  # If the model call fails, it will exit or show error, but we want to make sure it finishes.
done

echo "5. Capturing history..."
tmux capture-pane -p -S -400 -t "$SESSION" > "$LOG_DIR/03-history.txt"

echo "6. Capturing final screens of the turn..."
tmux capture-pane -t "$SESSION" -p > "$LOG_DIR/04-final.txt"
tmux capture-pane -t "$SESSION" -p -e > "$LOG_DIR/04-final-ansi.txt"

echo "7. Exiting..."
tmux send-keys -t "$SESSION" "/exit" Enter
sleep 3
tmux capture-pane -t "$SESSION" -p > "$LOG_DIR/05-exit.txt"

echo "8. Killing session..."
tmux kill-session -t "$SESSION"

echo "Done!"
