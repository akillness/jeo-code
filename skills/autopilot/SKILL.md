---
name: autopilot
description: >
  Run the jeo-code autopilot: an end-to-end autonomous build loop hardened with
  autoresearch ratcheting discipline. Use when the user invokes autopilot / full-auto
  and wants the agent to plan, implement, and verify a change while keeping only
  measured improvements. Unlike plain autopilot, every iteration freezes the
  evaluator, makes ONE bounded change, scores it, and keeps-if-improved or
  reverts-otherwise, logging every attempt append-only. Backed by the working
  `jeo autopilot` CLI. Triggers on: autopilot, jeo autopilot, ratchet build,
  keep-or-revert loop, frozen eval autopilot.
allowed-tools: Read Write Bash
metadata:
  tags: autopilot, autoresearch, ratchet, jeo, jeo-code, keep-or-revert, frozen-eval
  platforms: Gajae Code, Claude Code, Codex CLI, Gemini CLI, OpenCode
  source: jeo-code (rebrand of gajae-code)
  lineage: "fuses /skill:autopilot end-to-end build with /skill:autoresearch ratcheting"
---

# autopilot (jeo-code branch)

`jeo autopilot` is the autopilot end-to-end build loop **plus** autoresearch's
keep/revert ratchet. Plain autopilot says "QA passed → done". This branch says
"prove each change improved a frozen score, or revert it — and keep the evidence".

Branding: binary `jeo`, project `jeo-code`, state under `.jeo/` (rebrand of
`gjc` / `gajae-code` / `.gjc`).

## When to use

- The user invokes `autopilot` / full-auto for an end-to-end build or tuning task.
- Progress can be measured by a repeatable evaluator (test count, benchmark score,
  lint errors, `val_bpb`-style metric) or a pass/fail gate.
- You want regressions auto-reverted and every attempt recorded, not overwritten.

## Improvements carried over from /skill:autoresearch

1. **Freeze the evaluator.** Eval command + goal are recorded at `init` and are
   immutable for the session (changing them starts a new session, `--force`).
2. **Baseline before bravado.** A baseline score is mandatory before steps (min/max).
3. **One change per step.** The runner makes exactly one bounded change per iteration;
   no multi-change hero rewrites.
4. **Keep-if-improved / revert-otherwise.** Numeric ratchet (min/max) or gate. A
   non-improving or unscored attempt is reverted via the operator `--on-revert` hook.
5. **Append-only log.** `.jeo/autopilot/log.jsonl` keeps reverted attempts as evidence.
6. **Convergence + stop conditions.** Stops on no-improvement-in-`patience`-steps,
   runner failure, or max iterations — unifying autopilot's "3 failures" and
   autoresearch's plateau detection.

## The loop

```text
init (freeze eval)  ->  baseline  ->  [ mutate one change -> eval -> score
                                        -> keep if improved else revert
                                        -> append log ]  ->  converge / stop
```

## CLI (working)

```sh
# 1. freeze the contract
jeo autopilot init --task "make tests green" --eval "bash eval.sh" --goal min \
  [--timeout 300] [--patience 3]

# 2. record baseline (min/max goals)
jeo autopilot baseline

# 3a. manual step after you (or an agent) make ONE change
jeo autopilot step --change "use index for lookup" --on-revert "git reset --hard HEAD~1"

# 3b. or fully autonomous: runner makes one change each iteration
jeo autopilot loop --runner "bash mutate.sh" --max 20 --on-revert "git checkout -- ."

# 4. inspect
jeo autopilot status --json
```

### eval contract

- **min / max goals**: the eval command must print `score: <number>` (last match wins).
  `min` keeps lower scores, `max` keeps higher.
- **gate goal**: the eval command's exit code decides (0 = pass = keep, non-zero = revert).

## Rules

1. Never change the frozen eval mid-session; start a new session for a new metric.
2. One change per step — clean ablations beat mystery bundles.
3. Reverted attempts stay in the log; never rewrite history to hide them.
4. The engine owns the decision + ledger; destructive git ops only run via the
   operator-supplied `--on-revert` hook.
5. Stop on convergence or repeated failure instead of looping blindly.

## Relationship to gajae-code skills

- `autopilot` (upstream): end-to-end build, but "QA passed" acceptance.
- `autoresearch` (upstream): frozen-eval keep/revert ratchet for ML `train.py`.
- `jeo autopilot`: ratchet generalized to any build task with a frozen evaluator.

See `docs/04-autopilot-autoresearch.md` for the full design and naming map.
