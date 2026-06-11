# gem — Work Plans

Long-horizon planning for `gem`, the spec-first, Gemini-optimized coding agent that re-implements the gajae-code (`gjc`) and Ouroboros (`ooo`) workflow contracts. Every plan in this folder follows the unified template format so that the structure, workflow, and configurations are fully reusable across future iterations.

## Reference implementations
| Ref | Source | What we mine it for |
|-----|--------|---------------------|
| **gjc** | `Yeachan-Heo/gajae-code` | Socratic spec-first pipeline (`deep-interview` → `ralplan` → `team` → `ultragoal`), interactive dark/light crustacean TUIs, PKCE OAuth. |
| **ooo** | `Q00/ouroboros` | Spec-first loop (`init` → `run` → `status` → `evaluate`), persistent ralph loop, Textual TUI (`ouroboros tui monitor`), and `uv`/pip packaging. |
| **pi-mono** | `badlogic/pi-mono` | Lightweight JS/TS monorepo architecture, minimal tool loops, and `pi-tui` differential rendering. |
| **joc** | `jeo-code` | Pure-TypeScript / Bun implementation of the core loop, stateful `MutationGuard`, and stdio MCP server. |

## Plan index
| # | Plan | Scope | Status |
|---|------|-------|--------|
| 01 | [TUI](./01-tui.md) | `gjc` red-claw/blue-crab styled differential terminal UI on Bun (live spinners, token stream, footer, slash commands). | planned |
| 02 | [Features](./02-features.md) | Agent loop, spec-first ambiguity gate (≤0.2), full-fidelity session logging, and MCP server. | planned |
| 03 | [Install](./03-install.md) | Python/uv-installable package structure wrapping the Bun execution binary, supporting `pip install gem` and local development via `bun link`. | planned |
| 04 | [Model config](./04-model-config.md) | Route mapping (`google/`, `ollama/`, `openai/`, `anthropic/`), config and model aliases, thinking parameters, and endpoint probing. | planned |
| 05 | [Provider](./05-provider.md) | Real browser-based PKCE OAuth callback server (port 8085 for Gemini/Google Assist, 54545 for Anthropic, 1455 for OpenAI) + automatic refresh. | planned |

## Long-term roadmap (milestones)
```
M0  Core Foundations
    Hybrid project structure setup (`pyproject.toml` + `package.json`) · `uv`-managed Python wrapper with Bun-native execution binary.
        │
M1  TUI & Terminal Layer (01-tui)
    ANSI cursor/viewport control on Bun · Pure-TS differential layout renderer · Degrades to plain stream on non-TTY.
        │
M2  Spec-First Loop & Guards (02-features)
    Socratic interview command · Ambiguity scoring (≤0.2 gate) · Stateful `MutationGuard` blocking writes outside `.gem/`.
        │
M3  Planner & Executor Integration (02-features)
    Planner/Architect/Critic planning (`gem ralplan`) · Executor tool-calling engine (`gem team`) with json repair.
        │
M4  Real OAuth & Auto-Refresh (05-provider)
    Browser redirect PKCE flow via local `Bun.serve` callback server · Token rotation & lazy background refresh on resolver reads.
        │
M5  Model configuration & Probing (04-model-config)
    Interactive setup picker (`gem setup`) · Model alias manager (`gem models`) · Local Ollama model probing.
        │
M6  Distribution & Release (03-install)
    `bun build --compile` single binaries · Multi-platform target compilation · thin npm + Python pip packaging.
```

## Workflow conventions (how every plan gets executed)
1. **Ralph loop:** Execute → verify (mechanical + semantic) → record failure → adjust → repeat.
2. **Disjoint integration:** Outsource disjoint tasks to subagents; parent compiles, integrates, and enforces gates.
3. **Continuous gates:** Every slice must pass `bun x tsc -p tsconfig.json --noEmit` and `bun test` successfully.

## Configuration conventions
- **Global config:** `~/.gem/config.json` (chmod 600, override via `GEM_CONFIG_DIR`).
- **Per-project runtime:** `<cwd>/.gem/` containing `seeds/`, `plans/`, `state/`, and `sessions/`.
- **Hybrid tooling:** Python packaging via `pyproject.toml` (`uv`/pip) wrapping Bun entrypoint at `src/cli.ts` (exposes `gem`).
