---
name: jeo
description: >
  Run the jeo-line integration workflow over gajae-code: maintain a single
  cross-plan append-only ledger, gate plans through review before execution, and
  run an explicit cleanup (sweep) pass after execution. Use when work spans
  multiple plans / goals / PRs and needs one durable source of truth for
  ledger + review + cleanup, beyond a single ultragoal ledger. Triggers on:
  jeo, jeo ledger, cross-plan ledger, plan review gate, cleanup sweep,
  ledger review cleanup workflow.
allowed-tools: Read Write Bash
metadata:
  tags: jeo, ledger, review, cleanup, cross-plan, gajae-code, append-only
  platforms: Gajae Code, Claude Code, Codex CLI, Gemini CLI, OpenCode
---

# jeo — ledger / review / cleanup workflow

`jeo` is a thin layer over gajae-code (`gjc`). It does **not** reinvent the GJC
runtime; it adds one durable, cross-plan ledger and an explicit review→execute→cleanup
discipline. GJC's `ultragoal` owns a single durable plan's ledger; `jeo` aggregates
across many plans/PRs.

## When to use

- Multiple plans or goals run in parallel and you need one source of truth.
- A plan must pass a review gate (CLEAR/WATCH/BLOCK) before execution proceeds.
- Completed work needs an explicit cleanup sweep, not just an inline finish step.

## The loop

```text
register  ->  review (gate)  ->  checkpoint goals  ->  sweep (cleanup)  ->  status
```

A plan is **verified** only when: review = CLEAR, all goals = complete, and at
least one cleanup sweep is recorded. The ledger is append-only; state is always
derived from events.

## Commands

The ledger CLI lives at `ledger/jeo-ledger.ts` (Bun, zero deps):

```sh
bun ledger/jeo-ledger.ts init
bun ledger/jeo-ledger.ts register <planId> --title "..." [--brief "..."]
bun ledger/jeo-ledger.ts review <planId> --status CLEAR|WATCH|BLOCK --evidence "..."
bun ledger/jeo-ledger.ts checkpoint <planId> --goal <id> --status complete|failed --evidence "..."
bun ledger/jeo-ledger.ts sweep <planId> --evidence "..."
bun ledger/jeo-ledger.ts link <planId> --pr <url>
bun ledger/jeo-ledger.ts status [--json]
```

## Rules

1. Never hand-edit `.jeo/ledger.jsonl`; only append via the CLI.
2. Do not checkpoint a goal `complete` without evidence.
3. Do not mark a plan done until `status` reports `verified`.
4. A `BLOCK` review halts execution until a later review supersedes it.
5. `jeo` does not mutate GJC goal state; checkpoint authority stays explicit.

## Relationship to gajae-code

- `ralplan` produces the plan; `jeo register` + `jeo review` record it durably.
- `ultragoal`/`team` execute; `jeo checkpoint` aggregates evidence across plans.
- The cleanup sweep is the explicit analogue of GJC's completion-gate cleanup pass.

See `docs/03-jeo-code-plan.md` and `ledger/schema.md` for the event model.
