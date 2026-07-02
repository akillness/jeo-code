// Pure presenters for read-only REPL slash commands. These build the exact
// line arrays the inline handlers used to `console.log` directly, extracted so
// they can be unit-tested without driving the whole launch REPL. They hold NO
// mutable session state — every input is passed in explicitly.
import type { Message } from "../../agent/loop";
import { formatTranscript } from "../../tui/components/transcript";


/** Static keyboard-shortcut reference for `/hotkeys` (no inputs, no state). */
export function hotkeysLines(): string[] {
  return [
    "Keyboard shortcuts:",
    "  Tab        complete slash commands, models, roles, @paths",
    "  ↑ / ↓      navigate the slash-command preview (Enter runs the highlighted one)",
    "  Enter      submit input / confirm picker selection",
    "  Shift-Enter / Ctrl-J / \\+Enter   insert a line break instead of submitting (Alt/Option-Enter and Ctrl-Enter work too)",
    "  Esc        clear typed input / cancel an open picker",
    "  Ctrl-C     cancel the in-flight turn (press again at the prompt to exit)",
    "  Ctrl-D     exit the REPL",
    "  Ctrl-O     dump the full last response (untruncated, tables rendered) into scrollback",
    "  Ctrl-L     redraw / re-anchor the prompt (recover the input box after the screen scrolls)",
    "  Ctrl-K / Ctrl-U / Ctrl-W   kill to end / start of line / previous word (emacs kill-ring)",
    "  Ctrl-Y / Alt-Y             yank / yank-pop the killed text",
    "  Ctrl-A / Ctrl-E            move to start / end of line",
    "  Cmd-← / Cmd-→ (Home/End)   jump to start / end of the current row of a multi-line draft",
    "  Cmd-↑ / Cmd-↓ (Ctrl-Home/Ctrl-End)   jump to start / end of the whole draft",
    "  /          open the slash-command palette",
    "  @path      mention a file (Tab completes relative paths)",
    "  Ctrl-V     paste from the clipboard: an image attaches as [image #N], text inserts at the caret",
    "  drag-drop  drop an image file onto the box to attach it (its path becomes [image #N])",
    "  drag       select on-screen text to copy — copies on cmd/ctrl+c; under --tmux a drag auto-copies to the system clipboard",
    "  Shift-drag force the terminal's own selection when tmux owns the mouse (iTerm/macOS: Option-drag)",
  ];
}

/** Per-role token tallies for `/context`, estimated at ~4 chars/token. Pure over
 *  the in-memory history so the math is verifiable in isolation. */
export function contextUsageLines(
  history: Message[],
  resolved: string,
  window: number | undefined,
): string[] {
  const est = (s: string) => Math.ceil(s.length / 4);
  const byRole: Record<string, { msgs: number; tokens: number }> = {};
  for (const m of history) {
    const slot = (byRole[m.role] ??= { msgs: 0, tokens: 0 });
    slot.msgs++;
    slot.tokens += est(m.content);
  }
  const total = Object.values(byRole).reduce((sum, r) => sum + r.tokens, 0);
  const lines = ["Context usage (estimated, ~4 chars/token):"];
  for (const [role, r] of Object.entries(byRole)) {
    lines.push(`  ${role.padEnd(9)} ${String(r.msgs).padStart(3)} msg${r.msgs === 1 ? " " : "s"}  ~${r.tokens} tokens`);
  }
  lines.push(`  ${"total".padEnd(9)} ${String(history.length).padStart(3)} msgs  ~${total} tokens${window ? `  (${Math.round((total / window) * 100)}% of ${resolved}'s ${window}-token window)` : ""}`);
  lines.push("  Free context with /compact or /clear.");
  return lines;
}

/** Re-print the worked history into scrollback for `/history [N|all]`. Pure over
 *  the in-memory transcript plus the terminal width, so the banner/separator math
 *  and turn-count parsing are verifiable without driving the REPL.
 *  `arg` is the raw text after `/history` (e.g. " 10", " all", ""). */
export function historyViewLines(history: Message[], arg: string, columns: number | undefined): string[] {
  const a = arg.trim().toLowerCase();
  const maxTurns = a === "all" ? undefined : Math.max(1, Number.parseInt(a, 10) || 5);
  const sep = "─".repeat(Math.min(48, Math.max(20, (columns ?? 80) - 1)));
  return [
    sep,
    `history · last ${maxTurns ?? "all"} turn(s) (/history all for everything)`,
    sep,
    ...formatTranscript(history, { maxTurns, color: true, unicode: true }),
    sep,
  ];
}

