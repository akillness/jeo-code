# gjc v0.4.3 Runtime UI/UX Study — Mode A (`gjc`) vs Mode B (`gjc --tmux`)

Captured 2026-06-11 in self-owned 120x35 tmux sessions (`gjc-deep-rt-a`, `gjc-deep-rt-b`),
both killed after capture. Mode B spawned its own leader session
`gajae_code_mq945sls_yogzx53a` (also killed). All capture files live beside this doc.

Model: Claude Opus 4.8 / anthropic. Both modes ran the same driving turns.

---

## 1. Per-mode layout-region inventory

### Mode A — plain `gjc` (cites `A-01-startup.txt`, `A-02-*`, `A-03b-history-multitool.txt`, `A-04-final.txt`, `A-slash-hint.txt`, `A-input-editor.txt`)

1. **Welcome banner box** (`A-01-startup.txt:2-16`): rounded box titled
   `╭─── gjc v0.4.3 · GJC forge ───╮`, centered wordmark `Gajae forge`, tagline
   `shape · act · prove`, an ASCII/box-drawing hex-logo, and two pills
   `[ ⬢ Claude Opus 4.8 ]` and `[ 📦 anthropic ]`.
2. **Update-available band** (`A-01-startup.txt:20-23`): full-width rule-bordered notice
   `Update Available / New version 0.4.4 is available. Run: gjc update`.
3. **Status HUD line** (`A-01-startup.txt:24`, `A-02-live-2.txt`): single line
   `⬢ Opus 4.8 · ◕ high / ⑂ main ?1 / 📁 ~/.superset/projects/jeo-code ──── <turn title> / ⤴ 24.8/s / ◫ 6.2%/1M ⟲ / (sub)`.
   Segments: model glyph `⬢`, thinking level `◕ high`, git branch `⑂ main` + dirty flag `?1`,
   cwd `📁`, mid-line **turn-title summary** (`Summarize package.json`), live throughput
   `⤴ 25.9/s`, context meter `◫ 6.2%/1M`, reload glyph `⟲`, subagent marker `(sub)`.
4. **Input editor box** (`A-input-editor.txt`): rounded box, prompt caret `>`, placeholder
   `Type your message...`; live echoes typed text (`> read package.json and summarize it`).
