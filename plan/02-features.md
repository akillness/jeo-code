# 02 — Features Plan (agent core, pipeline, sessions, MCP)

> The living roadmap for `jeo`'s functional surface: the agentic loop, the
> spec-first pipeline, persistence, and agent-facing integrations.

**Status:** `living` · **Last updated:** 2026-06-05 · **Tracking pass:** `docs/improvements.md §10–§22`

---

## 1. Goal
Keep `jeo` at gjc's workflow parity (clarify → plan → execute → verify) while
layering pi-mono's runtime ergonomics (persistent sessions, compaction, project
context). This doc enumerates what exists and the bounded next steps.

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
- 11 commands registered in `src/cli/runner.ts:COMMANDS`.

## 3. Target State (gjc / pi-mono parity)
- gjc: 26 commands incl. session/worktree/stats/web-search — jeo keeps a tight core (launch + 4 pipeline +
  setup/auth/doctor/mcp) and adds only high-leverage surfaces.
- pi-mono: full-fidelity sessions (every message incl. tool turns), compaction entries, skills/extensions.
- jeo decision: deepen the existing core; do **not** chase gjc's full command count.

## 4. Design & Architecture
All new work consumes existing seams: engine events (plan 01), session JSONL (`session.ts`), and the
lazy command registry (`runner.ts:COMMANDS`). Adding a command = one `commands/<name>.ts` + one registry entry.

## 5. Implementation Steps
- **Slice A — full-fidelity sessions**: persist intermediate tool-call turns (not just user+final reply)
  in `launch.ts`/`session.ts`; add a `compaction` entry type. → `executor`.
- **Slice B — `/compact` + `--max-steps`**: slash command calling `maybeCompact`; `--max-steps N` flag on launch. → `executor`.
- **Slice C — `jeo resume` top-level**: lift session resume out of `launch` into a first-class command. → `executor`.
- **Slice D — pipeline streaming via engine events** (depends on plan 01 M2): ralplan/team/ultragoal emit events for the TUI.

## 6. Acceptance Criteria (testable)
- [ ] After a 2-tool launch turn, the session JSONL contains the tool-call + tool-result entries (not only user+assistant).
- [ ] `/compact` in the REPL reduces in-memory history length and prints removed-count; `bun test` covers it.
- [ ] `jeo launch --max-steps 5` stops at 5 steps (asserted in a unit test against a mock that never calls done).
- [ ] `tsc` 0; `bun test` green (existing 34 + new).

## 7. Risks & Mitigations
| Risk | Severity | Mitigation |
|------|----------|-----------|
| Full-fidelity sessions bloat JSONL | Medium | cap per-entry size; rely on compaction; keep summaries |
| Pipeline event refactor regresses CLI output | Medium | keep `console.log` adapter as default; TUI opt-in (plan 01) |
| Command sprawl | Low | gate new commands on the "high-leverage core" rule in §3 |

## 8. Verification Steps
```bash
bun run typecheck && bun test
# e2e (ollama/qwen2.5:0.5b): jeo launch one-shot creates a file; session round-trips via --resume
jeo deep-interview "x" --auto && jeo ralplan && jeo team && jeo ultragoal   # pipeline still green
```

## 9. Long-term / Future
- Skills/extensions surface (pi-mono `docs/skills.md`); plan-mode; web-search tool; worktree command — all deferred.

## 10. Changelog
- 2026-06-05 — plan created (captures state through `docs/improvements.md §22`).
