# JOC TUI Analysis & Observations

This document catalogs a factual inventory of JOC CLI's interactive TUI layout, behaviors, formatting, and interactive affordances, as observed from tmux captures sized 120x35.

---

## 1. Window Management & Screen Buffering

*   **Alternate Screen Buffer (`alternate_on`):** Checked during execution, value was `0` (as recorded in `alternate_on.txt`).
*   **Scrollback Behavior:** JOC prints output directly to the normal terminal scrollback buffer. When it exits or renders a new turn, all previous inputs, outputs, and CLI headers remain accessible in the terminal emulator's history scrollback.
    *   *Evidence:* `03-history.txt` contains the full logs including the original launch command (`bun src/cli.ts launch`), the welcome banner, the tool executions, and the collapsed turn details.

---

## 2. Layout Regions

We identified the following distinct layout regions in the captures:

### 1) Header & Welcome Banner
*   **Description:** Located at the top of the interface when launched. Features a 15-row-high welcome banner box.
    *   Left side: Displays `jeo-code` and slogan `evolve · act · prove`, an ASCII cell graphic representing evolution, a model pill (`[ ◆ gemini-flash-latest ]`), and provider pill (`[ ◇ gemini ]`).
    *   Right side: Displays Flow keys (commands list) and Workspace details (cwd, thinking level, session UUID, context files, and Session trail).
*   *Evidence:* `01-startup.txt` (Lines 3–17), `01-startup-ansi.txt` (Lines 3–17).

### 2) Help & Status Row
*   **Description:** Printed immediately below the welcome banner box during startup. It contains the basic typing/slash command hints and fetching models status.
*   *Evidence:* `01-startup.txt` (Lines 18–20).

### 3) Input Editor Box
*   **Description:** A permanent 3-row-high box at the bottom of the screen.
    *   Borders: Highlighted with rounded thin corner borders.
    *   Placeholder: `Type a request, /help, or @path`
*   *Evidence:* `01-startup.txt` (Lines 21–23), `04-final.txt` (Lines 24–26).

### 4) Step Checklist & Status Summary (Done/Phase Summary)
*   **Description:** When a turn completes, JOC outputs unboxed lines showing steps taken and phase summaries.
    *   Step checklist: `Steps  ✓1 / 1  ·  5.4s` and `  └ ● [01:DONE] read`
    *   Phase done summary: `[DONE] thinking → planning → executing → done · 2 steps · 5s · 17.1k in / 80 out tokens`
*   *Evidence:* `04-final.txt` (Lines 1–2, 20).

### 5) Tool Call Parameter & Result Boxes
*   **Description:** Tool executions are enclosed in their own rounded boxes of width 96.
    *   Parameter box: `[01:FILE] read package.json · path` containing fields like `path: package.json`
    *   Result box: `[02:FILE] read result ok · output` containing line-numbered code preview.
*   *Evidence:* `02-live.txt` (Lines 3–8, 10–19), `04-final.txt` (Lines 3–8, 10–19).

### 6) Phase HUD Row
*   **Description:** A live indicator displaying the active phase sequence.
    *   Format: `  ● thinking → ○ planning → ○ executing → ○ reporting → ○ done`
*   *Evidence:* `02-live.txt` (Line 28).

### 7) Status Rows (`[STEP]`, `[STATUS]`, `[TOOL]`)
*   **Description:** Live execution status indicators showing step progress, current model status, and tool execution statistics.
    *   `[STEP]`: Displays step index, progress bar/percentage, elapsed/step times, token count, and transfer rate.
    *   `[STATUS]`: Displays current action (e.g. `calling model (gemini-flash-latest)`).
    *   `[TOOL]`: Displays forge status and tool statistics (ok, fail, running counts).
*   *Evidence:* `02-live.txt` (Lines 30–32).

### 8) Hint Bar & Bottom HUD Line (Live Panel)
*   **Description:** The hint bar shows key combinations like `^C cancel · Tab complete · ...`. The bottom HUD line displays model name, git branch, directory, elapsed time, ETA, and current subagent.
*   *Evidence:* `02-live.txt` (Lines 33–34).

