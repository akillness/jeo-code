---
description: Per-task executor loop against the plan.
command: jeo team
when: When you have a blueprint/plan and need to execute the concrete implementation tasks.
---

# team

Coordinates execution of individual tasks defined in the blueprint.
Spawns per-task executor subagents or loops to implement code changes.
Ensures task-level isolation and tracks implementation status.

Each task is a bounded subgoal: decompose large work into ordered subgoals, verify
one before starting the next, and feed the facts a failed task exposes into the
inputs of the following task instead of retrying the same approach unchanged.

