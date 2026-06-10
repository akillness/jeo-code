<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# jeo-code V2

## Purpose
`jeo-code` (binary `joc`) is a pure-TypeScript AI coding agent that runs on Bun with zero native dependencies. V2 introduces enhanced modularity, .specify/.ouroboros integration, and a lean tool loop.

## Key Files
| File | Description |
|------|-------------|
| `package.json` | Project dependencies, scripts, and publication metadata |
| `tsconfig.json` | TypeScript configuration enabling strict types and Bun imports |
| `bun.lock` | Lockfile for Bun package dependencies |
| `.specify/` | Specification kit and constitution |
| `.ouroboros/` | Self-analysis and improvement cycles |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | Application source code (see `src/AGENTS.md`) |
| `test/` | Unit and integration test suites |
| `docs/` | Documentation and changelogs |
| `scripts/` | Installation and maintenance scripts |
| `plan/` | Implementation blueprints |

## For AI Agents

### V2 Components
- **.specify**: Use for rigorous requirement clarification before execution.
- **.ouroboros**: Use for self-correction and iterative refinement.
- **provider-registry**: Decoupled LLM provider management.

### Testing Requirements
- Run `bun test` to execute all tests.
- Run `bun run typecheck` to ensure no TypeScript compilation issues.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
