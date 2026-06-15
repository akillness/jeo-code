# Changelog

All notable changes to **jeo-code** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The README mirrors the latest 5 entries — regenerate with `bun run changelog:sync`.

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
