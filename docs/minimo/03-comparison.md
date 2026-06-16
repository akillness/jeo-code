# 03 — Comparison: MiMo Code ⟷ jeo (per mechanism)

Verdict legend: **PORT** (adopt, high value) · **ADAPT** (adopt a jeo-sized version) ·
**HAVE** (jeo already covers it) · **SKIP** (not worth it for jeo now).

| MiMo mechanism | jeo today | Gap | Verdict |
|---|---|---|---|
| **Goal verifier** (`/goal`, independent judge at stop) | `onBeforeDone` self-judge + cycle/step guards + hooks | No user stop-condition; no independent verifier re-reading full transcript | **PORT** (P1) |
| **Checkpoint-writer subagent** (independent extractor, mid-session) | none — distill only at session end | No mid-session structured extraction; main agent would have to self-note | **PORT** (P2) |
| **Cycle + rebuild** (fresh window reseeded from files) | in-window token compaction (`maybeCompact`) | Lossy "simple compression"; no rebuild; long single sessions degrade | **PORT** (P2, pairs with writer) |
| **Early checkpoints** (≈20/45/70% budget, incremental) | compaction only when near budget | Extraction happens when the model is *least* able | **PORT** (part of P2) |
| **4-layer memory** (checkpoint / project / global / history) | single project `MEMORY.md` | No session layer, no scratchpad, no global layer, no searchable history | **ADAPT** (P3 — add session+scratch+global; promotion) |
| **`notes.md` scratchpad** (agent's only write channel) | none | Agent can't jot findings between checkpoints | **ADAPT** (P3) |
| **Upward promotion** (stable observation → MEMORY.md) | session-end distill merges everything | No staged promotion; everything or nothing at end | **ADAPT** (P3) |
| **Searchable history** (SQLite FTS5 raw trace + `history` tool) | JSONL sessions, no index, no tool | Can't trace back a detail not in structured memory | **ADAPT** (P4 — lightweight; SQLite optional) |
| **Dream** (7-day memory dedup/compaction) | session-end distill ≈ a mini-Dream | No scheduled cross-session maintenance | **ADAPT** (P4) |
| **Distill** (30-day pattern → skill/cmd/agent) | none (skills are hand-authored) | No automatic pattern→skill extraction | **ADAPT** (P4, opt-in) |
| **Max Mode** (best-of-N + judge) | single sample; ralplan critic is plan-level | No per-turn parallel sampling | **SKIP/LATER** — 4–5× tokens, experimental even in MiMo; jeo's value is local/cheap |
| **Dynamic Workflow** (orchestration as sandboxed JS) | `team`/`task` serial executor + workflows | No code-as-orchestration sandbox | **SKIP/LATER** — large; `team`+`task` cover jeo-scale needs |
| **Constrained CLI tool-call syntax** | JSON tool loop (`extractJsonObject`) | — | **SKIP** — orthogonal; jeo's JSON loop is robust enough |
| **Voice input** (TenVAD + ASR) | none | — | **SKIP** — out of scope |
| **Subagent infra** | `SubagentRegistry` + `task` tool | parity | **HAVE** (reuse for the writer) |
| **Project MEMORY.md (reviewable file, not vectors)** | `.jeo/memory/MEMORY.md` | parity in spirit | **HAVE** (extend, don't replace) |
| **Gated spec-first workflow (compose)** | deep-interview/ralplan/team/ultragoal | parity in spirit | **HAVE** |

## Why this ordering

1. **Goal verifier first (P1)** — smallest change, biggest correctness win, and it
   slots into jeo's existing `onBeforeDone` hook + ultragoal philosophy. Independent
   verification of a *user-stated* stop condition is exactly the kind of "real,
   blocking gate" jeo already advertises.
2. **Writer + cycle/rebuild (P2)** — the structural fix for long sessions. It
   replaces jeo's lossy in-window compaction with MiMo's "extract early, rebuild
   later" loop, and reuses the existing subagent infra + the just-added incremental
   persistence. Highest engineering cost, highest long-horizon payoff (MiMo's A/B
   shows the win appears past ~200 steps).
3. **Layered memory (P3)** — once the writer exists, adding session/scratch/global
   layers + promotion is incremental and makes the writer's output durable and
   reviewable.
4. **History + Dream/Distill (P4)** — quality-of-life and long-term signal hygiene;
   valuable but not blocking.

## jeo-specific constraints that shape the adaptation

- **Local-first, no heavy deps.** Prefer Markdown files + an optional lightweight
  index over a mandatory SQLite/vector service. (Bun ships `bun:sqlite`, so an FTS
  history is *available* with zero extra deps if we want it — see `04` P4.)
- **Reviewability is already a jeo value.** Keep memory as editable files.
- **Single process, inline TUI.** The writer subagent must run via the existing
  `task`/`SubagentRegistry` path and must NOT steal the main turn's token budget or
  corrupt the live frame (respect `sanitizeForFrame`, the differential renderer).
- **Don't double-implement gates.** The Goal verifier composes with — does not
  replace — `onBeforeDone`, cycle guards, and verification hooks.
- **No version bump for docs/dev-tools; product features ship per `05` phases.**
