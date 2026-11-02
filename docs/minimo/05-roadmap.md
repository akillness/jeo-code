# 05 — Roadmap, metrics, risks, non-goals

## Sequencing

```
P1 Goal transcript verifier (shipped; bounded) ──► P2 Checkpoint-writer + cycle/rebuild ──► P3 Layered memory ──► P4 History + Dream/Distill
                                                (L, proposed)                 (M, proposed)        (M, proposed)
```

- **P1 is shipped, with limits** — `/goal` is a separate LLM judgment over conversation/tool history plus a deterministic current-turn evidence gate. It does not independently inspect the workspace or verify the authenticity of tool/test output; the launch gate does not cover outstanding background jobs.
- **P2 is the proposed keystone** — the writer + rebuild loop; memory improvements depend on it. This remains planning, not shipped behavior. Ship behind `JEO_CHECKPOINTS=1`, soak on real long sessions, then default-on only after acceptance evidence.
- **P3 layers on P2** — needs the writer before adding session/scratch/global layers + promotion.
- **P4 is independent QoL proposal** — can be built any time after P3 (history index is standalone; Dream/Distill reuse `memory.ts`).

## Milestones / acceptance gates (per phase, all required)

| Phase | Ships when |
|---|---|
| P1 (shipped) | Existing transcript-judgment and current-turn evidence behavior; not proof of workspace correctness or test-runner authenticity, and does not gate outstanding background jobs. |
| P2 (proposed) | `buildRebuildSeed` + checkpoint-schema unit tests; live (`jeo --tmux`, forced-small budget): checkpoints fire at ~20/45/70%, a rebuild continues the task, kill→`/resume` restores from `checkpoint.md`; **tmux battery 6/6**, full suite green. |
| P3 (proposed) | layered-injection + promotion unit tests; live: a `note` reaches the next checkpoint's fields and is cleared; a thrice-seen fact promoted to `MEMORY.md`. |
| P4 (proposed) | FTS query test; `jeo dream` golden test (shrinks without dropping verified facts); `jeo distill` proposes a skill for a seeded pattern. |

## Success metrics (does this actually help?)

- **Long-session survival:** a scripted ≥150-step task completes without manual
  re-priming after a rebuild (today: in-window compaction degrades / loses intent).
- **Interrupt resumability:** kill at step K mid-session → `/resume` continues from
  the latest checkpoint with intent + task tree intact (P2 builds on the existing
  incremental persistence).
- **Premature-stop rate (future evaluation):** with `/goal` set, count of `done`s correctly blocked vs.
  false-blocks (track in `goal.json` verdict log; MiMo target: infinite-loop < 0.5%,
  false-blocking > false-passing — acceptable only within the actual gate's limits).
- **Memory signal-to-noise:** `MEMORY.md` size stays bounded across many sessions
  (Dream), and injected memory remains < its cap while still carrying the verified
  facts a fresh session needs.
- **No regression:** typecheck clean, full `bun test` green, `jeo --tmux` battery 6/6
  at every phase (jeo's standing bar).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Writer subagent steals the main turn's budget / latency | Independent token budget; runs concurrently; trigger early (low utilization) so it has room — MiMo's explicit design. |
| Live-frame corruption from concurrent writer output | Writer writes to disk only (no stdout in the live frame); main loop already uses `sanitizeForFrame` + differential renderer + self-healing resync. |
| Rebuild drifts from user intent | Inject **verbatim** recent user-message slices (MiMo's safeguard); keep `MEMORY.md` reviewable. |
| Goal verifier false-positive/false-negative (including misleading tool output) | Treat it as a transcript judge, not proof; preserve current-turn evidence gating and evaluate trusted-runner/workspace verification before expanding claims. |
| Scope creep into Max Mode / Dynamic Workflow | Explicit non-goals (below); `team`/`task` already cover jeo-scale orchestration. |
| Token cost of extra model calls (writer, verifier) | `/goal` verifier runs only when a goal is set and `done` is attempted; proposed writer/model calls need bounded budgets and explicit rollout gates. |
| Concurrent-write inconsistency | Single-writer invariant enforced by path whitelist (MiMo's simplest invariant). |

## Non-goals (deliberately NOT adopting now)

- **Max Mode (best-of-N + judge):** 4–5× tokens, experimental even in MiMo; conflicts
  with jeo's cheap/local-first stance. Revisit only if a benchmark shows it's worth it.
- **Dynamic Workflow (orchestration as sandboxed JS):** large surface; jeo's
  `team` + `task` + gated workflows already cover its scale. Revisit for
  whole-repo-migration-class tasks only.
- **Constrained CLI tool-call syntax:** jeo's JSON loop (`extractJsonObject`) is
  robust; not worth a migration now.
- **Voice input (TenVAD/ASR):** out of scope.
- **Mandatory SQLite/vector backend:** keep memory as reviewable Markdown; the FTS
  index (P4) is an optional, rebuildable cache via `bun:sqlite` (zero extra dep).

## How this lands (process)

- Planning docs (this folder) → review → **separate phased PRs** (P2, then P3/P4),
  each on its own branch off `dev`, each behind a flag, each with unit tests +
  live `jeo --tmux` verification, merged to `dev` then `main` per the repo's flow.
- P1 is already shipped; do not treat this planning sequence as evidence that P2–P4
  have been implemented.
- No version bump for these docs. Product phases bump per the normal CHANGELOG/release
  pattern when they default-on.
- Each PR cites the relevant section of `04-adoption-plan.md` as its spec.

## One-line recommendation
P1 is shipped as a bounded transcript judge, not independent verification. The next
planned investment is **P2**, subject to its acceptance gates; do not describe the
roadmap's proposed checkpoint/rebuild behavior as already implemented.
