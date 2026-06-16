# 04 — Adoption plan (concrete, per phase)

Each phase is independently shippable. File/symbol references are to the current
repo. "Effort" is rough (S ≤ ~1 PR, M = 2–3 PRs, L = multi-PR). All phases keep
jeo's local-first, reviewable-files character.

---

## P1 — Independent Goal verifier (`/goal`)

**Idea (MiMo §2.2):** a user-defined natural-language **stop condition**, checked by
an **independent** model call whenever the agent tries to `done`. Distinct from the
self-judged `onBeforeDone`.

**Design**
- New command **`/goal <condition>`** (and `/goal` to show/clear) — stores the
  condition for the session under `.jeo/state/goal.json` (or in the session header)
  so it survives `/resume`.
- Hook into the existing **`onBeforeDone(reason)`** gate in `src/agent/engine.ts`
  (it already fires once per turn and can return a non-null nudge string).
- When a goal is set and the model calls `done`, run **one independent LLM call**
  (`callLlm`) with: the user's condition + the **same transcript context** the agent
  saw (reuse `formatTranscript`/history) + the actual recent tool outputs. Ask for a
  strict verdict: `MET` / `NOT_MET: <specific gap>` / `IMPOSSIBLE: <why>`.
  - `MET` → allow `done`.
  - `NOT_MET` → return the gap as the `onBeforeDone` nudge so the agent continues.
  - `IMPOSSIBLE` → allow stop but mark the goal impossible in the verdict log.
- **Bias control:** the verifier is a fresh call (no "I already did this" framing) and
  uses a low temperature. Cap the number of verifier re-blocks per turn/session
  (MiMo reports infinite-loop < 0.5%; jeo adds a hard cap → auto-allow after N to
  avoid the false-blocking trap, logging that it bailed).
- Compose with existing guards: verification hooks (`.jeo/hooks.json`) and the
  mutation-without-verification pushback still apply; the Goal verifier is an
  additional, user-opted gate.

**Integration points**
- `src/commands/launch.ts`: `/goal` command parsing; thread the condition into the
  `runTurn` → `onBeforeDone` wiring (where `withStepPersistence`/events are built).
- `src/agent/engine.ts`: nothing structural — the existing `onBeforeDone` contract
  already supports "return a nudge to keep going."
- New `src/agent/goal-verifier.ts`: pure-ish `verifyGoal(condition, transcript,
  toolOutputs, llm) → { verdict, gap? }` (LLM injected → unit-testable with a stub).

**Data format** — `.jeo/state/goal.json`: `{ condition: string, setAt, verdicts: [{ at, verdict, gap? }] }`.

**Effort:** S–M. **Risk:** low (additive; gated behind a set condition). **Acceptance:**
- `verifyGoal` unit tests: MET allows, NOT_MET returns the gap, IMPOSSIBLE allows+marks,
  re-block cap auto-allows after N.
- Live: set `/goal "tests pass"`, agent `done` before tests pass → continues with the
  gap; after passing → stops.

---

## P2 — Checkpoint-writer subagent + cycle/rebuild (the core)

**Idea (MiMo §3):** a runtime-triggered **independent writer** extracts a structured
`checkpoint.md` **early and incrementally** (≈20/45/70% of budget); near the ceiling
the runtime **rebuilds** a fresh window from the persisted files instead of
compressing in place.

