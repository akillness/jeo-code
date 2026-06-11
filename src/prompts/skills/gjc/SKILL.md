---
description: Main implementation process using gjc spec-first workflow.
command: jeo gjc "<request>"
when: When you need to perform significant code changes, refactoring, or feature development using the core gjc process.
---

# gjc (Gajae-Code Process)

Executes the primary code implementation workflow by leveraging the underlying `gjc` engine (jeoclaw).
This process manages the heavy lifting of code transformation, while the surrounding `jeo-code` ecosystem handles loop-level orchestration.

1. **Mutation Guard**: Ensures safe code writes by blocking operations until ambiguity is low (≤ 20%).
2. **Role Delegation**: Utilizes specialized subagents (architect, planner, executor, critic) for focused tasks.
3. **Loop Control**: Maintains a tight feedback loop between planning and execution.
4. **Verification**: Automatically runs verification steps after implementation to ensure correctness.
