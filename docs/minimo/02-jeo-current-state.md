# 02 — jeo's current memory, session & goal handling

Grounded in the actual source (paths relative to repo root). This is the baseline
the MiMo ideas in `04` build on.

## Stack
Bun + TypeScript, single-process CLI, inline TUI. State lives under `.jeo/`
(project) and `~/.jeo/` (global). Same runtime family as MiMo Code (OpenCode fork),
so the porting surface is conceptually close — jeo is just much smaller and
local-first by design.

## Memory — `src/agent/memory.ts`
- One file: **`.jeo/memory/MEMORY.md`** (`memoryFilePath(cwd)`).
- **Distilled at SESSION END** with a single model call that merges new learnings
  (repo facts, working commands, gotchas, user prefs) into the existing doc.
- Caps: on-disk `MEMORY_MAX_CHARS = 6_000`; per-session injection
  `MEMORY_INJECT_MAX_CHARS = 3_000`; distill transcript slice `12_000`. Skips
  sessions with `< 4` messages.
- Injected back into the system prompt next session (`memoryPromptSection`).
- Local-first; `JEO_NO_MEMORY=1` disables it.
- **Analog to MiMo's _project memory_ + a lightweight _Dream_ — but only at session
  end, single layer, single call.** No session-level checkpoint, no scratchpad,
  no mid-session writer, no global layer, no full-text index.

## Context / compaction — `src/agent/compaction.ts`
- Token estimation (`estimateTokens`, `historyTokens`, `accurateHistoryTokens`),
  `trimToolResultsInPlace`, `truncateRecentContentByTokens`.
- `maybeCompact(history, {...})` summarizes older messages in-window when the budget
  is hit; `appendCompaction(sessionId, seq, summary, replacesThrough, cwd)` records a
  compaction marker, and `/resume` reconstructs history applying those markers.
- **This is exactly the "simple compression" MiMo critiques**: it reinforces nearby
  and weakens distant info, compresses *in the same degrading window*, and cannot
  "look back on demand." There is **no rebuild into a fresh window**, and no
  structured early extraction.

## Session persistence — `src/commands/launch.ts`
- Sessions are **JSONL** files under `.jeo/sessions/<id>.jsonl`
  (`appendMessage`/`appendMessages`, `loadSession`, `listSessions`).
- `/resume` opens an interactive picker, loads a session, clean-restores the screen,
  replays a `formatTranscript` view, and seeds readline history.
- **Incremental persistence** was just added: `persistTurnTail()` flushes the user
  prompt immediately and each completed step via an `onStep` hook
  (`withStepPersistence`), so an interrupted turn is resumable. Cross-launch input
  history persists to `.jeo/input-history`.
- **No SQLite trace / FTS5**; "history" is the JSONL itself, with no full-text index
  and no `history` lookup tool. `formatTranscript` is a read-only viewer, not a
  searchable store.

## Completion / "goal" gating — `src/agent/engine.ts`
- `onBeforeDone(reason): string | null` — a **caller-owned, single** done gate (used
  for stale-todo reconciliation). Fires at most **once per turn**.
- **Mutation-without-verification pushback**: a turn that edited files but shows no
  verification signal gets one pushback before `done`.
- **Cycle / no-progress guards**: exact-repeat (`MAX_REPEAT`) and A↔B alternation
  (`CYCLE_WINDOW`) detection — one corrective nudge (surfaced via `onNotice`), then a
  hard stop; a **dynamic step budget** (`JEO_STEP_BASE`/`JEO_STEP_HARD_CAP`) extends
  on novel progress and consolidates when stalled.
- **Verification hooks** (`.jeo/hooks.json`): a post-edit tsc/eslint/test hook whose
  red output is fed back and blocks `done` until resolved.
- **Analog to MiMo's _Goal_ — but jeo's is self-judged and in-loop.** There is no
  *user-defined natural-language stop condition* and no *independent verifier model
  call* that re-reads the full transcript with the same context as the agent.

## Heavier gated workflows — `src/commands/{deep-interview,ralplan,team,ultragoal}.ts`
- **deep-interview** — Socratic ambiguity-scored interview → immutable seed under
  `.jeo/specs/` / `.jeo/state/`.
- **ralplan** — consensus planning with a **repo-grounded critic subagent** returning
  `[OKAY]`/`[ITERATE]`/`[REJECT]`, persisted and required by `jeo approve`.
- **team** — serial plan executor with run locks, per-task subagent contracts, a
  parent-side mutation audit, failed-task markers.
- **ultragoal** — durable multi-goal ledger; honest verification (suite runs once as
  a global signal).
- **These already embody MiMo's "compose / goal" spirit at the *workflow* layer**,
  but they are explicit, opt-in commands — not an always-on per-turn memory/goal loop.

## Subagents — `src/agent/{subagent-registry,subagent-tool,task-tool}.ts`
- `task` tool spawns subagents (incl. detached); `SubagentRegistry` tracks lifecycle,
  cancellation, background execution. **This is the building block a checkpoint-writer
  subagent would reuse.**

## What jeo already has vs. what's missing (preview of `03`)
- **Has**: project `MEMORY.md` (session-end distill), JSONL sessions + incremental
  persist + `/resume`, in-window compaction, a single in-loop done gate + cycle/step
  guards + verification hooks, subagent infra, gated spec-first workflows.
- **Missing (the MiMo deltas)**: mid-session **early checkpoints**, an **independent
  writer subagent** + single-writer invariant, **session/scratch/global memory
  layers** + upward **promotion**, **rebuild** into a fresh window, an **independent
  Goal verifier** with a user-set stop condition, a **searchable history** fallback,
  and periodic **Dream/Distill** maintenance.
