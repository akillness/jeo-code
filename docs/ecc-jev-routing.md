# ECC + Jev routing × Karpathy guidelines — jeo-code operation flow

Source analysis:

- `multica-ai/andrej-karpathy-skills` (MIT): one `CLAUDE.md` + one
  `skills/karpathy-guidelines/SKILL.md`, four principles —
  **Think Before Coding** (explicit assumptions, no silent picks, push back,
  stop when confused), **Simplicity First** (minimum code, no speculative
  abstractions), **Surgical Changes** (touch only the request, own-orphan
  cleanup only), **Goal-Driven Execution** (verifiable success criteria,
  test-first loops, per-step verify checks). Bias: caution over speed; trivial
  one-liners use judgment.
- **ECC** (`affaan-m/ECC`): external operating layer — inventory before
  mutation, exactly one install path per harness, preview-then-apply,
  provider-owned verification. Never two adapters for the same harness.
- **Jev control plane**: per-profile isolated routing — `route-skills`
  (top-k, gate 0.30 / fit 0.30, `sharded` vs `shortlist` strategy, advisory
  `routing` note), `prune-context`, `review`. Fail-closed on invalid config,
  fail-open on unavailable backends. Output is a proposal, never an
  auto-execution.

jeo-code mapping (this release):

| External concept | jeo-code implementation |
| --- | --- |
| Karpathy 4 principles | Bundled skill `karpathy-guidelines` (`src/prompts/skills/karpathy-guidelines/SKILL.md`) + always-on `KARPATHY_DISCIPLINE` block in `src/agent/engine.ts`, injected into `executorSystemPrompt()` and the interactive prompt in `src/commands/launch.ts` |
| Think-before-coding ambiguity gate | Existing `deep-interview` workflow reused at turn scope; no new gate |
| Goal-driven verification loop | Existing done-verification gate (`src/agent/loop-guards.ts` `classifyDoneGate`) — Karpathy text explicitly states a stale pass does not count |
| Jev `route-skills` | Heuristic advisory router `src/agent/skill-router.ts` (`routeSkillsForTask`, gate/fit 0.30, sharded/shortlist, top-k 3, fail-open explicit-none) |
| ECC single-harness inventory | `inventorySkillConflicts()` in the same module + JEO workflow-routing prompt lines (one identity/one source, report duplicates) |
| Skill invocation contract (unchanged) | Skills execute ONLY via `$skill` / skill chain; the router is advisory and never auto-executes, never changes the model |

Per-turn flow:

1. System prompt carries `WORKING_DISCIPLINE` + `KARPATHY_DISCIPLINE` +
   `OUTPUT_DISCIPLINE` + `VERIFICATION_DIRECTIVE`.
2. A turn needing a workflow skill is invoked explicitly (`$ralplan …`,
   `$team …`, `$deep-interview …`); `routeSkillsForTask()` may SUGGEST but
   never injects.
3. Code edits follow surgical-change discipline; every changed line traces to
   the request.
4. `done` passes `classifyDoneGate`: mutation requires a fresh passing
   verification signal; stale or hook-failing completions bounce (max 3
   corrections, then stop incomplete).
5. Skill duplicates across `skillDirs()` precedence resolve highest-wins; same
   normalized name from distinct paths is reported as an ECC conflict.
