# jeo-code (`joc`) — Work Plans

Long-horizon planning for `@jeo-code`, the pure-TypeScript/Bun coding agent that
re-implements the gajae-code (`gjc`) workflow contract and adopts pi-mono
(`badlogic/pi-mono`) advantages. Every plan here follows [`TEMPLATE.md`](./TEMPLATE.md)
so the structure, workflow, and configuration stay reusable across future work.

## Reference implementations
| Ref | Repo | What we mine it for |
|-----|------|--------------------|
| **gjc** | `Yeachan-Heo/gajae-code` (Bun + Rust + Python monorepo) | workflow contract (deep-interview → ralplan → team → ultragoal), provider/OAuth breadth, `packages/tui` |
| **pi-mono** | `badlogic/pi-mono` (TS monorepo: `pi-ai`/`pi-agent-core`/`pi-coding-agent`/`pi-tui`) | minimal 4-tool agent, append-only sessions, compaction, `pi-tui` differential rendering |

## Plan index
| # | Plan | Scope | Status |
|---|------|-------|--------|
| 00 | [TEMPLATE](./TEMPLATE.md) | the shared section format every plan uses | n/a |
| 01 | [TUI](./01-tui.md) | gjc/pi-tui-style terminal UI (differential render, streaming, footer, slash palette) | planned |
| 02 | [Features](./02-features.md) | agent loop, spec-first pipeline, sessions, MCP — roadmap | living |
| 03 | [Install](./03-install.md) | bun-native install (`bun link`), prebuilt binary, npm/Homebrew | partially shipped |
| 04 | [Model config](./04-model-config.md) | routing, `joc setup`, thinking level, registry/aliases | partially shipped |
| 05 | [Provider](./05-provider.md) | adapter interface, OAuth flows, local providers, transforms | partially shipped |

## Long-term roadmap (milestones)
Phases are ordered by dependency, not calendar. Each milestone ends at a green gate
(`tsc` 0 + `bun test` + an e2e against the mock or local Ollama) and a `docs/improvements.md` pass.

```
M0  Foundations (SHIPPED, passes 9–16)
    OAuth(PKCE)+refresh · providers+local · model routing · spec-first pipeline ·
    interactive `joc launch` · shared engine · sessions · compaction · project context ·
    bun-link install · no-progress guard
        │
M1  TUI core            → plan 01 §M1   (pure-TS differential renderer, TTY/no-TTY split)
        │
M2  Interactive TUI     → plan 01 §M2   (launch: streaming text + live tool list + status footer)
        │
M3  Input affordances   → plan 01 §M3   (slash-command palette + autocomplete, gjc parity)
        │
M4  Pipeline/doctor TUI → plan 01 §M4 + plan 02   (ambiguity meter, plan/exec progress, doctor table)
        │
M5  Distribution        → plan 03       (`bun build --compile` single binary; npm thin wrapper)
        │
M6  Provider breadth    → plan 05       (streaming tokens; Bedrock/Vertex/Copilot adapters; transform layer)
        │
M7  Model registry      → plan 04       (discovery, aliases, cost/usage tracking)
```

## Workflow conventions (how every plan gets executed)
1. **Ralph loop** — run → verify → adjust → repeat until the acceptance checklist passes; treat
   failures as data (see `/skill:ooo` ralph contract).
2. **Bounded subagent slices** — disjoint-file slices fan out to `executor` subagents; the parent
   integrates and runs all gates. Subagents never run verification/format.
3. **Verify before done** — `bun run typecheck` (`tsc -p tsconfig.json --noEmit`) + `bun test`,
   plus an e2e through the **installed** binary (mock OpenAI server and/or `ollama/qwen2.5:0.5b`).
4. **One pass = one doc entry** — record each shipped milestone in `docs/improvements.md` and link it
   from the plan's §10 Changelog.
5. **Review gate** — `architect` review on auth/agent-core changes; resolve BLOCK findings before landing.

## Configuration conventions (stable contracts future work must honor)
- **Global config**: `~/.joc/config.json` (override dir via `JOC_CONFIG_DIR`); dir `0700`, file `0600`.
  Shape in `coding-agent/src/agent/state.ts:Config` (`providers`, `oauth`, `defaultModel`,
  `ollamaBaseUrl`, `openaiBaseUrl`, `thinkingLevel`).
- **Per-project runtime**: `<cwd>/.joc/` — `seeds/`, `plans/`, `state/`, `sessions/` (see plan 02).
- **Bun-native**: deps + bin via `bun install` + `bun link`; entry `coding-agent/src/cli.ts`
  (bin `joc`), lazy command registry `coding-agent/src/cli/runner.ts:COMMANDS`.
- **Env overlay** never overrides on-disk config (`state.ts:withEnvOverlay`).
