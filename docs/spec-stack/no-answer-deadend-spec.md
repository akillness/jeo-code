# Spec — Eliminate "no-answer" dead-ends in jeo workflow stages

> Document SSOT (spec-kit layer). The execution SSOT is the frozen seed at
> `.jeo/seeds/seed-no-answer-deadends.yaml`. Direction is one-way:
> this spec → seed. If requirements change, edit this file first, then re-freeze.

## Constitution (non-negotiable principles)

1. **Every terminating workflow stage must surface a user-visible answer.**
   A stage may fail, but it must never reach a terminal state that leaves the
   user with no message explaining the outcome.
2. **Status signals must not contradict the artifact.** A "complete" /
   "crystallized" / "handoff-ready" signal may only fire when the durable
   artifact it implies (frozen seed, approved plan) actually exists.
3. **Work that is discarded must be reported as discarded**, never silently
   dropped while a stale failure reason masks it.

## Background

A read-only deep-dive of jeo's Spec-first loop
(`deep-interview → ralplan → approve → team → ultragoal`) found three stages
that could terminate without delivering an answer to the user. The engine core
(`src/agent/engine.ts`) was verified to always return a `doneReason`; the gaps
were at the caller/workflow layer. This spec captures the contract those three
stages must now satisfy and the machine-checkable evidence that proves it.

## Scope

| In scope | Out of scope |
|----------|--------------|
| `src/commands/team.ts` subagent report surfacing | engine core loop exits (already verified) |
| `src/commands/deep-interview.ts` freeze handoff signalling | new TUI rendering of reports |
| `src/commands/ralplan.ts` `[ITERATE]` revision reporting | `ultragoal` verification strength (separate concern) |

## Requirements & machine-checkable acceptance criteria

### R1 — team surfaces the subagent's real report
- **R1.1** `executeTaskWithAgent` routes all lifecycle/result output through the
  injected `log()` sink (the same sink that honors `opts.io.output`), not raw
  `console.log`. *Check:* `grep -c "console.log" src/commands/team.ts` returns
  `0` inside `executeTaskWithAgent`.
- **R1.2** On a successful subagent task the user sees the report body, not only
  a "finished" status line. *Check:* `src/commands/team.ts` contains a
  `"<role> report:"` header followed by emission of every line of `reason`.
- **R1.3** Existing team suites stay green. *Check:* `bun test test/team-run.test.ts
  test/team-schema.test.ts test/team-subagent.test.ts` → 0 fail.

### R2 — deep-interview never falsely reports "complete"
- **R2.1** `freezeSeed` returns a boolean success signal (`Promise<boolean>`).
  *Check:* `grep "freezeSeed = async" src/commands/deep-interview.ts` shows
  `Promise<boolean>`.
- **R2.2** `[Handoff Ready]` / `onProgress(phase:"complete")` fire only when the
  seed actually froze; on failure the interview emits a `[HOLD]` message and
  stays open. *Check:* a `if (!frozen)` branch logs `[HOLD]` and continues.
- **R2.3** deep-interview suites stay green. *Check:*
  `bun test test/deep-interview.test.ts test/deep-interview-noninteractive.test.ts`
  → 0 fail.

### R3 — ralplan reports discarded `[ITERATE]` revisions
- **R3.1** When a critic-requested revision is not schema/role-valid, the run
  logs an explicit "revision discarded; the [ITERATE] verdict stands" message
  instead of silently surfacing only the unchanged verdict. *Check:*
  `grep "discarding the revision" src/commands/ralplan.ts` matches.
- **R3.2** Workflow-integrity + ralplan/approve suites stay green. *Check:*
  `bun test test/workflow-integrity.test.ts test/approve.test.ts
  test/parse-role-gate-verdict.test.ts` → 0 fail.

### R4 — global regression gate
- **R4.1** `bun run typecheck` exits 0.
- **R4.2** The combined targeted suite reports `0 fail`.

## Tool constraints (the "hands")

- Verification harness is the native Bun toolchain: `bun run typecheck` (tsc)
  and `bun test`. CLI-Hub has no harness for pure-TypeScript unit verification,
  so registry-before-generation resolves to "use the contracted bun runner."
- No external software backend is involved; pattern is full-stack adapted to a
  code-only target (cli-anything layer = the bun test runner).

## Definition of done

All of R1–R4 acceptance checks pass and the evidence is recorded in
`docs/spec-stack/verification.md`.
