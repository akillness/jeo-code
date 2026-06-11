# gjc ↔ jeo-code Diff & Feature Classification

Grounding: `gjc-source-inventory.md` (upstream gjc 0.4.3/0.4.4 — scoped native packages +
Rust crates), `jeo-code-inventory.md` (current jeo-code, pure-TS Bun), and
`runtime/runtime-observations.md` (live `gjc` vs `gjc --tmux` UI/UX). gjc = upstream
reference; jeo-code = focused pure-TS Bun reimplementation that keeps the concept.

**jeo-code concept (must be preserved):** pure-TS Bun, **zero native dependencies**,
single-binary `bun build --compile`; the evolution-forge TUI identity (ascii art, forge
boxes, 5-stage evolution, themes); the frozen method = deep-interview → ralplan →
ultragoal (+ team) with 4 role agents executor/planner/architect/critic.

Status legend: **PARITY** (jeo already matches) · **ALIGN** (close; refine to match) ·
**GAP** (gjc has, jeo lacks) · **OUT** (concept-divergent or out of scope for pure-TS).
Each row tagged `[perf]`/`[feature]`/`[ui-ux]`/`[usability]` and effort `[easy|med|hard]`.

---

## A. Already at parity (no work — confirms concept fidelity)

| Capability | gjc | jeo-code | Status |
|---|---|---|---|
| Inline (no alt-screen) live turn, native scrollback | `tui.ts`, alt=0 both modes | pass-888/889 reserve + insertAbove, alt=0 | **PARITY** |
| DECSET 2026 synchronized output | `tui.ts` | `renderer.ts` BSU/ESU | **PARITY** |
| Differential render (changed lines only) | render-from-first-changed | per-line diff `renderer.ts` | **PARITY** |
| glyph-first ✔/✗ ledger lines | tool check rows | pass-889 `app.ts` | **PARITY** |
| Live output-token rate `⤴ N/s` | HUD always | pass-889 `[STEP]` row | **ALIGN** (jeo: step row only; gjc: persistent HUD) |
| git branch + cwd in status | HUD `⑂ main ?1 / 📁` | footer `cwd (branch)` | **ALIGN** (jeo lacks dirty-flag `?N`) |
| Crustacean themes + appearance auto-detect | red-claw/blue-crab JSON + native detect | same names as evolution palettes + light/dark auto | **PARITY** (jeo: chalk palettes, not JSON schema) |
| 4 workflows + 4 agents, frozen method | deep-interview→ralplan→ultragoal+team | identical, native cmds + skills | **PARITY** |
| MCP server | runtime-mcp | `mcp/server.ts` (4 tools +pipeline) | **PARITY** (jeo smaller surface) |
| Model discovery + multi-provider | anthropic/openai/gemini/cursor/codex | anthropic/openai/gemini/antigravity/ollama live discovery | **PARITY** |
| OAuth flows (claude/codex/gemini/antigravity) | auth-broker/gateway | `auth/flows/*` all verifiedEndToEnd | **PARITY** |
| Sessions/resume/compaction/hooks | session + memory | `session.ts`/`compaction.ts`/`hooks.ts` | **PARITY** (jeo compaction fallback lossy) |
| team / tmux orchestration | gjc-runtime/team | `commands/team.ts` + `--tmux` | **PARITY** |
| todo tool + task subagents (fanout) | task/* | `todo-tool.ts` + `task-tool.ts` MAX_FANOUT=4 | **PARITY** |

---

## B. GAPS to adopt — concept-safe (pure-TS / Bun-primitive / pure-JS lib)

These fill real feature/usability holes or improve perf **without** native deps.

| # | Capability | gjc grounding | jeo gap | Tag | Effort |
|---|---|---|---|---|---|
| B1 | **Tokenizer-accurate context accounting** | native `countTokens` (tiktoken-rs) | jeo estimates tokens for compaction/`ctx%` heuristically | `[perf][feature]` | easy (pure-JS `js-tiktoken`/`gpt-tokenizer`) |
| B2 | **Output minimizer** (head/tail + test-runner noise filter) | native `MinimizerOptions/Result` | jeo head/tail truncates AND already spills full output to a `[raw: <path>]` pointer (engine.ts:162-376); real gap = test-runner noise filter only | `[perf][usability]` | easy-med |
| B3 | **Cost accounting `$` in HUD** + `(sub)` subagent marker | HUD `$0.42 (sub)` | jeo shows tokens, no $ cost | `[usability]` | easy (price table × usage) |
| B4 | **Auto-summarized turn title** in HUD **+ tmux pane-title sync** | HUD title + `π: Read and Summarize` pane title | jeo has no turn-title; `--tmux` sets no pane title | `[ui-ux][usability]` | med |
| B5 | **git dirty-flag in status** (`?N` uncommitted) | HUD `⑂ main ?1` | jeo footer shows branch only | `[ui-ux]` | easy |
| B6 | **Single-pass cached workspace scan at startup** | native `listWorkspace` + FS cache | jeo walks separately per context-file discovery | `[perf]` | med (Bun.Glob + cache) |
| B7 | **Bordered tool-result card alignment** ($cmd / Output divider / Timeout) | gjc Bash card | jeo forge boxes ≈ but no `$`-echo / `⟦Timeout⟧` row | `[ui-ux]` | easy (align forge box) |
| B8 | **Markdown table rendering** of assistant answers | tui `markdown` (marked) | jeo renders plain assistant text | `[ui-ux]` | med |
| B9 | **ANSI/Unicode-aware width/wrap helpers** (CJK/emoji/tab) | native `visibleWidth`/`wrapTextWithAnsi` | jeo `truncate()` handles SGR but not full CJK width/wrap | `[ui-ux]` | med (pure-JS width lib) |
| B10 | **Conservative bash fixups** before exec | native `applyBashFixups` | jeo runs command as-is | `[usability]` | med |
| B11 | **Retry fail-fast classes** (REMAINDER) | `~/.gjc/config.yml` budgets | jeo retry BUDGET already ships (state.ts:53-64 → ai/model-manager.ts resolveRetryOptions, tested); remainder = config-driven fail-fast class overrides + docs (touch: model-manager.ts, NOT retry.ts) | `[usability]` | easy |
| B12 | **Slash `(i/total)` counter** (REMAINDER) | slash palette `(1/33)` | jeo slash already has per-command descriptions + paginated overflow (slash.ts, tested); remainder = the `(i/total)` position counter only | `[ui-ux]` | easy |
| ~~B13~~ | ~~Worktree isolation `--worktree`~~ — **ALREADY PARITY, removed** | `commands/worktree.ts` | jeo ALREADY implements it: launch.ts:621-674 `resolveWorktree` (git worktree add) + runner.ts:284-308 + test/worktree.test.ts:54-105 (2 passing tests) | — | done |
| B14 | **Kill-ring / richer line editing** in REPL editor | tui `kill-ring.ts` | jeo input-box + autocomplete, no emacs kill-ring | `[ui-ux][usability]` | med |
| B15 | **Compaction fallback hardening** (don't drop to lossy placeholder) | memory-backend | jeo replaces history w/ placeholder on summary failure | `[usability]` | med |

---

## C. GAPS — feature-rich but heavier (route as optional / shell-out, concept-guarded)

Adoptable only via external CLI shell-out or optional deps; must NOT become a mandatory
native dependency (would break the zero-native-deps concept).

| # | Capability | gjc grounding | Route for jeo (pure-TS-safe) | Tag | Effort |
|---|---|---|---|---|---|
| C1 | **ast-grep structural search/edit tool** | native `astGrep/astEdit`, `pi-ast` | shell-out to `ast-grep`/`sg` CLI if present (optional tool) | `[feature]` | med |
| C2 | **ripgrep-class search** | native `grep` | optional shell-out to `rg`; else keep Bun search | `[perf][feature]` | easy |
| C3 | **PTY / interactive shell** | native `PtySession`, brush | jeo `Bun.spawn` pipes, NO PTY → interactive cmds fail; Bun has no native PTY → **concept tension** | `[feature]` | hard |
| C4 | **eval kernels (JS/Python)** | `eval/js`, `eval/py` | JS via Bun eval; Python via subprocess kernel | `[feature]` | med |
| C5 | **web search + readability→markdown** | `web/search`, `web/scrapers` | pure-JS readability/turndown libs (opt dep) | `[feature]` | med |
| C6 | **SIXEL inline images** | native `encodeSixel` | pure-TS SIXEL encoder + `Bun.Image` decode | `[ui-ux][feature]` | med |
| C7 | **jsdiff-compatible line diff + hashline fuzzy edits** | native `diffLines`+`h01/h02/h06` | pure-JS `diff` pkg; keep jeo's edit model | `[feature]` | med |

---

## D. OUT of scope (concept-divergent or disproportionate for pure-TS)

| Capability | gjc grounding | Why out |
|---|---|---|
| Vendored brush Rust shell | `brush-*-vendored`, `pi-shell` | core native-perf identity of gjc; jeo's concept is zero-native-deps |
| Per-ISA prebuilt `.node` (AVX2/baseline) | `@gajae-code/natives` | jeo has no native layer by design |
| LSP tool / DAP debugger | `lsp/*`, `dap/*` | large subsystems; low ROI vs concept; defer |
| Browser automation (puppeteer) | `coding-agent` puppeteer-core | heavy dep; conflicts single-binary compile |
| RPC/ACP/bridge remote-control modes | `modes/{rpc,acp,bridge}` | jeo covers external integration via MCP |
| Harness control plane (multi-tenant leases) | `harness-control-plane/*` | orchestration tier beyond jeo's scope |
| Agentic commit pipeline | `commit/*` | nice-to-have; defer |
| Stats dashboard (React/Chart.js SPA) | `@gajae-code/stats` | heavy frontend; Bun SQLite backend cheap but SPA isn't |
| STT / SSH / secrets / vim-mode / memories/hindsight | resp. dirs | breadth beyond focused method |
| `pi-iso` overlay isolation | `pi-iso` | git worktree (B13) covers the reviewable-isolation need without FFI |

---

## E. Headline conclusions for the consensus seed

1. **Concept is intact** — every core method/UX axis (A) is already at parity; the recent
   pass-888/889 inline-scrollback + glyph + tok/s work closed the most visible gjc-vs-joc
   UX gap. The user's original tmux mouse-wheel scrollback ask is **done**.
2. **The real lever now is the concept-safe B-list** — pure-TS/Bun wins that improve
   performance (B1 tokenizer, B2 minimizer, B6 cached scan, B9 width) and usability/UX
   (B3 cost, B4 turn-title+pane-title, B5 dirty-flag, B7 tool-card, B8 tables, B10 fixups,
   B11 retry config, B12 slash, B13 worktree, B14 kill-ring, B15 compaction).
3. **Native-perf parity (brush shell, AST/grep/sixel/diff natives) is explicitly NOT the
   goal** — jeo-code's differentiator is zero-native-deps. Adopt the *behavior* via pure-JS
   libs or optional CLI shell-outs (C-list), never a mandatory `.node`.
4. **Performance** improves most via B1 (accurate token budgeting → less wasteful
   compaction), B2 (smaller tool output → fewer tokens), B6 (one startup walk), B9 (correct
   width math → fewer re-renders) — all FFI-free.

---

## F. Consensus corrections (architect 12-ArchSeedConsensus, applied)

- **B13 removed** — `--worktree` is already implemented + tested in jeo-code
  (`launch.ts:621-674 resolveWorktree`, `runner.ts:284-308`, `test/worktree.test.ts`).
  This matrix and `jeo-code-inventory.md` originally omitted it (snapshot drift).
- **B11 / B12 rescoped to remainders** — retry budget config and slash
  descriptions/pagination already ship and are tested; only fail-fast-class overrides
  (B11) and the `(i/total)` counter (B12) are net-new. B11 touch-point is
  `ai/model-manager.ts`, not `retry.ts`.
- **B2 rescoped** — jeo already spills full tool output to a `[raw: <path>]` pointer
  (`engine.ts:162-376`); the real gap is the test-runner noise filter (no `artifact://`
  resolver is built — jeo has none).
- **B1 re-tagged** — the win is **token-efficiency / cost**, not CPU perf: a BPE
  tokenizer is slower than the char-heuristic and feeds the per-frame footer, so the seed
  guards it (lazy-load + memoize + heuristic-for-frame, accurate only at the compaction
  boundary).

> Correction also applies to `jeo-code-inventory.md` §3 (which omitted `--worktree`); the
> authoritative current-state note is here.