### 9) Evolution Track Line
*   **Description:** A game-like progression message representing the level evolved.
    *   Format: `Evolved to: ●●○○○ Double Helix (DNA) [2/5] (took 2 steps in 5s ...)`
*   *Evidence:* `04-final.txt` (Line 21).

### 10) Assistant Response & Token Cost
*   **Description:** The final reply prefix `joc>` followed by the model answer and raw token count.
    *   `joc> The name of the package is "jeo-code" and the version is "0.1.0".`
    *   `(17135 in / 80 out tokens)`
*   *Evidence:* `04-final.txt` (Lines 22–23).

---

## 3. Structural Questions & Answers

### (a) Line Spacing (행간)
*   **Startup:** All headers, slogan welcome banner, help texts, and input box are tightly packed (0 blank lines separating them). 12 trailing blank lines follow the input box.
*   **Live Turn:** The nested tool call boxes inside the outer frame are separated from each other by exactly **1 blank line**. Below the last tool result box is a horizontal line (`├─...─┤`), followed by **7 blank lines** before the phase HUD row. There is exactly **1 blank line** between the phase HUD and the `[STEP]` status row. All status, hint, and footer HUD lines are tightly packed (0 blank lines).
*   **Collapsed/Final:** The unboxed step checklist has 0 blank lines before the first tool parameter box. The two tool boxes are separated by **1 blank line**. The second tool result box is followed immediately (0 blank lines) by the DONE summary, the evolution line, the assistant response, and the token cost. The input editor box directly follows the token cost row (0 blank lines).

### (b) Visual Grouping (Cards/Boxes)
*   **Startup:** The welcome banner is boxed (15 rows high). The input box at the bottom is a standalone 3-row-high card.
*   **Live Turn:** The entire screen is encapsulated in a single large outer box (`╭───` to `╰───`). Tool executions are nested as inner rounded boxes/cards within this outer box.
*   **Collapsed/Final:** The outer box is completely removed. Only the tool parameter and result boxes remain individually boxed/carded, flowing naturally in the scrollback buffer. The rest of the content (steps summary, evolution, response text) is printed as unboxed raw lines. The input box remains carded at the bottom.

### (c) Stage Mapping
*   **thinking:** Maps to the `● thinking` phase HUD stage. The `[STATUS]` row shows model calls like `calling model (gemini-flash-latest)`.
*   **planning:** Maps to `○ planning` stage in the phase HUD. `[STATUS]` row shows planning details.
*   **executing:** Maps to `○ executing` stage. The checklist displays the running status of tools, `[TOOL]` row displays active tool details, and the tool parameter/result boxes are rendered.
*   **reporting:** Maps to `○ reporting` stage in the phase HUD.
*   **done:** Maps to the final collapsed screen. The unboxed done summary, evolution track line, assistant response line (`joc>`), and token cost are printed.

---

## 4. Comparison vs GJC (logs/gjc-tui-study/)

*   **Outer Layout Box:** Unlike GJC where all components are printed inline and separate, JOC wraps the entire live execution screen in a single unified box during the turn, separating regions using a horizontal line and inner cards.
*   **Turn Collapse Behavior:** GJC retains its input box at the very bottom and prints the response inline without boxed tool summaries. JOC removes the outer wrapper upon collapse, printing the step summaries and keeping the tool parameter/result boxes beautifully boxed in the scrollback history.
*   **User Turn Labels:** GJC prints a clear orange `user` label above the query text, whereas JOC does not reprint the user query inline; instead, JOC prints a game-like evolution progression (`Evolved to: ...`) followed by `joc> <reply>`.
*   **Evolution Theme:** JOC features a unique theme with ASCII cells, "Primordial Cell", and a game-like level-up sequence (`Evolved to: ●●○○○ Double Helix (DNA)...`), which is completely absent from GJC's utility-first look.
