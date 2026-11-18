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

Keep every step surgical and minimal: touch only the files the subgoal requires,
avoid speculative abstractions, clean up only orphans created by the step, and pass
concrete verification signals (not assumptions) to the next step.
