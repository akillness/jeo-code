#!/bin/bash
# GJC TUI Capture Script used for GJC TUI study.
# Created for Gajae Code study.

SESSION="gjc-study-capture"
LOG_DIR="/Users/jangyoung/.superset/projects/jeo-code/logs/gjc-tui-study"

mkdir -p "$LOG_DIR"

echo "1. Creating tmux session..."
tmux new-session -d -s "$SESSION" -x 120 -y 35 -c /Users/jangyoung/.superset/projects/jeo-code

echo "2. Launching gjc..."
tmux send-keys -t "$SESSION" "gjc" Enter
sleep 8

echo "3. Capturing startup screens..."
tmux capture-pane -t "$SESSION" -p > "$LOG_DIR/01-startup.txt"
tmux capture-pane -t "$SESSION" -p -e > "$LOG_DIR/01-startup-ansi.txt"

echo "4. Driving first turn..."
tmux send-keys -t "$SESSION" "read package.json and tell me the name and version" Enter
for i in {1..20}; do
  sleep 3
  tmux capture-pane -t "$SESSION" -p > "$LOG_DIR/02-live-$i.txt"
  if ! grep -q "esc" "$LOG_DIR/02-live-$i.txt"; then
    echo "Completed at iteration $i"
    break
  fi
done

echo "5. Capturing history and alternate_on..."
tmux capture-pane -p -S -400 -t "$SESSION" > "$LOG_DIR/03-history.txt"
tmux display -p -t "$SESSION" '#{alternate_on}' > "$LOG_DIR/alternate_on.txt"

echo "6. Capturing final screens of first turn..."
tmux capture-pane -t "$SESSION" -p > "$LOG_DIR/04-final.txt"
tmux capture-pane -t "$SESSION" -p -e > "$LOG_DIR/04-final-ansi.txt"

echo "7. Driving second turn..."
tmux send-keys -t "$SESSION" "list the files in src/tui and then run: echo hello" Enter
for i in {1..30}; do
  sleep 3
  tmux capture-pane -t "$SESSION" -p > "$LOG_DIR/05-live-$i.txt"
  if ! grep -q "esc" "$LOG_DIR/05-live-$i.txt"; then
    echo "Completed second turn at iteration $i"
    break
  fi
done

echo "8. Capturing final screen of second turn..."
tmux capture-pane -t "$SESSION" -p > "$LOG_DIR/06-final.txt"

echo "9. Exiting..."
tmux send-keys -t "$SESSION" "/exit" Enter
sleep 3
tmux capture-pane -t "$SESSION" -p > "$LOG_DIR/07-exit.txt"

echo "10. Killing session..."
tmux kill-session -t "$SESSION"

echo "Done!"
