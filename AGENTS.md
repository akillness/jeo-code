<!-- Generated: 2026-06-11 | Updated: 2026-06-14 -->

# jeo-code

## Purpose
`jeo-code` (binary `jeo`) is a pure-TypeScript AI coding agent that runs on Bun with zero native dependencies. It features a Spec-first workflow, deep-interview Socratic capabilities, robust TUI with TMA (tmux) integrations, and native Ouroboros compatibility.

## Key Files
| File | Description |
|------|-------------|
| `CHANGELOG.md` | Brief description of purpose |
| `README.ja.md` | Brief description of purpose |
| `README.ko.md` | Brief description of purpose |
| `README.md` | Primary entrypoint documentation (also mapped to ko, ja, zh) |
| `README.zh.md` | Brief description of purpose |
| `analyze_image.py` | Brief description of purpose |
| `bun.lock` | Lockfile for Bun package dependencies |
| `install.sh` | Brief description of purpose |
| `package.json` | Project dependencies, scripts, and publication metadata |
| `skills-lock.json` | Brief description of purpose |
| `tsconfig.json` | TypeScript configuration enabling strict types and Bun imports |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `assets/` | Branding/character images used by docs and animations (see `assets/AGENTS.md`) |
| `docs/` | Documentation and improvements tracker (see `docs/AGENTS.md`) |
| `plan/` | Implementation blueprints (see `plan/AGENTS.md`) |
| `scripts/` | Installation and maintenance scripts (see `scripts/AGENTS.md`) |
| `src/` | Application source code (see `src/AGENTS.md`) |
| `test/` | Unit and integration test suites (see `test/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- This is the project root. Do not document ignored runtime state (like `.omc`, `.omx`, `.jeo`, `.gjc`) as source architecture.
- Always use `bun` for dependency management and execution.
- Maintain the multilingual README structure when updating documentation.

### Testing Requirements
- Run `bun test` to execute all tests.
- Run `bun run typecheck` to ensure no TypeScript compilation issues.

### Common Patterns
- The project follows a strict Spec-first loop (`deep-interview` -> `ralplan` -> `approve` -> `team` -> `ultragoal`).

## Dependencies

### Internal
{References to other parts of the codebase this depends on}

### External
- `zod` for schema validation
- `chalk` for terminal styling

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

<!-- JEO-WORKFLOWS:START -->
## Workflow rules
Every prompt: openspace route → rtk shell → semble search → jev (only after rtk and
semble, if a profile is enabled) → then by query: knowledge → second-brain vault,
code/memory → `.mex/`, semantic search → `zg query`, ontology → open-ontologies,
harness changes → `.harness2/`. Full rules: `.agents/rules/jeo-workflows.md` (global copy
`~/.agents/rules/jeo-workflows.md`).
<!-- JEO-WORKFLOWS:END -->
