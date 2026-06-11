# Problem Statement: Complete Remaining Code-Review Punch-List Items P2-7 and P2-10

## Concrete Problem Statement
The `jeo-code` repository has two outstanding code-review punch-list items that need to be addressed:
1. **P2-7: Mitigate done.reason verdict spoofing in chained subagent output**
   - When a subagent finishes its task, it returns a `done.reason` string. If this string contains forged verdict markers (e.g., `[OKAY]` or `Architectural Status: CLEAR`), the parent agent might mistake these markers for instructions or a gate verdict.
   - We need to ensure that the subagent's `done.reason` echoed back to the parent agent is wrapped in a fenced DATA block labeled as report data (not instructions), and any fence-delimiter sequences inside the echoed reason are neutralized so the fence cannot be broken from inside.
2. **P2-10: Extract PlanSchema + YAML parser into src/agent/plan.ts**
   - Currently, `StepSchema`, `PlanSchema`, `normalizePlanShape`, and `parseYaml` are defined in `src/commands/team.ts`.
   - We need to extract these into a new module `src/agent/plan.ts` and update `src/commands/team.ts` and `src/commands/ralplan.ts` to import them from the new module.
   - We also need to update `test/team-schema.test.ts` to import from `src/agent/plan.ts` and ensure all tests pass.

## Specific Goals
- **Goal 1 (P2-7):** Update `src/agent/task-tool.ts` to wrap the subagent `done.reason` in a fenced DATA block labeled as report data, not instructions. Neutralize fence-delimiter sequences (e.g., `<<<` and `>>>`) occurring inside the echoed reason.
- **Goal 2 (P2-7):** Add/update tests in `test/task-tool.test.ts` to assert the fenced wrapper and delimiter neutralization.
- **Goal 3 (P2-10):** Create `src/agent/plan.ts` and export `StepSchema`, `PlanSchema`, `normalizePlanShape`, and `parseYaml` with behavior identical to the previous `team.ts` implementations.
- **Goal 4 (P2-10):** Update `src/commands/team.ts` and `src/commands/ralplan.ts` to import these from `src/agent/plan.ts`. Remove the definitions from `team.ts`.
- **Goal 5 (P2-10):** Update `test/team-schema.test.ts` to import from `src/agent/plan.ts`.
- **Goal 6 (Verification):** Ensure `npm run build` exits 0 and `npm test` passes with 0 failures.

## Constraints
- Do not change the behavior of the schema validation or YAML parsing.
- The fence-delimiter sequences `<<<` and `>>>` must be neutralized (e.g., replaced with `‹‹‹` and `›››` or similar safe characters) to prevent breaking the fence from inside.
- The subagent report must be clearly labeled as report data, not instructions.
- All existing tests must continue to pass.
