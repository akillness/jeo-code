# 02 — Features Plan (agent core, pipeline, sessions, MCP, subagents)

> The living roadmap for `jeo`'s functional surface: the agentic loop, the
> spec-first pipeline, persistence, and agent-facing integrations.

**Status:** `living` · **Last updated:** 2026-06-12 · **Tracking pass:** `docs/improvements.md §10–§22` & `docs/subagent-improvements.md`

---

## 1. Goal
Keep `jeo` at gjc's workflow parity (clarify → plan → execute → verify) while
layering pi-mono's runtime ergonomics (persistent sessions, compaction, project
context) and a robust, role-based subagent system (executor, planner, architect, critic).

## 2. Current State (cite evidence)
- **Shared engine**: `src/agent/engine.ts:runAgentLoop()` — JSON tool-call loop, `DEFAULT_TOOLS`
  (read/write/edit/bash/find/search), `extractJsonObject` (`src/agent/json.ts`) recovery, invalid-JSON
  self-repair, unknown-tool feedback, 4k output truncation, and a **no-progress guard** (stops after 3
  identical calls).
- **Interactive agent**: `src/commands/launch.ts:runLaunchCommand()` — REPL + one-shot + non-TTY;
  bare `jeo` routes here (`src/cli/runner.ts:dispatch`).
- **Spec-first pipeline (gjc contract)**: `deep-interview.ts` (ambiguity gate, `--auto`), `ralplan.ts`
  (Planner/Architect/Critic prompt), `team.ts` (per-task executor on the engine), `ultragoal.ts`
  (acceptance verification). Artifacts under `<cwd>/.jeo/{seeds,plans,state}`.
- **Mutation guard**: `src/agent/tools.ts:assertMutationAllowed()` blocks writes/edits outside `.jeo/`
  during an active interview; `assertBashAllowed()` blocks bash too.
- **Sessions / compaction / context** (pi-mono): `src/agent/session.ts` (append-only JSONL,
  `--list`/`--resume`), `compaction.ts:maybeCompact()`, `context-files.ts:loadProjectContext()`.
- **MCP**: `src/mcp/server.ts` stdio JSON-RPC; 4 read-only tools + 4 pipeline tools behind `JEO_MCP_PIPELINE=1`.
- **Subagent System**: 
  - **Role Registry (`src/agent/subagents.ts`)**: Bundled roles (`executor`, `planner`, `architect`, `critic`) + custom roles via `config.subagents` (default read-only). Read-only roles have mutation tools stripped. 
  - **Execution Control (`src/agent/task-tool.ts`)**: Synchronous `task` tool with parallel fan-out (max 4 read-only) and serialized executor (concurrency 1). Steering broadcast hub (`createSteerHub`) for parallel runs.
  - **Detached Subagents (`src/agent/subagent-registry.ts`)**: `task {detached: true}` launches background runs controlled via `subagent` tool (`list`, `inspect`, `await`, `cancel`).
  - **Parent Audit**: Counts actual mutations (write/edit/mkdir/delete/bash) to verify subagent `done.reason` claims.
- 11 commands registered in `src/cli/runner.ts:COMMANDS`.

## 3. Target State (gjc / pi-mono parity)
- gjc: 26 commands incl. session/worktree/stats/web-search — jeo keeps a tight core (launch + 4 pipeline +
  setup/auth/doctor/mcp) and adds only high-leverage surfaces.
- pi-mono: full-fidelity sessions (every message incl. tool turns), compaction entries, skills/extensions.
- Subagents: Robust background execution, real-time status monitoring, result persistence, file-level locking for parallel mutations, and semantic validation of reports.

## 4. Design & Architecture
All new work consumes existing seams: engine events (plan 01), session JSONL (`session.ts`), and the
lazy command registry (`runner.ts:COMMANDS`). Adding a command = one `commands/<name>.ts` + one registry entry.
Subagent registry (`subagent-registry.ts`) manages background tasks and lifecycle binding.

## 5. Implementation Steps
- **Slice A — full-fidelity sessions**: persist intermediate tool-call turns (not just user+final reply)
  in `launch.ts`/`session.ts`; add a `compaction` entry type. (Shipped)
- **Slice B — `/compact` + `--max-steps`**: slash command calling `maybeCompact`; `--max-steps N` flag on launch. (Shipped)
- **Slice C — `jeo resume` top-level**: lift session resume out of `launch` into a first-class command. (Shipped)
- **Slice D — pipeline streaming via engine events**: ralplan/team/ultragoal emit events for the TUI. (Shipped)
- **Slice E — Subagent System Enhancements** (from `docs/subagent-improvements.md`):
  - **E1: Real-time TUI Status**: Render background subagent counts and status in TUI HUD/status bar.
  - **E2: Result Caching & Persistence**: Persist detached subagent history/reports in `.jeo/subagents/` JSON files.
  - **E3: Fine-grained File Locking**: Analyze target paths and allow parallel mutations on disjoint files.
  - **E4: Semantic Done-Reason Validation**: Use rules/LLM to verify that report sections contain actual substance.
  - **E5: Steering for Detached Subagents**: Add message queue to steer background subagents live.

## 6. Acceptance Criteria (testable)
- [x] After a 2-tool launch turn, the session JSONL contains the tool-call + tool-result entries (not only user+assistant).
- [x] `/compact` in the REPL reduces in-memory history length and prints removed-count; `bun test` covers it.
- [x] `jeo launch --max-steps 5` stops at 5 steps (asserted in a unit test against a mock that never calls done).
- [x] `tsc` 0; `bun test` green.
- [ ] Detached subagent status is visible in TUI HUD without manual `subagent list` calls.
- [ ] Detached subagent results survive session restarts via `.jeo/subagents/` persistence.
- [ ] Parallel execution of two mutating tasks on different files is allowed, while same-file tasks are serialized.

## 7. Risks & Mitigations
| Risk | Severity | Mitigation |
|------|----------|-----------|
| Full-fidelity sessions bloat JSONL | Medium | cap per-entry size; rely on compaction; keep summaries |
| Pipeline event refactor regresses CLI output | Medium | keep `console.log` adapter as default; TUI opt-in (plan 01) |
| Command sprawl | Low | gate new commands on the "high-leverage core" rule in §3 |
| File locking race conditions | High | Fall back to strict serialization if target paths cannot be statically determined |

## 8. Verification Steps
```bash
bun run typecheck && bun test
# e2e (ollama/qwen2.5:0.5b): jeo launch one-shot creates a file; session round-trips via --resume
jeo deep-interview "x" --auto && jeo ralplan && jeo team && jeo ultragoal   # pipeline still green
```

## 9. Long-term / Future
- Skills/extensions surface (pi-mono `docs/skills.md`); plan-mode; web-search tool; worktree command — all deferred.
- Advanced subagent coordination and hierarchical task decomposition.

## 10. Changelog
- 2026-06-05 — plan created (captures state through `docs/improvements.md §22`).
- 2026-06-12 — Updated with subagent system architecture, parent audit, and proposed improvements from `docs/subagent-improvements.md`.
