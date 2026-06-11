<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-11 -->

# test

## Purpose
Comprehensive unit and integration test suites for the `jeo-code` project. Ensures correctness of the agent loop, tool execution, TUI rendering, and CLI commands.

## Key Files
| File | Description |
|------|-------------|
| `*.test.ts` | Test files matching corresponding source modules |

## Subdirectories
*(None)*

## For AI Agents

### Working In This Directory
- Use `bun:test` for all testing utilities (`test`, `expect`, `mock`, `spyOn`).
- Tests should execute quickly; mock external API calls (e.g., LLM providers, OAuth) unless it's a specific e2e integration test.
- Use explicit assertions and descriptive test names.

### Testing Requirements
- Run all tests with `bun test`.
- Individual files can be run via `bun test test/<filename>.test.ts`.

### Common Patterns
- Mocking stdout/stderr for TUI and command output validation.
- Extensive use of temporary directories (`fs.mkdtemp`) for isolated filesystem operations.

## Dependencies

### Internal
- Validates the entire `src/` directory.

### External
- `bun:test`

<!-- MANUAL: -->
