<!-- Generated: 2026-06-11 | Updated: 2026-06-11 -->

# jeo-code

## Purpose
`jeo-code` (binary `joc`) is a pure-TypeScript AI coding agent that runs on Bun with zero native dependencies. It features a Spec-first workflow, deep-interview Socratic capabilities, robust TUI with TMA (tmux) integrations, and native Ouroboros compatibility.

## Key Files
| File | Description |
|------|-------------|
| `package.json` | Project dependencies, scripts, and publication metadata |
| `tsconfig.json` | TypeScript configuration enabling strict types and Bun imports |
| `bun.lock` | Lockfile for Bun package dependencies |
| `README.md` | Primary entrypoint documentation (also mapped to ko, ja, zh) |
| `prd.json` | Product Requirements Document |
| `run-evolution.py` / `.sh` | Scripts to orchestrate evolutionary improvement passes |
| `progress.txt` | Rolling ledger of completed passes and evolutionary notes |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | Application source code (see `src/AGENTS.md`) |
| `test/` | Unit and integration test suites (see `test/AGENTS.md`) |
| `docs/` | Documentation and improvements tracker (see `docs/AGENTS.md`) |
| `scripts/` | Installation and maintenance scripts (see `scripts/AGENTS.md`) |
| `plan/` | Implementation blueprints (see `plan/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- This is the project root. Do not document ignored runtime state (like `.omc`, `.omx`, `.joc`, `.gjc`) as source architecture.
- Always use `bun` for dependency management and execution.
- Maintain the multilingual README structure when updating documentation.

### Testing Requirements
- Run `bun test` to execute all tests.
- Run `bun run typecheck` to ensure no TypeScript compilation issues.

### Common Patterns
- The project follows a strict Spec-first loop (`deep-interview` -> `ralplan` -> `approve` -> `team` -> `ultragoal`).

## Dependencies

### External
- `zod` for schema validation
- `chalk` for terminal styling

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
