# 05 — Roadmap, metrics, risks, non-goals

## Sequencing

```
P1 Goal verifier ──► P2 Checkpoint-writer + cycle/rebuild ──► P3 Layered memory ──► P4 History + Dream/Distill
   (S–M, low risk)      (L, core, behind flag)                  (M)                   (M, opt-in)
```

- **P1 ships first** — smallest, independent, immediate correctness win; no
  dependency on the rest.
- **P2 is the keystone** — the writer + rebuild loop; everything memory-related
  depends on it. Ship behind `JEO_CHECKPOINTS=1`, soak on real long sessions, then
  default-on.
- **P3 layers on P2** — needs the writer to exist before adding session/scratch/global
  layers + promotion.
- **P4 is independent QoL** — can be built any time after P3 (history index is
  standalone; Dream/Distill reuse `memory.ts`).

## Milestones / acceptance gates (per phase, all required)

| Phase | Ships when |
|---|---|
| P1 | `goal-verifier` unit tests green; live: a goal blocks a premature `done` with the gap, then allows when met; re-block cap proven. |
| P2 | `buildRebuildSeed` + checkpoint-schema unit tests; live (`jeo --tmux`, forced-small budget): checkpoints fire at ~20/45/70%, a rebuild continues the task, kill→`/resume` restores from `checkpoint.md`; **tmux battery 6/6**, full suite green. |
| P3 | layered-injection + promotion unit tests; live: a `note` reaches the next checkpoint's fields and is cleared; a thrice-seen fact promoted to `MEMORY.md`. |
| P4 | FTS query test; `jeo dream` golden test (shrinks without dropping verified facts); `jeo distill` proposes a skill for a seeded pattern. |

## Success metrics (does this actually help?)

- **Long-session survival:** a scripted ≥150-step task completes without manual
  re-priming after a rebuild (today: in-window compaction degrades / loses intent).
- **Interrupt resumability:** kill at step K mid-session → `/resume` continues from
  the latest checkpoint with intent + task tree intact (P2 builds on the existing
  incremental persistence).
- **Premature-stop rate:** with `/goal` set, count of `done`s correctly blocked vs.
  false-blocks (track in `goal.json` verdict log; MiMo target: infinite-loop < 0.5%,
  false-blocking > false-passing — acceptable as long as the hard cap bails out).
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
| Goal verifier false-blocking (env-flaky tests) | Hard re-block cap → auto-allow with a logged note; verifier sees real tool outputs, not a rewritten summary. |
| Scope creep into Max Mode / Dynamic Workflow | Explicit non-goals (below); `team`/`task` already cover jeo-scale orchestration. |
| Token cost of extra model calls (writer, verifier) | Both are bounded, opt-in/flagged, and early-triggered; far cheaper than Max Mode's 4–5×. |
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

- Planning docs (this folder) → review → **separate phased PRs** (P1, then P2…),
  each on its own branch off `dev`, each behind a flag, each with unit tests +
  live `jeo --tmux` verification, merged to `dev` then `main` per the repo's flow.
- No version bump for these docs. Product phases bump per the normal CHANGELOG/release
  pattern when they default-on.
- Each PR cites the relevant section of `04-adoption-plan.md` as its spec.

## One-line recommendation
Start with **P1 (Goal verifier)** — it's small, composes with jeo's existing gates,
and delivers MiMo's most quotable long-horizon safeguard ("don't stop until the
user's condition is independently verified") with minimal risk. Then commit to
**P2** as the real long-horizon investment.
