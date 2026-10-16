---
description: Karpathy-derived behavioral guardrails for coding turns — think before coding, simplicity first, surgical changes, goal-driven execution. Use when writing, reviewing, or refactoring code.
command: $karpathy-guidelines
when: When writing, reviewing, or refactoring code — to avoid wrong assumptions, overcomplication, orthogonal edits, and unverified completion.
---

# karpathy-guidelines

Behavioral guardrails derived from Andrej Karpathy's observations on LLM coding
pitfalls (wrong silent assumptions, hidden confusion, overcomplicated code,
orthogonal edits, weak success criteria). Source:
`multica-ai/andrej-karpathy-skills` (`CLAUDE.md` + `skills/karpathy-guidelines`).

**Tradeoff:** these guidelines bias toward caution over speed. For trivial tasks
(simple typo fixes, obvious one-liners), use judgment — not every change needs
the full rigor. The goal is reducing costly mistakes on non-trivial work.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State assumptions explicitly. If uncertain, ask rather than guess.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

In jeo terms: this is the `deep-interview` ambiguity gate applied at turn
scope. A `$deep-interview`-grade clarification belongs before code, not after
a mistaken implementation.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If 200 lines could be 50, rewrite it.

The test: would a senior engineer say this is overcomplicated? If yes,
simplify. Prefer boring, explicit code over clever constructions.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let the loop run independently. Weak criteria
("make it work") require constant clarification. In jeo this maps directly
onto the done-verification gate (`loop-guards.ts`): no mutation without a
passing test/build/typecheck signal, and a stale verification after a later
edit does not count.

These guidelines are working if: fewer unnecessary changes in diffs, fewer
rewrites due to overcomplication, and clarifying questions come before
implementation rather than after mistakes.