5. **Conversation region** (`A-03-history.txt`, `A-03b-history-multitool.txt`): role labels
   `user` / `gajae`, reasoning preamble lines ("I'm planning to execute two separate
   operations…"), streamed answer text, markdown tables.
6. **Tool blocks**: inline check rows `✔ Read package.json` / `✔ Read package.json:raw` /
   `✔ Read src` (`A-02-live-2.txt`, `A-03b`), and a full bordered Bash card
   (`A-03b-history-multitool.txt`): `┌─── ✔ Bash ───┐ │ $ echo hi │ ├─── Output ───┤ │ hi │ │ ⟦Timeout: 300s⟧ │ └──┘`.
7. **Markdown table renderer** (`A-03b-history-multitool.txt`): the `list src` answer renders a
   2-column box-drawn table (`Dir/File │ Role`).
8. **Slash-command palette** (`A-slash-hint.txt`): typing `/` opens a selectable list under the
   editor — `❯ settings / theme / goal / model / fast …` with a `(1/33)` paginated counter.
9. **Footer/hints**: cancel hint `⟦esc⟧` rendered next to the spinner during a turn
   (`A-02-live-1.txt`).

### Mode B — `gjc --tmux` (cites `B-01-startup.txt`, `B-01-startup-chrome.txt`, `B-02-*`, `B-03-history.txt`, `B-04-final.txt`, `B-tmux-chrome-meta.txt`)

Mode B renders the **identical gjc TUI** (same banner/HUD/editor/tool blocks) inside a
dedicated leader tmux session, with extra tmux chrome:

10. **Leader tmux session**: gjc spawns its own session `gajae_code_mq945sls_yogzx53a`
    (`B-tmux-chrome-meta.txt`) — **single window** named `bun`, **single pane**
    (`pane count: 1`), 120x34. No leader/worker split at idle (splits only appear in team mode).
11. **tmux status bar** (`B-01-startup-chrome.txt` last line): default green bar
    `[gajae_cod0:bun*                  "π: projects" 15:26 11- 6월-26` — session name (truncated
    `gajae_cod`), window `0:bun*`, right-aligned pane title + clock/date.
12. **Custom pane title** = `π: projects` at startup, which **updates to track the turn title**
    `"π: Read and Summarize"` once a turn starts (`B-04-final-chrome.txt` last line).
13. **HUD cost field**: mode B HUD adds a `$0.42` cost segment
    (`B-02-live-4.txt`, `B-04-final.txt`): `… ◫ 6.6%/1M ⟲ / $0.42 (sub)` — not shown in mode A's
    HUD during this run.

---

## 2. Live-turn behaviors

- **Tool-call rendering** (both modes): pending tools show a braille spinner + dynamic verb;
  completed tools collapse to a `✔ <verb> <target>` row; shell tools render a bordered card with
  `$ cmd`, an `Output` divider, and a `⟦Timeout: 300s⟧` annotation
  (`A-02-live-2.txt`, `A-03b-history-multitool.txt`, `B-02-live-3.txt`).
- **Spinner / status text** (both): braille cycle `⠼⠇⠸⠧⠹` paired with a *context-aware* status
  verb that names the current action, not a generic label — `Working…` → `Reading package
  manifest` → `Reading full manifest` → `Running echo` (`A-02-live-1..5.txt`,
  `B-02-live-1..5.txt`). Cancel affordance `⟦esc⟧` sits on the same line.
- **Streaming** (both): answer text appears incrementally — successive frames show partial
  sentences mid-stream (`A-02-live-4.txt` shows a truncated `Dev: @types/bun, \`typ`;
  `A-02-live-5.txt` shows `(en/ko/ja/zh`). Throughput `⤴ 24.8/s → 65.9/s` climbs live.
- **Scrollback reachability** (both): `capture-pane -S -400` recovers full prior history
  (`A-03-history.txt` 58 lines, `A-03b-history-multitool.txt` 12.8KB, `B-03-history.txt`) — the
  banner is still in scrollback, confirming inline (main-screen) rendering.
- **alternate_on** = **0 in BOTH modes** at every sampled point (startup, mid-turn, final, exit):
  `A-01` alt=0, all `A-02-live-*` alt=0, `A-03` alt=0, exit alt=0; `B-01` alt=0, all `B-02-live-*`
  alt=0, `B-03` alt=0. gjc never enters the terminal alternate screen — it scrolls the primary
  buffer, so native terminal scrollback/copy works in both modes.

---

## 3. MODE A vs MODE B difference table

| Aspect | Mode A (`gjc`) | Mode B (`gjc --tmux`) | Evidence |
|---|---|---|---|
| Process container | runs in the invoking terminal/pane | spawns own leader tmux session `gajae_code_mq945sls_*` | `B-tmux-chrome-meta.txt` |
| tmux status bar | none (only my outer harness) | default green tmux status bar present as chrome | `B-01-startup-chrome.txt` |
| Pane title | not set by gjc | `π: <summary>`; tracks turn title (`π: projects`→`π: Read and Summarize`) | `B-01/B-04-chrome` |
| Window/pane layout | single foreground app | 1 window `bun`, 1 pane (no leader/worker split at idle) | `B-tmux-chrome-meta.txt` |
| Banner / HUD / editor / tool blocks | full TUI | **identical** full TUI inside the pane | `A-01` vs `B-01` |
| HUD git segment | shows `⑂ main ?1` (ran in jeo-code repo) | absent (leader session cwd `~/.superset/projects`, no repo) | `A-02-live-1` vs `B-02-live-1` |
| HUD cost segment | not shown this run | shows `$0.34 … $0.42` | `B-02-live-4`, `B-04-final` |
| alternate_on | 0 (inline) | 0 (inline) | both `*-live-*` |
| Scrollback | native + `capture -S` | native + `capture -S` (pane scrollback) | `A-03` / `B-03` |
| Cleanup model | exit closes app in place | leaves a detached tmux session that must be killed | `tmux ls` deltas |

**Summary of the only real differences:** Mode B is the *same TUI* wrapped in a gjc-managed
tmux session that adds (a) a tmux status bar, (b) a pane title synced to the live turn summary,
and (c) a persistent, re-attachable session. Everything inside the gjc pane (banner, HUD,
streaming, tool cards, slash palette, spinner) is byte-for-byte the same between modes.

---

## 4. Things gjc shows that a focused TS reimplementation might lack

1. **Context-aware spinner verbs** — status text names the live action ("Reading full manifest",
   "Running echo"), not a static "Working…" (`A-02-live-*`, `B-02-live-*`).
2. **Live throughput meter** `⤴ NN.N/s` in the HUD, updating per frame (`A-02-live-2..5`).
3. **Context-window meter** `◫ 6.2%/1M` with `⟲` reload glyph (`A-01`, all HUD lines).
4. **Auto-summarized turn title** rendered into the HUD *and* the tmux pane title
   (`A-02-live-1` `Summarize package.json`; `B-04-chrome` `π: Read and Summarize`).
5. **Bordered tool-result cards** with command echo, `Output` divider, and `⟦Timeout: 300s⟧`
   annotation (`A-03b-history-multitool.txt`).
6. **Markdown table rendering** of assistant answers (`A-03b-history-multitool.txt`).
7. **Paginated slash-command palette** (`(1/33)`, descriptions per command) (`A-slash-hint.txt`).
8. **Inline (no-altscreen) rendering** preserving native terminal scrollback/copy in both modes
   (`alternate_on=0` everywhere).
9. **tmux pane-title sync** to the active turn, enabling at-a-glance multi-session monitoring
   (`B-01/B-04 chrome`).
10. **Cost accounting** `$0.42` and **subagent marker** `(sub)` in the HUD (`B-04-final.txt`).
11. **Git status in HUD** — branch `⑂ main` + dirty `?1` (`A-02-live-1`).
12. **Reasoning preamble** lines (`gajae` label + "I'm planning to…") shown before tool calls
    (`A-03b-history-multitool.txt`).
13. **Welcome banner** with model/provider pills and ASCII logo (`A-01`, `B-01`).
14. **Cancel affordance** `⟦esc⟧` shown beside the spinner during every turn.
15. **`gjc --tmux` orchestration** — automatic dedicated tmux session with a status bar, making
    the session persistent/re-attachable rather than tied to the foreground terminal.

---

## Capture file index
- `A-01-startup.txt` / `-ansi` — mode A welcome/banner/HUD/editor
- `A-input-editor.txt`, `A-input-editor2.txt` — editor with typed text
- `A-02-live-1..5.txt` — turn-1 live frames (3s cadence)
- `A-02b-live-1..4.txt` — multi-tool turn live frames
- `A-03-history.txt` — mid-turn scrollback (`-S -400`)
- `A-03b-history-multitool.txt` — full multi-tool history incl. Bash card + table
- `A-04-final.txt` / `-ansi` — turn-1 completed
- `A-slash-hint.txt` / `-ansi` — slash palette (33 cmds)
- `A-05-exit.txt` — exit interaction
- `B-01-startup.txt` / `-ansi` — mode B pane content
- `B-01-startup-chrome.txt` / `-ansi` — mode B full view incl. tmux status bar
- `B-02-live-1..5.txt` — mode B live frames
- `B-03-history.txt` — mode B scrollback
- `B-04-final.txt` / `-ansi`, `B-04-final-chrome.txt` — mode B completed (+ pane-title sync)
- `B-tmux-chrome-meta.txt` — spawned session/window/pane/title metadata
