---
description: Planner/Architect/Critic blueprint from the seed.
command: jeo ralplan
when: When requirements are clear (e.g. from deep-interview) and you need a robust execution blueprint.
---

# ralplan

Executes a multi-agent critique and planning process to generate a structured implementation plan.
Combines views from a Planner, an Architect, and a Critic to identify risks, define tasks, and specify files.
Saves the blueprint for execution.

When the roles disagree, do not collapse the split to a single verdict: record each
contested decision with the competing options and their rationale, and flag the points
that need a human judgment call rather than auto-resolving them.

## Minimalism & Harness² Propose–Probe–Compose

- Trace every step directly to the frozen spec: no unasked features, speculative abstractions, or extra layers.
- Do not add a new role, skill, rule, hook, or harness component unless baseline evidence proves existing components cannot cover the gap.
- For prompt, skill, subagent, or harness updates, include an explicit baseline-vs-candidate probe and prompt-budget check before adopting (`Propose–Probe–Compose`).
