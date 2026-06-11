# 02 — Features Plan (agent core & spec-first loop for gem)

> The functional specifications for `gem`'s core loop, including the stateful spec-first
> pipeline (Clarify → Plan → Execute → Verify), session logging, compaction, and MCP tool interface.

**Status:** `planned` · **Owner:** Agent · **Last updated:** 2026-06-05 · **Tracking pass:** `docs/improvements.md §M2-M3`

---

## 1. Goal
Provide the complete spec-first workflow loop inside `gem` to prevent codebase changes before requirements are solidified. Enforce an ambiguity gate of ≤20% before writing code, protect the workspace with a stateful `MutationGuard`, log full-fidelity session execution, and expose the agent's capabilities via a standard Model Context Protocol (MCP) server.

## 2. Current State (cite evidence)
- `jeo-code/coding-agent/src/agent/engine.ts` implements a tool execution loop with basic self-repair.
- `jeo-code/coding-agent/src/agent/tools.ts:assertMutationAllowed()` blocks changes outside `.joc/` when deep-interview is active.
- `jeo-code/coding-agent/src/commands/` contains commands (`setup`, `auth`, `deep-interview`, `ralplan`, `team`, `ultragoal`, `doctor`, `mcp`).
- MCP server (`jeo-code/coding-agent/src/mcp/server.ts`) supports stdio JSON-RPC for helper tools.

## 3. Target State (gjc / pi-mono parity)
- **gjc** (`packages/coding-agent`): Exposes deep-interview, ralplan, team, and ultragoal. Tracks project state in `.gjc/state/`.
- **pi-mono**: Focuses on persistent session logs (`session.jsonl`), automated history compaction, and project context loader.
- **gem** decision: Combine the Socratic spec-first pipeline from `gjc` with the persistent sessions and compaction of `pi-mono`. Save all specs, plans, and session files under the `.gem/` project directory. Expose both read-only and pipeline-mutation tools via MCP.

## 4. Design & Architecture
Project files are written under the local `.gem/` folder:
```
<project-root>/.gem/
├── seeds/
│   └── seed-<slug>.yaml        # Frozen specification seed
├── plans/
│   └── plan-<slug>.yaml        # Planned task blueprint
├── sessions/
│   └── session-<id>.jsonl      # Full-fidelity session history
└── state/
    ├── deep-interview-state.json # Active interview details & ambiguity score
    ├── team-state.json         # Pending/completed task tracker
    └── ultragoal-report.md     # Verification test matrix
```

Key features:
1. **MutationGuard:** Intercepts `write`, `edit`, and `bash` calls. Blocks execution outside `.gem/` if `deep-interview-state.json` contains `active: true` and `current_ambiguity > 0.2`.
2. **Full-Fidelity Sessions:** Logs every user prompt, assistant thought, tool call, and tool result in an append-only `.jsonl` file.
3. **Compaction:** Automatically summarizes old turns when history exceeds the context window.
4. **MCP Server:** Launches stdio or SSE server, exposing `gem` actions to external clients (e.g. Claude Desktop).

## 5. Implementation Steps
- **Slice 1 — Stateful MutationGuard & Socratic Interface** (`src/agent/tools.ts`, `src/commands/deep-interview.ts`):
  Implement the ambiguity gate check (Goal, Constraints, Criteria). Block workspace writes until ambiguity drops to ≤0.2.
- **Slice 2 — Ralplan & Ultragoal Commands** (`src/commands/ralplan.ts`, `src/commands/ultragoal.ts`):
  Generate plan blueprint using Planner/Architect/Critic roles. Implement verification runner executing `bun test` or fallback commands, writing the report matrix.
- **Slice 3 — Full-Fidelity Sessions & Compaction** (`src/agent/session.ts`, `src/agent/compaction.ts`):
  Persist tool execution history to `session-<id>.jsonl` and implement token-based history compaction.
- **Slice 4 — MCP Integration** (`src/commands/mcp.ts`, `src/mcp/server.ts`):
  Expose `gem_execute_seed` and `gem_session_status` tools.

## 6. Acceptance Criteria (testable)
- [ ] Attempting to write a file outside `.gem/` while Socratic interview is active results in an immediate `[MutationGuard Blocked]` error.
- [ ] `gem ralplan` outputs a valid YAML plan containing a list of `steps` (verified by parsing).
- [ ] `gem ultragoal` executes the project test suite and writes a markdown report with `✅ PASSED` or `❌ FAILED` status.
- [ ] `session.jsonl` contains detailed records of tool calls and tool results.

## 7. Risks & Mitigations
| Risk | Severity | Mitigation |
|------|----------|-----------|
| Uncontrolled bash commands bypass the MutationGuard | High | Wrap the `bash` tool call; parse command strings for redirection (`>`) or piping, and assert that writes only target allowed folders. |
| Compaction loses vital context or constraints | Medium | Ensure the compaction prompt strictly preserves the frozen spec seed constraints and goal summaries. |

## 8. Verification Steps
```bash
bun x tsc -p tsconfig.json --noEmit
bun test test/engine.test.ts test/compaction.test.ts
# Pipeline verify
gem deep-interview "my project" --auto
gem ralplan
gem team
gem ultragoal
```

## 9. Long-term / Future
- Add a shared project context loader (`gem context`) that auto-registers related codebase files before planning starts.
- Implement multi-model consensus checks inside the ralplan critic gate.

## 10. Changelog
- 2026-06-05 — Plan drafted.
