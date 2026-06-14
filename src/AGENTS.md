<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-14 -->

# src

## Purpose
Core application source code for the `jeo-code` CLI and agent runtime. It orchestrates user commands, TUI rendering, agent intelligence, tool execution, and workspace integrations.

## Key Files
| File | Description |
|------|-------------|
| `autopilot.ts` | Brief description of purpose |
| `bun-imports.d.ts` | TypeScript declarations for Bun built-ins and raw module imports |
| `cli.ts` | The main binary entrypoint |
| `index.ts` | Library exports |
| `ledger.ts` | Brief description of purpose |
| `md-modules.d.ts` | TypeScript declarations for Bun built-ins and raw module imports |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `agent/` | Agent execution loop, tool registry, session state, and subagent management (see `agent/AGENTS.md`) |
| `ai/` | LLM client interactions, provider abstractions, and token management (see `ai/AGENTS.md`) |
| `auth/` | OAuth flows and credential management (see `auth/AGENTS.md`) |
| `cli/` | Command-line interface definitions and arg parsing (see `cli/AGENTS.md`) |
| `commands/` | Implementations for all `jeo` subcommands (launch, setup, team, etc.) (see `commands/AGENTS.md`) |
| `mcp/` | Model Context Protocol integration (see `mcp/AGENTS.md`) |
| `prompts/` | Bundled system prompts and skills (see `prompts/AGENTS.md`) |
| `skills/` | Skill execution framework and discovery (see `skills/AGENTS.md`) |
| `tui/` | Terminal User Interface, layout, and rendering (see `tui/AGENTS.md`) |
| `util/` | General utilities, retry logic, and update checking (see `util/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Entrypoints reside here, but domain logic should be pushed into appropriate subdirectories.
- Adhere strictly to the Bun execution environment (no Node.js-specific modules unless polyfilled by Bun).

### Testing Requirements
- Code touched here is highly central; verify with `bun test` and `bun run typecheck`.

### Common Patterns
- Fast startup: limit top-level imports that execute expensive initialization.

## Dependencies

### Internal
- Depends heavily on all subdirectories (`agent`, `tui`, `ai`, etc.).

### External
- Bun runtime APIs.

<!-- MANUAL: -->
