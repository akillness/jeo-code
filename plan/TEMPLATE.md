# <NN> — <Feature> Plan

> One-line purpose. Keep every plan in this folder in **this exact section order** so
> future work (and agents) can read, diff, and extend them mechanically.

**Status:** `draft | planned | in-progress | shipped`
**Owner:** <who/agent> · **Last updated:** YYYY-MM-DD · **Tracking pass:** `docs/improvements.md §NN`

---

## 1. Goal
2–4 sentences. What this delivers and why. No vague adjectives — state measurable outcomes.

## 2. Current State (cite evidence)
Bullet the relevant code as it exists today. **Every structural claim cites a `file` or `file:symbol`.**
Example: `src/agent/engine.ts:runAgentLoop()` drives the tool loop and emits `AgentLoopEvents`.

## 3. Target State (gjc / pi-mono parity)
What "done" looks like, anchored to the reference implementations:
- **gjc** (`Yeachan-Heo/gajae-code`, `packages/<pkg>`): …
- **pi-mono** (`badlogic/pi-mono`, `packages/<pkg>`): …
- **joc** decision: which advantage we adopt, what we deliberately skip, and why.

## 4. Design & Architecture
Module layout (new files + edited files), data shapes/interfaces, control flow.
Prefer a diagram (ASCII) for non-trivial flows. Name the public surface explicitly.

## 5. Implementation Steps
Ordered, **bounded** slices (each ≤ ~3 files, parallelizable where disjoint). For each:
`Slice N — <title>`: files touched, the change, and the subagent it can be delegated to.

## 6. Acceptance Criteria (testable)
Checklist of **concrete, verifiable** outcomes (90%+ must be objectively checkable).
Example: `joc launch` renders a footer line showing `model · tokens · elapsed`, redrawn in place (no scroll spam).

## 7. Risks & Mitigations
Table: Risk → Severity → Mitigation. Every risk has a mitigation.

## 8. Verification Steps
Exact commands a reviewer runs to confirm acceptance (typecheck, `bun test`, e2e against mock/ollama).

## 9. Long-term / Future
What is intentionally deferred and the insertion point that keeps it cheap later.

## 10. Changelog
- YYYY-MM-DD — entry, linking the `docs/improvements.md` pass that shipped it.
