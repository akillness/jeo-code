# Changelog

All notable changes to **jeo-code** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The README mirrors the latest 5 entries — regenerate with `bun run changelog:sync`.

## [0.6.12] - 2026-06-16
_OKF-backed memory distillation — session learnings become structured concept files._

### Added
- **OKF-backed memory distillation (OKF Sprint 02).** Session distillation now emits structured OKF v0.1 concept files — each with `type` / `title` / `description` / `body` / `tags` / `confidence` / `links` — filed into typed directories (unknown types fall back to `facts/`), deduped by title, merged with the existing concept bundle, then indexed and logged. The distiller prompts the model for a `{ concepts: [...] }` payload and parses it leniently (`tryExtractJsonObject`) so text-only providers still land. Builds on the 0.6.10 OKF format layer.

## [0.6.11] - 2026-06-16
_Larger reasoning budgets, and terminal capability-response sequences kept out of the prompt._

### Changed
- **Larger thinking-token budgets across every level.** `thinkingMaxTokens` is raised (minimal 1k→4k, low 2k→8k, default 4k→16k, high 8k→24k, xhigh 16k→32k), along with the Anthropic (medium 4k→10k, high 10k→24k) and Gemini (low→4k, medium→10k, high→24k) per-provider budgets — so each reasoning level actually gets room to think.

### Fixed
- **Terminal capability-response sequences no longer corrupt the prompt.** The mouse-report filter (0.6.7) now also swallows Device-Attributes / mode replies that the outer terminal sends when tmux probes it on attach, on both the idle keypress path and the live-turn raw-stdin drain.

## [0.6.10] - 2026-06-16
_OKF memory-format foundation and a hardened bashTool subprocess drain._

### Added
- **OKF (Open Knowledge Format) v0.1 foundation** — a standalone schema/format layer for jeo memory: YAML-frontmatter parse/serialize with extension-key round-trip, concept-ID computation, and a tolerant v0.1 conformance validator (`src/agent/memory-okf.ts`). Sprint 01 only — it does not touch the existing distill/inject pipeline yet, and adds zero native dependencies. Design notes live under `docs/okf_mem/`.

### Fixed
- **bashTool subprocess draining hardened.** A shared `drainPipe` reader plus reader-cancellation, a SIGTERM→SIGKILL kill timer, and a brief pipe-linger ensure stdout/stderr fully drain before teardown — no file-descriptor or child-process leak across the normal, timed-out, and abandoned lifecycles (the subprocess-leak probe stays at baseline).

## [0.6.9] - 2026-06-16
_Live streaming blocks size to their content and the viewport instead of a fixed rectangle._

### Changed
- **`Thinking` / tool `Output` live blocks size to their content.** The dimmed streaming trace and tool-output tail are now rendered by a single `renderLiveBlock` helper that shows only the most-recent lines, capped at ~30% of the terminal height — instead of a fixed blank-padded rectangle. A short stream no longer leaves dead "hole" rows, and a short terminal keeps the rows the heartbeat needs.
- Dropped the rounded-icon header image from the READMEs (the hero image and title stay).

## [0.6.8] - 2026-06-16
_OAuth loopback callback host pinned to `localhost` to match provider-registered redirect URIs._

### Fixed
- **OAuth loopback callback uses `localhost`** (not the `127.0.0.1` IP literal). Providers register their dynamic-loopback redirect URIs against `localhost`, so the callback host must match it exactly — an IP literal can mismatch the registered URI and break the Anthropic / Google / Antigravity login flows. The default is now documented in-code so it doesn't drift again.

## [0.6.7] - 2026-06-16
_Mouse-report input corruption fixed under `jeo --tmux`, and a full-width TUI at one consistent width._

### Fixed
- **Mouse reports no longer corrupt the prompt.** `jeo --tmux` enables tmux `mouse on` (so wheel-scroll reaches copy-mode), but the mouse-report bytes it delivers — X10 `ESC[M…` and SGR `ESC[<…M/m` — were landing in the input box as typed text (the "값 입력" digit spray when you click or scroll). A filter now swallows whole mouse-report sequences on both the idle keypress path and the live-turn raw-stdin drain, so they never reach readline.

### Changed
- **TUI fills the full terminal width.** The welcome banner, input box, user/forge cards, history panel, and status box now share one wrap-safe `cols - 1` width instead of capping at 100/120 columns — every box lines up, and a full-width row never trips the terminal's last-column autowrap. The welcome banner's separate proportional/centered modes are dropped in favor of this single width.

## [0.6.6] - 2026-06-16
_Vertical caret movement between input-box rows, a centered welcome banner, and a leaner `parseFlags`._

### Added
- **Vertical caret movement in the boxed prompt.** ↑/↓ inside a multi-line or wrapped draft now move the caret between the input box's visual rows (textarea feel) via `verticalCursorOffset`; an ↑/↓ at the top/bottom edge still falls through to readline history recall.

### Changed
- **Welcome banner is centered.**
- **`parseFlags` simplified** — duplicate `--flag` / `--flag=` branches collapsed into one (`takeValue()` already resolves both spellings), −40 lines with zero behavior change.

