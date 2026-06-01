# jeoc ledger — event schema

The ledger is an **append-only JSONL** file at `.jeoc/ledger.jsonl`. One JSON
object per line. State is always derived by folding events in order; the log is
the single source of truth and is never hand-edited.

## Common fields

| Field | Type | Notes |
| --- | --- | --- |
| `ts` | ISO-8601 string | append time (UTC) |
| `type` | enum | one of the event types below |
| `planId` | string | the plan this event belongs to |

## Event types

### `plan_registered`
```json
{ "ts": "...", "type": "plan_registered", "planId": "G001", "title": "...", "brief": "..." }
```
`brief` is optional. Registers a plan into the cross-plan ledger.

### `plan_reviewed`
```json
{ "ts": "...", "type": "plan_reviewed", "planId": "G001", "status": "CLEAR", "evidence": "..." }
```
`status` ∈ `CLEAR | WATCH | BLOCK`. `BLOCK` halts execution until superseded.

### `goal_checkpointed`
```json
{ "ts": "...", "type": "goal_checkpointed", "planId": "G001", "goal": "g1", "status": "complete", "evidence": "..." }
```
`status` ∈ `complete | failed`. Aggregates GJC/ultragoal execution evidence; does
not mutate GJC goal state.

### `cleanup_swept`
```json
{ "ts": "...", "type": "cleanup_swept", "planId": "G001", "evidence": "..." }
```
Explicit cleanup pass. Required for a plan to reach `verified`.

### `pr_linked`
```json
{ "ts": "...", "type": "pr_linked", "planId": "G001", "pr": "https://github.com/owner/repo/pull/1" }
```

## Derived verdict

Folding events yields a per-plan verdict:

| Verdict | Condition |
| --- | --- |
| `verified` | review=CLEAR AND all goals=complete (≥1 goal) AND ≥1 sweep |
| `blocked` | latest review=BLOCK |
| `failed` | any goal=failed |
| `in_progress` | otherwise |
