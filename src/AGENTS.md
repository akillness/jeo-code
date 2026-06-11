<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-07 | Updated: 2026-06-07 -->

# src

## Purpose
Main application source directory containing the TypeScript codebase for the `joc` agent.

## Key Files
| File | Description |
|------|-------------|
| `cli.ts` | CLI entrypoint, Bun version validation, imports and runs dispatcher |
| `index.ts` | Library entrypoint re-exporting key agent capabilities |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `agent/` | Core JSON tool-loop engine, state, session, and MutationGuard (see `agent/AGENTS.md`) |
| `ai/` | Providers adapters, model catalog, aliases registry, and model manager (see `ai/AGENTS.md`) |
| `auth/` | OAuth PKCE callbacks, bearer token storage, and key management (see `auth/AGENTS.md`) |
| `cli/` | CLI command runner registry and dispatcher (see `cli/AGENTS.md`) |
| `commands/` | Implementations of individual CLI subcommands (launch, setup, deep-interview...) (see `commands/AGENTS.md`) |
| `mcp/` | Model Context Protocol stdio server integration (see `mcp/AGENTS.md`) |
| `skills/` | Socratic requirements and planning skill catalogs (see `skills/AGENTS.md`) |
| `tui/` | differential TUI rendering, autocompletion, and layout components (see `tui/AGENTS.md`) |
| `util/` | Shared utilities (transient retry, http error formatting) (see `util/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Place any new subcommands under `commands/` and register them in `cli/runner.ts`.
- Place general helper logic in `util/`.

### Testing Requirements
- Unit tests for new source components should be co-located in the `test/` directory.

### Common Patterns
- Follow TypeScript ESM structure with explicit `.ts` imports.

## Dependencies

### Internal
- Depends on `test/` for unit tests and verification.

### External
- Bun >= 1.3.14

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