## [0.6.5] - 2026-06-16
_macOS combo-key editing in the boxed prompt, a fresh-start screen clear at launch, a proportional welcome banner, height-aware relayout — and `launch.ts` split into focused submodules._

### Added
- **macOS / fixterms combo keys in the boxed prompt.** Option+Left/Right (word jump) and Cmd+Left/Right (line start/end), plus Option/Cmd+Backspace, are normalized to the canonical control bytes Bun's readline already acts on — so the keys macOS users actually reach for now move the caret instead of doing nothing. Readline stays the single owner of the cursor; the box just repaints.
- **Fresh-start screen clear at launch.** The banner opens atop a cleared screen (erase screen + scrollback) on a TTY — never mid-turn, so tmux scrollback is never flooded.

### Changed
- **Welcome banner uses a natural, proportional hero width** instead of stretching into a mostly-empty rectangle on wide terminals; it shrinks gracefully (grand→compact claw) on narrow ones so the art keeps its shape and never clips.
- **`launch.ts` split into focused submodules** under `src/commands/launch/` (`flags`, `input`, `tmux`, `stream`, `workflow`) — a ~1000-line maintainability refactor with no behavior change; the public surface is re-exported unchanged.

### Fixed
- **Renderer relayouts on height change**, not just width — a terminal that grows/shrinks vertically now repaints correctly.
- **Pickers no longer leave typed filter text behind.** A `/model` · `/agents` picker that read keystrokes directly no longer queues its leftover filter text as the next prompt.

## [0.6.4] - 2026-06-16
_Branding, a responsive-resize fix, `/provider` realignment, and engine repeat-spin recovery._

