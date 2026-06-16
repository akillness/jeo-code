# 01 — MiMo Code design summary

Source: the long-horizon engineering blog + the repo README
(<https://github.com/XiaomiMiMo/MiMo-Code>, TypeScript/Bun, a fork of OpenCode, MIT).
Same stack as jeo (Bun + TS), so the mechanisms below are portable in principle.

MiMo Code organizes its long-horizon design around three time scales:

| Time scale | Bottleneck | Theme |
|------------|-----------|-------|
| Single turn | decision quality | **Computation** |
| Multi-turn within a session | state continuity | **Memory** |
| Across sessions | distilling experience | **Evolution** |

The framing premise: *the model is stateless; all continuity is the runtime's job.*
Two failure modes drive everything: (1) the context window is eventually exhausted,
and naive summarization "reinforces nearby, weakens distant" info (a Mamba-like
"has state but can't look back" dilemma); (2) even with a big window,
instruction-following degrades as input grows ("lost in the middle").

---

## 2. Computation — scaling single-turn reasoning

### 2.1 Max Mode (parallel best-of-N)
Generate **N candidate plans in parallel** each turn (default N=5, temperature 1),
*reason + plan only, do not execute*; the same model acts as a **low-temperature
judge** and picks the most robust plan to actually run. +10–20% on SWE-Bench Pro at
~4–5× tokens. Experimental, opt-in (`experimental.maxMode`).

### 2.2 Goal — independent completion verification
The user sets a natural-language **stop condition** via `/goal` (e.g. "all tests
pass and the code is committed"). Whenever the agent tries to terminate, an
**independent model call** reviews the *full* conversation (same context + real tool
outputs as the agent) and decides if the condition is truly met. If not, it feeds
the **specific gap** back and the agent continues; truly-impossible tasks are marked
impossible. Because the verifier never did the work, it has no alignment bias toward
"already done." Observed: false-blocking > false-passing; infinite-loop prob < 0.5%;
auto-exit at a limit. Orthogonal to Max Mode (Max = parallel within a step; Goal =
serial self-check across the task).

### 2.3 Tool-call syntax
A *constrained* command-line tool-call syntax (no pipes/redirection/variable
expansion) costs fewer tokens and has fewer formatting errors than JSON/XML, because
models are trained on dense shell data. (Not yet migrated in MiMo; future work.)

### 2.4 Dynamic Workflow (orchestration as code)
For very large tasks (e.g. whole-project language migration) needing dozens/hundreds
of coordinated sub-agents, natural-language SKILL.md orchestration "systematically
fails" (compression swallows steps, branches/retries depend on model judgement,
non-deterministic). Instead the main agent **generates a JavaScript script** run
deterministically in a sandbox: `agent()` dispatches sub-agents, `parallel()` /
`pipeline()` / `workflow()` control concurrency and composition; each `agent()`
result is written to disk so the run **recovers from logs** after interruption.
Compatible with Anthropic's Dynamic Workflow semantics. Thesis: *when every step must
run, branches must be precise, and retries must be reliable, guarantee it with code,
not prose.*

---

## 3. Memory — state continuity across a long session

The goal: let a *logical* session extend indefinitely while each *physical* window
stays bounded.

### 3.1 Cycle — the unit of an unbounded session
Turns accumulate left-to-right; the window has a ceiling. Before the ceiling, the
runtime intervenes at fixed **checkpoints**, each dispatching an **independent writer
subagent** that reads the conversation so far and writes a structured state file to
disk (concurrently; the main agent keeps working). When the window nears the true
limit, the runtime does a **rebuild**: cut the window, open a fresh one, and
reconstruct context from the persisted files as seeds. From the model's view the
conversation never broke; from the runtime's view a new physical window began. One
checkpointed span ending in a rebuild = one **cycle**; a logical session is an
unbounded chain of cycles.

### 3.2 Why extract EARLY (counter-intuitive)
Don't wait until the window is nearly full. (a) Capability degrades under high
utilization ("lost in the middle") — asking for the most critical compression exactly
when compression ability is worst is a bad trade. (b) Extraction itself needs room:
at 95% there's no space to think; at 30% there's plenty. So checkpoints fire **far
below the ceiling — roughly 20%, 45%, 70%** of the configured budget, each an
*incremental* update to the prior (never a one-shot summary). The final rebuild near
the ceiling just *assembles* the accumulated structured records — not a rushed
compression.

### 3.3 Writer — an extractor independent of the main agent
**The main agent does NOT maintain its own memory.** Asking a model that is busy
debugging to also keep a structured log makes it do both worse. Extraction is moved
out of the main loop, triggered by the runtime, performed by an **independent writer
subagent** (own attention + token budget). The writer writes a fixed-structure
`checkpoint.md` — **11 fields**: current intent, next action, working constraints,
task tree, current work, involved files, cross-task discoveries, errors & fixes,
runtime state, design decisions, misc notes — and updates project memory when needed.
**Single-writer invariant**: exactly one actor may write each structured file
(prevents concurrent-write inconsistency), enforced at the code level (out-of-bounds
writes are rejected).

### 3.4 Four layers of memory
| Layer | File | Lifecycle |
|-------|------|-----------|
| Session memory | `checkpoint.md` | this logical session only; full working state |
| Project memory | `MEMORY.md` | persistent per-project: architecture, user rules, verified facts |
| Global memory | (global) | user-level prefs across projects |
| History | SQLite trace (unindexed raw) | every message/tool-call verbatim; fallback when structured memory lacks a detail (FTS5 full-text on top) |

Upper layers = refined/persistent/small; lower = complete/large/slow. The writer
**distills upward** (promotes an observation to `MEMORY.md` once it stabilizes across
multiple session checkpoints); history is the fallback below. The main agent has
**read-only** access to structured files — except **`notes.md`**, a session scratchpad
it may append to anytime; at each checkpoint the writer routes notes into the right
structured fields and clears it. `notes.md` is the agent's ONLY write channel.
Per-task `tasks/<id>/progress.md` logs track the tree tasks (`T1`, `T1.1`, …).

### 3.5 Rebuild injection
On rebuild, persisted files are assembled into a **layered prompt** with a per-section
token cap, in roughly this order: task list → session checkpoint → **verbatim slices
of recent user messages** (so the writer's rewriting can't drift from user intent) →
project memory → global memory → notes → an **index of memory file paths** readable on
demand → a tail reminder of what to do next. Even at every section's cap, total
injection stays ≈ **65K tokens** — well within any reasonable window. The agent
resumes work directly, without re-confirming the goal or re-reading processed files.

---

## 4. Evolution — improving from experience across sessions

### 4.1 Project memory (files, not vectors)
`MEMORY.md` (Markdown) persists across sessions: project background, user-specified
rules, architecture decisions + rationale, repeatedly-verified technical facts.
**Files over a pure vector DB for reviewability** — the user must see, delete, and
edit what was remembered; standard read/write tools manipulate it; a full-text index
sits on top for retrieval. The checkpoint writer can only write whitelisted paths
(enforced in code).

### 4.2 Maintenance — Dream & Distill
- **Dream** (every ~7 days): an independent agent reads historical sessions + the
  memory file and does merge / dedup / path-validity check / compression →
  a compact current-state representation; updates global memory.
- **Distill** (every ~30 days): an independent agent reads historical sessions for
  **process, not knowledge** — finds recurring work patterns and solidifies them into
  reusable **skills, CLI commands, custom agents, SOP docs**.

---

## 5. Evidence
- Offline: MiMo Code + MiMo-V2.5-Pro > Claude Code + Sonnet 4.6 on 3 benchmarks —
  but those measure *one-shot* repo issues; MiMo's memory/verification/evolution
  value shows mainly in real multi-turn use.
- Human double-blind A/B: 576 devs, 474 real private repos, 1,213 pairs. Win rate
  ≈ 50% under 200 steps, but **> 65% beyond 200 steps** — the advantage grows with
  task length. **This is the core thesis: long-horizon is where these mechanisms pay
  off.**

---

## Key takeaways for jeo (carried into `03`/`04`)
1. **Memory is a runtime loop, not a session-end afterthought** (checkpoints fire
   mid-session, early, incrementally).
2. **Separate the writer from the worker** (independent subagent; main agent is
   read-only except `notes.md`).
3. **Rebuild > compress** for unbounded sessions (reseed a fresh window from
   structured files instead of lossily summarizing in place).
4. **An independent Goal verifier** beats self-judged completion.
5. **Layered memory with upward promotion** + **periodic maintenance** (Dream/Distill)
   keeps signal-to-noise high over time.
6. Files (reviewable) + a full-text index, not opaque vectors.