**Design**
- **Budget triggers** in the turn loop (`src/commands/launch.ts` `runTurn`, using
  `historyTokens`/`accurateHistoryTokens` from `compaction.ts` + the model's
  `contextTokens`). At ≈20/45/70% of budget, dispatch the writer **once per
  threshold** (don't re-fire the same band).
- **Writer subagent** via the existing `task`/`SubagentRegistry` path
  (`src/agent/{task-tool,subagent-registry}.ts`), running **concurrently** with the
  main turn, with its **own token budget** (does not consume the main turn's). It
  reads the conversation-so-far and writes a fixed-structure
  **`.jeo/memory/<session>/checkpoint.md`** (MiMo's 11 fields, trimmed to what jeo
  needs: intent, next action, constraints, task tree, current work, files touched,
  cross-task discoveries, errors&fixes, runtime state, design decisions, notes).
  Incremental: each run updates the prior checkpoint, not a one-shot summary.
- **Single-writer invariant:** only the writer subagent writes structured files; the
  main agent is **read-only** except `notes.md` (see P3). Enforce by path-whitelisting
  the writer and never having the main loop write `checkpoint.md`.
- **Rebuild** near the ceiling: replace the current `maybeCompact` in-window
  collapse with a **reseed** — open a fresh history seeded by the layered injection
  (P2.5 below), keeping verbatim slices of recent user messages. The existing
  `appendCompaction` marker + `/resume` reconstruction logic is the closest current
  analog and can be extended, OR a new `rebuildContext()` builds the seed history.
- **Crash recovery:** because the writer persists to disk concurrently and we already
  have incremental turn persistence (`persistTurnTail`), an interrupted session can
  resume from the latest `checkpoint.md` + JSONL tail.

**Rebuild injection (P2.5)** — assemble persisted files into a layered seed with
per-section token caps, in MiMo's order: task list → checkpoint → verbatim recent
user-message slices → project MEMORY.md → (global) → notes → an index of readable
memory paths → a tail "what to do next" reminder. Keep the total ≈ a bounded budget
(MiMo uses ~65K; jeo can scale this to the active model's window, e.g. ≤ 25–40% of it).

**Integration points**
- `src/commands/launch.ts`: budget-trigger logic in `runTurn`; replace/augment the
  `maybeCompact` call site with checkpoint+rebuild; reuse `withStepPersistence` plumbing.
- New `src/agent/checkpoint.ts`: `checkpointPath(session,cwd)`, the writer prompt,
  `buildRebuildSeed(files, budget) → Message[]` (pure, unit-testable).
- `src/agent/subagent-tool.ts` / `task-tool.ts`: a dedicated "checkpoint-writer" role
  (read-only tools + write to the whitelisted path only).

**Effort:** L. **Risk:** medium–high (touches the hot turn loop + context assembly;
must not corrupt the live frame or steal the main budget). Mitigate by shipping
behind a flag (`JEO_CHECKPOINTS=1`) first, then default-on after the tmux battery +
long-session live tests pass. **Acceptance:**
- Unit: `buildRebuildSeed` ordering/caps; checkpoint field schema round-trips.
- Live (`jeo --tmux`): a forced-small budget triggers checkpoints at the bands; a
  rebuild continues the task without re-confirming the goal; kill mid-session →
  `/resume` restores from checkpoint. tmux battery stays 6/6.

---

## P3 — Layered memory + scratchpad + promotion

**Idea (MiMo §3.4):** session (`checkpoint.md`) → project (`MEMORY.md`) → global →
history; `notes.md` is the agent's only write channel; stable observations are
**promoted upward**.

**Design**
- Keep the existing `.jeo/memory/MEMORY.md` as the **project** layer (don't replace
  `memory.ts`; extend it).
- Add **session layer** = the P2 `checkpoint.md`.
- Add **`.jeo/memory/<session>/notes.md`** scratchpad — expose a tiny **`note` tool**
  (append-only) as the main agent's sole write channel; the writer routes notes into
  structured fields at each checkpoint and clears them.
- Add **global layer** `~/.jeo/memory/GLOBAL.md` (user prefs across projects),
  injected like `MEMORY.md` under its own cap.
- **Promotion:** when an observation recurs across ≥N session checkpoints, the writer
  promotes it from `checkpoint.md` to `MEMORY.md` (and project→global for user-level
  prefs). This generalizes the current session-end `memory.ts` distill into a staged,
  always-reviewable flow.

**Integration points**
- `src/agent/memory.ts`: add `loadGlobalMemory`/`globalMemoryPath`, layered
  `memoryPromptSection` (project + global), promotion helper.
- New `note` tool registered in the tool map (`src/agent/tools.ts` /
  `DEFAULT_TOOLS`), append-only, path-whitelisted.
- The injection order in P2.5 already places notes/global correctly.

**Effort:** M. **Risk:** low–medium. **Acceptance:** unit tests for layered injection
caps + promotion threshold; live: a `note` survives into the next checkpoint's
structured fields and is cleared; a thrice-seen fact lands in `MEMORY.md`.

---

## P4 — Searchable history + Dream/Distill maintenance

**Idea (MiMo §3.4/§4.2):** a raw searchable history fallback; periodic memory
maintenance (Dream) and pattern→skill distillation (Distill).

**Design**
- **History/search:** jeo already has JSONL sessions. Add an optional **`bun:sqlite`
  FTS5 index** (zero extra dep — ships with Bun) over message/tool-call text, plus a
  **`history` tool** the agent calls to trace a detail not in structured memory.
  Keep JSONL as the source of truth; the index is a rebuildable cache.
- **Dream** — extend `memory.ts`'s session-end distill into a scheduled
  **`jeo dream`** (and an idle/age trigger, e.g. "≥7 days since last"): read recent
  sessions + `MEMORY.md`, merge/dedup/validate file paths/compress, update global
  memory. Reuses the existing single-call distill machinery.
- **Distill** — new **`jeo distill`** (opt-in): scan recent sessions for recurring
  *process* patterns and propose new **skills** (jeo already has a skill catalog,
  `src/skills/`), CLI snippets, or subagent roles. Output is *proposed* artifacts the
  user reviews — never auto-installed (reviewability).

**Integration points**
- New `src/agent/history-index.ts` (`bun:sqlite`, optional, behind a flag).
- `src/agent/memory.ts`: factor the distill call so `jeo dream` reuses it.
- New `src/commands/{dream,distill}.ts`; skill emission via `src/skills/catalog.ts`.

**Effort:** M (history) + M (dream/distill). **Risk:** low (additive, opt-in).
**Acceptance:** FTS query returns the right message; `jeo dream` shrinks a bloated
`MEMORY.md` without dropping verified facts (golden test); `jeo distill` proposes a
skill for a seeded repeated pattern.

---

## Cross-cutting engineering notes
- **Flags first, default later.** Every phase ships behind an env flag
  (`JEO_GOAL`, `JEO_CHECKPOINTS`, `JEO_MEMORY_LAYERS`, `JEO_HISTORY_INDEX`) and only
  becomes default after live `jeo --tmux` verification + full suite + tmux battery.
- **Never steal the main turn's budget** — the writer subagent and the Goal verifier
  are independent calls with their own budgets (MiMo's central rule).
- **Single-writer invariant** is enforced in code (path whitelist), mirroring MiMo.
- **Reviewability** — everything is Markdown the user can read/edit/delete; the SQLite
  index is a derived cache, never the source of truth.
- **Verification is mandatory** per phase: unit tests for the pure helpers (inject a
  stub LLM / fixed budgets) + a live long-session `jeo --tmux` scenario. No phase
  yields without proof.