### Added
- **Branding** — jeo-code icon set, favicon, social preview + README logo (#33).
- **Goal verifier** — turns are checked against the stated goal before completing, so a turn can't silently report done without meeting it.
- Dynamic resolution handling + jeo-tone text styling across the TUI.

### Changed
- **`/provider` aligned with gjc** — it's now onboarding/login only; switching the active model moves to `/model`.

### Fixed
- **Responsive resize no longer lags** — leading-edge throttle replaces the trailing debounce that never fired during a continuous drag, so the frame tracks the drag live and paints the final geometry exactly.
- **Engine recovers from repeat-spin** instead of cold-stopping the turn.
- Idle input box capped at 120 cols to match the live-turn box.

## [0.6.3] - 2026-06-16
_OAuth loopback reliability fix._

### Fixed
- **OAuth loopback redirect uses `127.0.0.1` instead of `localhost`** (RFC 8252 §7.3). `localhost` can resolve to IPv6 `::1` or be hosts-file-overridden, intermittently breaking the auth callback; the IP literal is reliable. Only the dynamic-loopback path changes — providers with a fixed redirect URI are unaffected (#30).

## [0.6.2] - 2026-06-16
_Interactive `/provider` picker, clearer animated status + labeled block/prose boundaries, and a transient empty-response retry._

### Added
- **Interactive `/provider` picker** (gjc-style) with a clean screen after login (#26).
- **Clearer visual structure** — unified labeled boundaries for thinking / reasoning / output blocks and a dimensional animated status line (#29, building on the labeled-boundary work).
- `docs/minimo/` — a plan to apply MiMo Code's memory & goal-management ideas to jeo (#28).

### Fixed
- **Retry transient empty-200 responses** (a 200 with an empty body) for stability — gjc parity (#27).

## [0.6.1] - 2026-06-16
_Live reasoning progress (no more frozen "calling model"), thinking-level fixes for Anthropic/Antigravity, and input-box/Ctrl+O TUI fixes._

### Added
- **Live reasoning progress.** Codex/OpenAI reasoning models now stream their thinking into the live frame (`reasoning.summary: "auto"` + `response.reasoning*.delta` events surfaced via `onReasoning`), and the status row reads `reasoning (model)…` / `thinking — reasoning, no token stream yet…` after a silent wait instead of a frozen `calling model (Ns)…`.

### Fixed
- Thinking level is now applied to the **Anthropic and Antigravity** providers (it was a silent no-op there).
- The **input box + caret stay in place after running a command** — no more vanishing box / caret parked at the reservation top.
- **Skill runs render a compact `[skill]` card** instead of dumping the injected `SKILL.md` into a user box.
- **Ctrl+O fold toggle** + incremental session durability across interruption.

### Changed
- Trimmed `fastThinkingLevelForModel` fallback to the real gap (ponytail pass); added a usage guide + demo video, linked from all READMEs.

## [0.6.0] - 2026-06-16
_TUI quality of life: durable input history (↑ recalls past queries across launches), clean `/resume` rendering, and a scrollable mid-turn Ctrl+O panel._

### Added
- **Durable input history.** ↑/↓ at the prompt now recall "이전에 사용한 쿼리" across launches, not just lines typed in the current run: submitted prompts persist to a per-workspace `.jeo/input-history` file (deduped, capped, best-effort) and hydrate readline's ring on the next launch. Composes with `/resume`, which already seeds the resumed session's own prompts into the ring. New `src/agent/input-history.ts` (`loadInputHistory`/`appendInputHistory`).

### Fixed
- **`/resume` dumped raw JSON and broke the TUI.** When a resumed session's assistant turn was stored as a ```json-fenced (or reasoning-decorated) tool call, the transcript renderer's naive `JSON.parse` failed and dumped the raw JSON block into the screen. `formatTranscript` now uses the engine's robust extractor (`tryExtractJsonObject`) and only treats a message as a tool call when it actually begins with `{` (after stripping a leading fence) — so fenced/decorated tool calls render as proper `✔ title` cards, prose that merely contains JSON stays prose, and no raw JSON ever leaks into the resumed view.
- **Ctrl+O while a turn runs cropped the detail panel** at "… N more line(s)", so a long reply / tool output (especially CJK) couldn't be read past the first screenful. The live panel now WINDOWS the content with `↑ N more above` / `↓ N more below` counters and is scrollable with ↑/↓ and PgUp/PgDn — every line is reachable, nothing is dropped, and short content still renders as a plain non-scrollable panel. The in-flight key harness routes arrow/PageUp/PageDown to a new `onScrollKey` hook (a no-op when the panel is closed, so those keys stay inert otherwise); `LaunchTui.scrollDetail()` clamps within `[0, max]` and guarantees the last line is reachable. Mirrors the 0.5.16 idle-prompt Ctrl+O fix for the mid-turn path.

## [0.5.16] - 2026-06-16
_`/resume` and Ctrl+O no longer corrupt the TUI — clean screen restore + scrollback expand._

### Fixed
- **`/resume` corrupted the screen on a TTY.** After picking a session the resumed transcript was dumped on top of whatever was on screen (picker remnants, the prior conversation, the live input frame), so replayed ANSI/forge boxes from the old session collided with the live layout. Resume now wipes the screen + scrollback and re-renders the welcome banner BEFORE replaying the transcript — the same proven path `/clear` uses — so the restored view is a single, intact screen (verified live: one input box, one status bar, no picker remnants).
- **Ctrl+O at the prompt crammed the last response into the ~10-row footer**, clipping long/CJK content with "… N more line(s)" and risking a garbled box. Ctrl+O now expands the full last assistant response into scrollback (clean `disarm → print → re-arm` path), so it is fully scrollable and the input box + typed draft restore without corruption. Removed the now-dead footer history-panel machinery (`promptHistoryLines`, `historyPreviewLines`).

## [0.5.15] - 2026-06-16
_`jeo update` now actually upgrades — bare command installs the latest release instead of just printing a manual command._

### Changed
- `jeo update` (bare) now performs the upgrade itself: when a newer release exists it runs the install (`bun install -g jeo-code@<latest>`, pinned to the resolved latest version so a stale global cache can't win) instead of printing "Run 'bun install -g jeo-code' to upgrade" and leaving the user to do it. `--check` is the new check-only mode; `--json` stays check-only for programmatic status (add `--install` to install in JSON mode); `--install` still forces an install. The check-only hint now points at `jeo update` itself.

## [0.5.14] - 2026-06-16
_`jeo --tmux` live-verification harness — repeatable stability + behavior checks._

### Added
- `scripts/tmux-verify.sh` (and `bun run verify:tmux`) codifies the launch → send-keys → capture → cleanup loop into one repeatable command, so stability and behavior of the interactive TUI can be checked without hand-rolled one-off bash. macOS-safe (no GNU `timeout`; a bash watchdog polls for the session). Boots jeo in a DETACHED tmux session inside a throwaway cwd (never edits the real repo) and only ever kills the session it created — a user's `jeo-main-*` session is never touched. Subcommands: `smoke` (boot + assert the input box and model bar render, no crash — the stability gate), `check "<input>" "<regex>" [--ansi] [--wait N]` (type input, assert the pane matches a pattern — the behavior primitive; captures scrollback so long output like `/help` still matches), and `capture` (dump the settled frame).

### Changed
- `jeo whats-new` (and the post-upgrade update notice) now default to the **5 most recent** releases instead of only the single latest entry, so the notes no longer look static/hardcoded across upgrades. `--all` still prints the full history. New shared constant `RECENT_RELEASE_COUNT` (`src/util/whats-new.ts`) is the single source of truth for both the command and the launch notice (the launch notice is capped to it too, so a large version jump no longer dumps a wall). Mirrors gjc's "Recent Changes" pattern (latest-N + a full toggle) and the README's latest-5 digest.

### Maintainer notes
- Internal refactors landed since 0.5.13 (no behavior change): centralized workflow name/engine dispatch (`WORKFLOW_NAMES`/`runWorkflowEngine`), a shared `statusBoxData()` for the inline/non-inline status frames, and a `normalizeSlashAlias()` helper. Also fixed a flaky test where the light-tool ledger line briefly carried an elapsed `(Nms)` suffix — that detail belongs on the forge cards, the ledger line is a clean single line again.

## [0.5.13] - 2026-06-15
_Workflow `/` commands actually run — `/deep-interview`, `/team`, `/ultragoal`, `/ralplan` dispatch by name._

### Fixed
- Workflow skills listed in the `/` menu didn't run: a bare `/name` only resolved when the skill's SKILL.md happened to self-reference that slash token (so `/ralplan` worked by luck while `/deep-interview` and `/ultragoal` returned "Unknown command"). `parseSkillInvocation` now resolves a plain `/word` against skill NAMES (exact, then unique prefix) — the same entrypoint as `$name` and `/skill:name` (gjc parity) — so `/deep-interview`, `/ralplan`, `/team`, `/ultragoal` (and any loaded skill) dispatch from the slash menu. Dotted (`/speckit.plan`) and nested (`/a/b`) tokens keep their alias/file-path resolution untouched, and built-in commands still take precedence.
- The four bundled workflows are now always listed in the `/` menu as `/deep-interview`, `/ralplan`, `/team`, `/ultragoal`, even when their SKILL.md declares no slash alias, so they are discoverable as well as runnable.

## [0.5.12] - 2026-06-15
_Yellow status animation while a process runs, and elapsed `(Nms)` on every completed tool card._

### Added
- The live status animation (spinner + activity gradient) turns amber/yellow while a tool/process is executing — "the agent is running/verifying a process" now reads at a glance, distinct from the cool thinking gradient (gjc `theme.fg("warning")` parity).
- Every completed tool card and light-tool ledger line now shows how long the tool ran, dim after the ✓/✗ glyph — `✓ Bash · (8ms)`, `✓ Read x.ts · (3ms)` (gjc duration-detail parity; sub-second as `Nms`, else `N.Ns`/`Nm Ns`).

## [0.5.11] - 2026-06-15
_Backspace on an empty prompt line no longer quits jeo._

### Fixed
- Pressing Backspace with an empty input line could terminate the process on some Bun builds: an empty-line Backspace is a no-op edit, but those builds turn it into a spurious readline `close`, which the REPL treats as a hard exit. The multi-line input filter now swallows a standalone Backspace (DEL `0x7f` / BS `0x08`) when the line buffer is already empty, so the byte never reaches readline and the close can't fire. Backspace with text in the buffer still deletes normally, and Ctrl-C / paste / Enter are untouched.

## [0.5.10] - 2026-06-15
_`/resume` transcript no longer dumps raw JSON for batched tool calls._

### Fixed
- Resuming a session that contains a BATCHED tool step (`{reasoning, tools:[…]}`) printed the raw JSON object into the transcript instead of a readable history. `formatTranscript` only recognized the single-call `{tool,arguments}` shape; the batch shape parsed to no `tool` field, fell through to the prose branch, and dumped the JSON. It now renders one compact `✔/✗ <tool> — <result>` ledger line per batched call (verdicts parsed in call order from the combined `Tool [x] result` message), matching how single calls already render. `/resume` and `/history` both go through this path, so both are fixed.

## [0.5.9] - 2026-06-15
_Bounded per-frame wrap for the live thinking/tool-output blocks — re-render cost no longer grows with stream length._

### Changed
- The live "thinking" and tool-output tail blocks only ever DISPLAY their last 6/8 wrapped rows, but they accumulate the whole step's text and were re-wrapping the FULL string on every 120ms repaint — so per-frame CPU and GC churn grew linearly with how much had streamed (a long reasoning trace or a chatty tool can reach hundreds of KB). The wrap input is now bounded to a fixed 16 KiB trailing window (`tailForWrap`), capping per-frame work at O(window) regardless of total size. The visible tail is byte-identical for normal multi-line content; an unbroken multi-hundred-KB blob still shows its genuine end. No memory leak existed (every live buffer — StreamRegion, ToolList, activityLog, forgeSummaries — is already ring-capped and the per-turn TUI instance is GC'd); this removes the one remaining O(stream-length) hot path in the repaint loop.

## [0.5.8] - 2026-06-15
_Native Opik observability for the turn loop (opt-in `JEO_OPIK`, pure-TS no-op when unset) + autopilot convergence tracking._

### Added
- Native Opik observability for the agent turn loop (opt-in via `JEO_OPIK`): each turn becomes one Opik trace, each step/tool a span, with token usage and the `completed` / `verified` / `efficiency` eval scores attached. Implemented in pure TypeScript over `fetch` — no Python, no `opik` npm package — per jeo's zero-native-dependency constraint. Hard invariants: an unset `JEO_OPIK` is a complete no-op (zero Opik HTTP calls); no tracer error ever escapes an events callback; the API key travels only in the `Authorization` header; and engine output is identical regardless of tracing outcome.

### Changed
- Autopilot convergence tracking: a "keep" (a provable min/max improvement or a gate pass) now counts as forward progress, and anything else extends the no-progress streak toward the convergence cap.

## [0.5.7] - 2026-06-15
_`/model` picker is default-only, `/clear` resets to the initial screen, ESC clears the input box, and a launch process-listener leak is fixed._

### Changed
- The `/model` model-action picker now offers ONLY the DEFAULT section: "Set model only" plus the default thinking levels. The per-role rows ("Set as EXECUTOR/PLANNER/ARCHITECT/CRITIC") and the "Apply OpenAI Codex role preset" entry are gone — role model and thinking are configured exclusively in `/agents` (and `/agents edit`). The default heading now points there (`roles → /agents`). This completes the 0.5.6 split: `/model` owns the default, `/agents` owns the roles. Dead helpers (`orderedModelRoles`, `applyOpenAiCodexRolePreset`, `CORE_MODEL_ACTION_ROLE_ORDER`) were removed with the menus.

### Added
- `/clear` now returns to the initial screen (fresh session view) and ESC clears the input box, matching the expected reset gestures.

### Fixed
- Launch no longer leaks process listeners: the prompt-scoped stdin `data`/`keypress` and stdout `resize` handlers are now tracked and drained on every exit path, so repeated `launch()` (e.g. the test harness) no longer accumulates listeners past Node's 10-listener default (`MaxListenersExceededWarning` + a real leak).

## [0.5.6] - 2026-06-15
_`/model` sets only the default thinking; per-role reasoning moved to `/agents`._

### Changed
- Thinking ownership split: `/model` now configures reasoning for the DEFAULT agent only, and per-role (subagent) thinking is owned by `/agents`. In the model-action picker the role rows offer just "Set model only" (the per-level thinking rows are gone), `/model subagent <role> thinking <level>` redirects to `/agents` instead of saving, and picking a role's model no longer prompts for a reasoning level. Set role reasoning via `/agents <role> thinking <level|inherit>` or the `/agents edit` picker. `/model thinking <level>` still sets the default, so nothing the default knob did is lost.

## [0.5.5] - 2026-06-15
_Full multi-line visibility — the input box scrolls to the caret and the submitted card shows every line._

### Fixed
- Full multi-line visibility for the multi-line input added in 0.5.4: the input box now scrolls so the caret row always stays in view as you move through a long draft (`…` markers flag rows hidden above/below, so no line is unreachable), and a submitted multi-line query renders ALL of its wrapped lines in the user card — the card lives in scrollback rather than the bounded live frame, so nothing is truncated.

## [0.5.4] - 2026-06-15
_Reliable multi-line input is ON by default — a paste fills the box and submits as one message._

### Changed
- Multi-line input is now enabled by default on any interactive TTY (no flag needed): a bracketed paste arrives as ONE buffer, fills the input box, and submits as a single message instead of being split into one message per line. The prompt's stdin is routed through a filter that rewrites line breaks to a private-use sentinel before `node:readline` sees them, avoiding the per-line submit/race. The lone-`\n` Shift+Enter rule stays opt-in via `JEO_MULTILINE=1` (it needs ghostty's `keybind = shift+enter=text:\n` and could misfire on terminals that send LF for Enter), and `JEO_NO_MULTILINE=1` fully disables the filter (reads stdin directly, exactly as before).

## [0.5.3] - 2026-06-15
_`$` chains multiple skills in one line (all run, in order), plus multi-line prompt input — paste-merge and gated Shift+Enter._

### Added
- Multi-skill `$` chaining: a leading run of `$skill` tokens now invokes every resolved skill in order, sharing the trailing text as one intent — `$ralplan $team build the auth flow` runs ralplan then team, both with intent "build the auth flow". A lone `$skill` is just a chain of one, so existing single invocations are unchanged. Prefixes still resolve (`$te $ultra …`), `$UPPERCASE` env-var tokens end the chain and pass through to the model, and unknown tokens are collected so several typos report together (`No skills: $nope, $bad.`) instead of one at a time. Applies to both the interactive prompt and one-shot `-p`/`/skill:` runs.
- Multi-line paste merges into ONE message: a pasted block with embedded newlines is submitted as a single prompt instead of being split into one message per line.
- Shift+Enter multi-line input (opt-in via `JEO_MULTILINE=1`): Shift+Enter inserts a real line break instead of submitting. Terminal-specific Shift+Enter encodings (ghostty legacy `\x1b[27;2;13~`, kitty `\x1b[13;2u`, and a lone `\n`) are rewritten to a private-use sentinel before `node:readline` sees them, so it works through tmux (extended-keys off) without mangling; default OFF reads stdin exactly as before.

### Changed
- The one-shot skill path was refactored to a shared `runOneSkillShot` runner so the single-invocation and chain paths execute identically (bundle workflow → engine; regular skill → agent turn).

## [0.5.2] - 2026-06-14
_`$skill` prompt invocation with prefix/fuzzy suggestions, and a per-session input-box hue (amber in cmd-mode)._

### Added
- `$skill` prompt invocation: typing `$<name>` runs a bundled/loaded skill directly. A unique prefix resolves precisely (`$te` → `$team`); an ambiguous prefix lists candidates (`Ambiguous skill '$te'. Did you mean: $team, …`); and an unknown `$word` lists the available skills (prefix-first, then fuzzy-subsequence) instead of silently sending the typo to the model. `$UPPERCASE` env-var-style tokens (e.g. `$HOME`) pass through untouched.
- Per-session input-box border hue: each newly opened jeo session gets a distinct border color so several concurrent sessions are tellable apart at a glance, and cmd-mode (`!`) overrides it with a caution amber so entering the shell escape is unmistakable.

## [0.5.1] - 2026-06-14
_cmd-mode `!<command>` shell escape — run a shell command without engaging the agent._

### Added
- gjc-parity cmd-mode shell escape: typing `!<command>` at the prompt runs the command directly in the shell and prints its output WITHOUT engaging the agent or touching conversation history (a REPL-style shell escape). Because the user is explicitly driving their own shell, the deep-interview mutation guard — which gates the AGENT's tools — does not apply; bare `!` prints a short usage hint.

## [0.5.0] - 2026-06-14
_Performance: workspace-scan, workflow-state, and DNA-Claw HUD caches; plus a credential-safety fix that never wipes OAuth over an invalid config._

### Fixed
- A schema-invalid `config.json` no longer wipes stored OAuth / provider credentials: the invalid config falls back to defaults while the credential block is preserved, so a bad config edit can't silently sign you out of every provider.

### Changed
- Workspace-tree scan is now LRU-cached per resolved cwd (cap 32), so a long session that touches many trees (subagents, worktrees, cross-tree `/view`) neither re-scans the same directory nor grows the cache without bound.
- Per-skill workflow-state JSON reads are mtime + size-validated cached. The mutation guard reads the workflow lock before every mutating tool, so re-reading and re-parsing each call was wasteful; the cache stays cross-process-safe — a write from another process bumps mtime/size and invalidates it, so an active interview lock can never be missed.
- DNA Claw HUD frames are memoized (LRU-capped) keyed on every input that affects output (grand/unicode/cols/color/level/phase/frame). The live HUD cycles a fixed ~60-frame set at ~120ms, so the 2nd+ cycle is now O(1) lookups instead of recomputing per-line ANSI gradients — lower steady-state HUD CPU.

## [0.4.9] - 2026-06-14
_Live-frame width-clamp (content-sized height) replaces the constant-height approach, typed text shows during a running turn, and a docs/AGENTS refresh._

### Fixed
- Typed text now appears in the input box DURING a running turn — keystrokes entered mid-turn render live in the prompt box (and as a pending steering card) instead of staying invisible until the turn ends.
- Live-frame anchor drift: 0.4.8's constant-height padding could grow the reserve and drift the cursor anchor by one row, reintroducing a duplicate model bar mid-turn. The live frame is content-sized again, and every rendered line is width-clamped to the terminal width so a long line (e.g. the model bar with a deep cwd) can't soft-wrap into a second physical row and desync the differential renderer's 1-line = 1-row accounting — keeping completed cards visible in scrollback above the live frame.
- Renderer `reset()` → `insertAbove()` ordering now erase-line-clears the old frame rows the inserted block did not cover (`occupied = max(prev, coverRows)`), closing the remaining duplicate-model-bar / orphaned-border case.

### Changed
- Regenerated every directory `AGENTS.md` guide and pruned stale working docs (the rolling improvements log, promo assets, and one-off review/analysis notes) so the tracked docs reflect the current tree.

## [0.4.8] - 2026-06-14
_Live-frame stability: constant-height live turn, renderer self-heal off-by-one fix, and frame-safe child-stdout sanitizing — no more duplicate model bar or torn escapes._

### Fixed
- The live turn now renders at a CONSTANT height: the in-flight tool-output / thinking block reserves a fixed row count (bottom-anchored, blank-padded at the top) and the whole frame is padded to exactly the terminal's rows. Streaming stdout growth no longer thrashes the frame height every 100ms — the height change that desynced the differential renderer and duplicated the model bar is gone.
- Renderer self-heal reset now remembers how many rows are physically on screen (`coverRows`), so a repaint of a SHORTER frame erase-line-clears the rows it no longer covers — fixing the persistent off-by-one that left a duplicate model bar / orphaned borders after a reset.
- Raw child stdout is sanitized before entering the live frame (`sanitizeForFrame`): carriage returns, erase-line/cursor-move escapes, OSC sequences, and incomplete trailing escapes are stripped (SGR color kept) so a streaming `bun test`'s `\r\x1b[2K` progress lines can no longer tear the renderer's own `\x1b[2K` (printing a literal "2K") or hijack the cursor.

## [0.4.7] - 2026-06-14
_Detached subagents + `subagent` control tool, live shaded in-flight output, registry-driven providers, fuller `read` budget, styled italics in the final report, and `gjc` retired._

### Added
- Detached subagents: `task {detached:true}` launches a background subagent and returns immediately; a new `subagent` control tool lists, inspects, awaits (optionally bounded), and cancels them (gjc parity, in-process turn-scoped registry — `cancelAll()` on teardown prevents background-promise leaks).
- Live shaded in-flight output: the running tool's stdout (bash) and native thinking deltas stream as a DIMMED bounded block above the status line, then flush UN-dimmed into scrollback once the model commits — gjc's "shaded until complete" effect.
- Update-check disk cache (`~/.jeo`): the update banner is instant from cache with a background refresh, and clears itself after an interim upgrade.

### Changed
- Provider registry bootstrap: `register-providers.ts` registers every built-in adapter; `model-manager` resolves adapters through the registry alone and no longer imports or names concrete providers — new built-ins register in one place.
- `read` default (no `lineRange`) now fills the model-visible output budget with WHOLE lines instead of a fixed 500-line cap, so a single read returns more of a file and forces far less needless pagination.
- Tool-output handling (model-visible budget, both-ends truncation, recoverable artifact spilling) extracted from `engine.ts` into `tool-output.ts`; `engine.ts` re-exports for compatibility.
- Final-report markdown: single `*italic*` / `_italic_` is now styled (list-bullet- and snake_case-safe), and a heading that follows content gets one blank line of breathing room above it.
- Mid-turn steering query now renders as a `user` card in scrollback; per-theme `userCard` palette and todo-card rendering refinements.

### Removed
- The `gjc` command and the bundled `gjc` skill — the skills catalog now ships five workflows (deep-interview, deep-dive, ralplan, team, ultragoal).

## [0.4.6] - 2026-06-14
_Width-correct forge cards for CJK/emoji, red borders on failed tool cards, aligned `ooo ralph` monitor HUD, and a per-theme user-card palette._

### Fixed
- Forge tool cards no longer tear their right border when the body contains CJK/Hangul/emoji: content wraps by DISPLAY width (wide glyphs count 2 columns) instead of code-point count, so a Korean line that previously rendered ~2× wide now stays inside the card at every width.
- The `ooo ralph` monitoring HUD box borders stay flush: every row is padded by display width (ANSI-aware) and the box auto-sizes to its widest row, replacing `String.padEnd` on colored strings that counted SGR escape bytes and spilled the right edge.

### Changed
- Failed forge tool cards now render with a red border (gjc-style state-encoded border) so failures pop out of scrollback at a glance; successful/neutral cards keep the theme accent identity.
- Every built-in theme now ships a `userCard` palette (accent/border/shadow/fill) for the mid-turn steering user card.
- `describeModel`/`resolveModelId` accept an already-read config to skip a redundant global-config read on the turn hot path.

## [0.4.5] - 2026-06-14
_First-class filesystem make/remove tools._

### Added
- `mkdir {dirPath}` tool: create a directory (parents included, idempotent) as a first-class tool instead of shelling out to `bash` — honors the deep-interview mutation lock and prefix-restricted roles.
- `delete {path, recursive?}` tool: remove a file (or a directory with `recursive:true`); refuses to wipe the working directory, treats a missing path as a soft error, and clears the file-freshness snapshot so a later write to the same path is not rejected as stale.

### Changed
- Read-only subagent lanes (planner/architect/critic) now also drop `mkdir`/`delete`, keeping review roles physically unable to mutate the repo.

## [0.4.4] - 2026-06-13
_Live subagent status mirroring, always-useful Ctrl+O activity tail, read lineRange crash guard._

### Added
- Per-turn activity-history ring (bounded at 200 plain-text entries): Ctrl+O now always answers "what has been happening" — the detail panel appends a timestamped `+N.Ns` recent-activity tail even before the first reply or tool detail exists.

### Changed
- The live status row now mirrors a delegated subagent's LATEST nested event (`EXECUTOR ✓ read src/…`) instead of a static `Task: executor …` title — a long `task` no longer reads as an opaque "calling model" stall.

### Fixed
- `read` no longer crashes with `spec.split is not a function` when the model passes a numeric/JSON `lineRange` (field bug, reproduced live twice): numbers are coerced, junk degrades to a polite selector error.

## [0.4.3] - 2026-06-13
_Readability pass for autopilot, subagent activity, and worked-history review._

### Added
- `jeo autopilot status` now renders a yellow ratchet status field with task, eval, score direction, keep/revert counts, patience, and the recommended next action.
- `/history` transcript output now adds turn headers and folds the first tool-result line into each tool activity row, so scrollback reads as user → activity → jeo instead of raw protocol traffic.

### Changed
- Subagent activity lines now render as an `AGENT` tree (`▸ ROLE`, `├─ ROLE`, `└─ ROLE`) in both TUI scrollback and non-TTY progress output for faster scanning.
- README command tables now call out `/history` and `autopilot` as first-class readable operation surfaces.
- Removed the standalone `jeo models` command/menu path; model discovery and assignment now stay inside `/model`, `/provider`, and setup/doctor flows.

## [0.4.2] - 2026-06-13
_Thinking-loop termination guarantees (cycle guard + turn wall-clock budget), unboxed live status without step counters, self-contained `.jeo` namespace, live next-prompt input card, role-targeted model/thinking picker._

### Added
- Agent-loop cycle guard: an A↔B tool-call ping-pong (re-reading one file ↔ re-running one command forever) now gets ONE corrective bounce, then a hard stop — the "stuck in thinking" spin the exact-repeat guard could never see.
- Turn wall-clock budget (`JEO_TURN_MAX_MS`, default 30 minutes, `0` disables): step budgets bound the COUNT of model calls, this bounds their total TIME — a turn that crosses it consolidates a wrap-up instead of spinning for hours.
- Live next-prompt input box in the TUI — text typed during a running turn stays in the same query surface instead of a separate queued row.
- jeo discovers skills from its own `~/.jeo/agent/skills` (+ project `.jeo/agent/skills`) and resolves hooks/rules under `.jeo` instead of referencing `.gjc`.
- Config-driven custom subagent roles: a non-bundled id declaring `title`/`description`/`prompt` becomes a first-class role at runtime.
- Ctrl+O mid-turn detail view: flush the full last reply + tool output into scrollback.
- `/fast [on|off|status]` slash command: enables minimal/low reasoning fast mode only when the active model advertises support.
- Task/team subagents now receive the same project context block as the parent agent, sourced from `JEO.md`, `AGENTS.md`, `.jeo/context.md`, `.agents/*`, and `.jeo/*` guidance — legacy `.gjc` context is not loaded.

### Changed
- Live status is UNBOXED: a flat `⠙ thinking · <live activity> ⟦esc⟧` row plus one dim metrics row replaces the bordered status box — the message is never trapped inside a border.
- Removed meaningless `step N/M` counters everywhere (status row, footer, plain-stream `[step N/M]` headers, nested subagent lines) along with step-driven `eta`/`evo %`: the dynamic step budget keeps extending the denominator, so the counters carried no information. The evolution stage track stays.
- Tool-call signature bookkeeping (repeat/cycle guards, step-budget novelty set) now stores fixed-size FNV digests instead of full JSON argument strings — a long turn's guard memory stays flat even when `write` calls embed whole file bodies.
- Unified model targeting: `/model` can now set default thinking, pick a model, apply it to the default agent or any subagent role, and set that target's thinking level in one flow.
- `/model` picker now shows DEFAULT/role badges with each target's thinking level, and the post-pick action menu uses the unified Set-as-role format plus an OpenAI Codex role preset.
- `/model` action selection now uses a Ralph-style nested sub-list: each DEFAULT/role header expands into selectable thinking rows, so target and thinking are chosen in one TUI screen.
- During a live reasoning turn, typed next-user text now renders as a styled pending `user` card with dark background while the normal input box remains editable.
- Update availability now renders as a yellow full-width field instead of a boxed card, matching the status-field TUI treatment.
- Removed the legacy `/models` slash-menu path; `/model` and `/provider` own interactive model selection.
- Canonicalized runtime naming on `.jeo` and `JEO_` only.

### Fixed
- jeo can no longer sit in "thinking" forever: every turn now terminates via the cycle guard, the wall-clock budget, or the existing step/repeat/failure guards — pathological spins consolidate a wrap-up instead of running unbounded.
- Ctrl-C now force-quits jeo immediately instead of being softened into an abort prompt.
- Done-time todo reconciliation gate — stale Todos can no longer survive a finished turn.
- MCP stdio framing for ralph tools.

## [0.4.1] - 2026-06-12
_TUI card parity polish + done-time todo reconciliation._

### Added
- gjc card parity: `⟦Ctrl+O for more⟧` clip hint, code highlighting in card bodies, and full tool output via Ctrl+O.

### Fixed
- Clip hint also covers summarize-stage markers.
- Done-time todo reconciliation gate so a finished turn's checklist reflects what actually completed.

## [0.4.0] - 2026-06-12
_Verified TUI, resilient engine, batch input, multilingual docs._

### Added
- Bracketed-paste batch input — a multi-line paste runs one command per line, in order (prompt_toolkit paste contract).
- jeo-ref transcript parity: Todo Write tree cards, line-numbered write previews, agent-name reasoning blocks, tree-style skill detail.
- Seed writer/parser round-trip integrity with a freeze-time assert.
- Slow-drip stream deadline + acceptance-criteria quality floor.

### Fixed
- Anthropic refusal recovery: context reset per the provider contract, neutral continuation note, OAuth/API-key guidance.
- Model discovery repaired against live endpoints (codex `client_version`, gemini pagination).

## [0.3.0] - 2026-06-02
_OAuth credentials + local Ollama provider._

### Added
- OAuth login (`jeo auth`) and a local Ollama provider.
- `jeo doctor`, multi-tool-call grouping, and CI/install hardening.

## [0.2.1] - 2026-06-02
_Setup and model configuration._

### Added
- `jeo setup` and `jeo models`; default Gemini 2.5-flash; verified real LLM turn.

## [0.2.0] - 2026-06-02
_Real LLM coding agent._

### Added
- Real LLM coding agent with provider + model configuration.

## [0.1.0] - 2026-06-01
_Initial release._

### Added
- Initial jeo-code agent and CLI.

[Unreleased]: https://github.com/akillness/jeo-code/compare/v0.4.5...HEAD
[0.4.5]: https://github.com/akillness/jeo-code/releases/tag/v0.4.5
[0.4.4]: https://github.com/akillness/jeo-code/releases/tag/v0.4.4
[0.4.3]: https://github.com/akillness/jeo-code/releases/tag/v0.4.3
[0.4.2]: https://github.com/akillness/jeo-code/releases/tag/v0.4.2
[0.4.1]: https://github.com/akillness/jeo-code/releases/tag/v0.4.1
[0.4.0]: https://github.com/akillness/jeo-code/releases/tag/v0.4.0
[0.3.0]: https://github.com/akillness/jeo-code/releases/tag/v0.3.0
[0.2.1]: https://github.com/akillness/jeo-code/releases/tag/v0.2.1
[0.2.0]: https://github.com/akillness/jeo-code/releases/tag/v0.2.0
[0.1.0]: https://github.com/akillness/jeo-code/releases/tag/v0.1.0
