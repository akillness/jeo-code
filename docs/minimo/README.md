# minimo — applying MiMo Code's memory & goal-management to jeo

This folder studies **MiMo Code** (Xiaomi's long-horizon coding agent, built on
OpenCode, MIT) and plans how to bring its **memory** and **goal-management**
ideas into **jeo** (this repo).

Primary sources studied:

- MiMo Code engineering blog — *"MiMo Code: Scaling Coding Agents to Long-Horizon
  Tasks"* (computation / memory / evolution): <https://mimo.xiaomi.com/blog/mimo-code-long-horizon>
- Korean summary — *"크로스 세션 메모리를 갖춘 오픈소스 AI 코딩 에이전트 MiMoCode 핵심 정리"*:
  <https://digitalbourgeois.tistory.com/m/3234>
- MiMo Code repo: <https://github.com/XiaomiMiMo/MiMo-Code>

> "minimo" = a **mini**mal, jeo-sized adoption of **MiMo** ideas. We do not clone
> MiMo; we port the few mechanisms that fix jeo's real long-horizon gaps, keeping
> jeo's local-first, no-heavy-deps, gated-workflow character.

## Reading order

| File | What it covers |
|------|----------------|
| [`01-mimo-code-summary.md`](01-mimo-code-summary.md) | MiMo Code's design in detail: computation (Max Mode, Goal, Dynamic Workflow), memory (cycle, checkpoint-writer, 4-layer memory, rebuild), evolution (Dream, Distill). |
| [`02-jeo-current-state.md`](02-jeo-current-state.md) | jeo's current memory / session / compaction / done-verification / workflows, grounded in actual files & functions. |
| [`03-comparison.md`](03-comparison.md) | Mechanism-by-mechanism comparison (MiMo ⟷ jeo): what jeo already has, what's missing, what to copy vs. skip. |
| [`04-adoption-plan.md`](04-adoption-plan.md) | The concrete proposal: each adopted mechanism with design, jeo integration points (files/symbols), data formats, effort, risk, and acceptance criteria. |
| [`05-roadmap.md`](05-roadmap.md) | Phasing, sequencing, milestones, metrics, risks, non-goals, and what we deliberately do NOT adopt. |

## TL;DR — the one-paragraph plan

jeo already has the *spirit* of MiMo's evolution layer (a session-end distilled
`.jeo/memory/MEMORY.md`) and a *single* in-loop done-gate (`onBeforeDone` +
cycle/step guards). What it lacks is MiMo's **mid-session, runtime-driven memory
loop**: jeo only distills at session end and only *compresses* in-window
(token-based compaction), so a long single session still degrades and a crash
mid-session loses the in-flight turn's structured state. The highest-value ports,
in order, are:

1. **Goal verifier** (MiMo §2.2) — a user-defined natural-language stop condition
   checked by an *independent* model call at `done`, distinct from jeo's
   self-judged `onBeforeDone`. (Small, high value, aligns with jeo's existing
   ultragoal/ralplan gate philosophy.)
2. **Checkpoint-writer + cycle/rebuild** (MiMo §3) — a runtime-triggered writer
   subagent that extracts a structured `checkpoint.md` *early* (≈20/45/70% of
   budget) and a **rebuild** that reseeds a fresh window from the layered files,
   replacing jeo's lossy in-window compaction for long sessions.
3. **Layered memory + promotion** (MiMo §3.4) — session `checkpoint.md` →
   project `MEMORY.md` → global, with a `notes.md` scratchpad as the agent's only
   write channel; jeo already has MEMORY.md, so this is mostly adding the
   session/scratch layers + promotion.
4. **Dream / Distill maintenance** (MiMo §4.2) — periodic memory dedup/compaction
   (Dream) and pattern→skill distillation (Distill), reusing jeo's skill system.

Max Mode and Dynamic Workflow are **lower priority / partial-skip** for jeo — see
`03` and `05` for the rationale.

## Status

Planning docs only — **no product code changes** in this folder. Implementation,
if approved, lands as separate phased PRs per `05-roadmap.md`.
