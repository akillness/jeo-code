# GJC TUI Analysis & Observations

This document catalogs a factual inventory of GJC CLI's TUI layout, behaviors, formatting, and interactive affordances, as observed from tmux captures sized 120x35.

---

## 1. Window Management & Screen Buffering

*   **Alternate Screen Buffer (`alternate_on`):** Checked during execution, value was `0`.
*   **Scrollback Behavior:** GJC prints output directly to the normal terminal scrollback buffer. When it exits or renders a new turn, all previous inputs, outputs, and CLI headers remain accessible in the terminal emulator's history scrollback.
    *   *Evidence:* `03-history.txt` contains the full logs including the original launch command (`gjc`) and the welcome banner.

---

## 2. Layout Regions

We identified seven distinct layout regions in the captures:

### 1) Header & Slogan Banner
*   **Description:** Located at the top of the interface when launched. Features a large rectangular border. The center displays `Gajae forge` and `shape · act · prove`. Below the slogan, GJC renders a beautifully colored, organic-curved ASCII graphic gradient of red, orange, and peach.
*   **Pills:** Contains two pill-shaped indicator boxes:
    *   Model pill: `[ ⬢ Claude Fable 5 ]` with a bright orange cube icon.
    *   Provider pill: `[ 📦 anthropic ]` with a package icon.
*   *Evidence:* `01-startup.txt`, `01-startup-ansi.txt` (Lines 2–16).

### 2) Conversation Area
*   **Description:** Displays the ongoing history of user queries and assistant responses. Older turns scroll upwards naturally.
*   *Evidence:* `03-history.txt`, `04-final.txt` (Lines 12–29).

### 3) User Input Label & Prompt
*   **Description:** User turns are introduced with a bold orange label `user`. The actual prompt is styled in a light peach/pinkish-white text color.
*   *Evidence:* `04-final-ansi.txt` (Lines 12–14).

### 4) Assistant Output Label & Text
*   **Description:** Assistant turns are introduced with a bold orange label `gajae`. The text response is printed in a cream/orange color.
*   *Evidence:* `04-final-ansi.txt` (Lines 19–20, 27–28).

### 5) Tool Call Checklist & Status Rows
*   **Description:** When GJC plans and runs tools, it outputs line-based status messages:
    *   `⏳ Read src/tui` while queued/running.
    *   `✔ Read package.json` when completed (indicated by a green checkmark `✔`).
*   *Evidence:* `02-live-1.txt` (Line 19–20), `05-live-2.txt` (Line 24, 27).

### 6) Boxed Tool Execution Block (Bash)
*   **Description:** When executing interactive or shell commands, GJC draws a prominent unicode box.
    *   **Header:** `┌─── ✔ Bash ───────────────────┐` (using box-drawing characters and green checkmark).
    *   **Inner command:** `│ $ echo hello                  │`
    *   **Separator line:** `├─── Output ────────────────────┤`
    *   **Output stdout/stderr:** `│ hello                         │`
    *   **Metadata/Timeout:** `│ ⟦Timeout: 300s⟧                │`
    *   **Footer:** `└───────────────────────────────┘`
*   *Evidence:* `05-live-3.txt` (Lines 22–27).

### 7) Status HUD Line
*   **Description:** Located directly above the input editor box. It provides live information about the model, Git status, workspace, transfer speed, and token cost.
    *   *Elements:* Model label (`⬢ Fable 5`), priority state (`◕ high`), git branch (`⑂ main`), current workspace directory (`📁 ~/.superset/projects/jeo-code`), transmission rate (`⤴ 38.7/s`), token context window consumption (`◫ 6.3%/1M`), and cost tracking (`$0.90 (sub)`).
*   *Evidence:* `01-startup.txt` (Line 23), `04-final.txt` (Line 29), `05-live-4.txt` (Line 29).

### 8) Input Editor Box
*   **Description:** A permanent, 3-row-high box at the very bottom of the screen.
    *   **Borders:** Highlighted with bright red borders.
    *   **Prompt marker:** A red `>` symbol.
    *   **Placeholder:** `Type your message...` in dark brown/grey.
*   *Evidence:* `01-startup.txt` (Lines 25–27), `01-startup-ansi.txt` (Lines 25–27).

---

## 3. Live-Turn Behaviors & Hints

### 9) Spinner & Running Status text
*   **Description:** While working, the HUD line is temporarily replaced or preceded by a live status indicator featuring a rotating spinner (e.g. `⠸`, `⠧`, `⠙`) and current operation description (e.g. `⠸ Working…`, `⠧ Listing tui directory`, `⠙ Running echo hello`).
*   *Evidence:* `02-live-1.txt` (Line 30), `05-live-2.txt` (Line 30), `05-live-3.txt` (Line 30).

### 10) Keyboard Interrupt Affordance
*   **Description:** During any tool call or model thinking stage, GJC displays the key hint `⟦esc⟧` next to the status message, indicating that the user can press the Escape key to cancel/interrupt execution.
*   *Evidence:* `02-live-1.txt` (Line 30), `05-live-3.txt` (Line 30).

### 11) Update Available Box
*   **Description:** Renders a centered block below the startup banner if a newer version of the CLI is available.
    *   **Borders:** Border lines styled in yellow/gold.
    *   **Text:** `Update Available` in bold yellow.
    *   **Instruction:** `New version 0.4.4 is available. Run: gjc update`.
*   *Evidence:* `01-startup.txt` (Lines 19–22).

### 12) Session Resume Hint
*   **Description:** Upon clean exit (by typing `/exit`), GJC outputs a final persistence message containing a unique UUID to resume the session in the future.
    *   *Message:* `Resume this session with gjc --resume <uuid>`
*   *Evidence:* `07-exit.txt` (Lines 34).

---

## 4. Color Palette (TrueColor Analysis)

From the 24-bit ANSI captures, the TUI uses the following colors:
*   **Teal/Green (`#6EE7B7` / `RGB 110, 231, 183`):** Used for checkmarks (`✔`) and status HUD git branch text.
*   **Orange (`#FF6A3D` / `RGB 255, 106, 61`):** Used for user/assistant turn labels (`user`, `gajae`), tool names in checklist, and model icon.
*   **Light Peach (`#FFE7DC` / `RGB 255, 231, 220`):** Used for user prompt text and tool arguments.
*   **Cream/Yellow-White (`#FFD7A8` / `RGB 255, 215, 168`):** Used for assistant response text.
*   **Bright Red (`#FF3B30` / `RGB 255, 59, 48`):** Used for the active input editor border and input prompt symbol `>`.
*   **Gold/Yellow (`#F5B84B` / `RGB 245, 184, 75`):** Used for update box borders and headers.
*   **Dark Red Highlight Background (`#7F1D1D` / `RGB 127, 29, 29`):** Used for token usage highlights.
*   **Brown/Grey (`#6F4743` / `RGB 111, 71, 67`):** Used for inactive borders (welcome banner) and placeholder texts.
