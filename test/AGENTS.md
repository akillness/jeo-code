<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-07 | Updated: 2026-06-07 -->

# test

## Purpose
Flat test directory containing unit, integration, and PTY interactive smoke tests using `bun:test`.

## Key Files
| File | Description |
|------|-------------|
| `engine.test.ts` | Tests for the core JSON tool-loop engine |
| `select-list.test.ts` | Tests for the keyboard-navigable list component |
| `model-discovery.test.ts` | Tests for live API/OAuth model discovery |
| `tmux.test.ts` | Integration tests for tmux command spawning and session attachment |
| `launch-flags.test.ts` | Tests for CLI runner and launch parameter parsing |

## Subdirectories
None.

## For AI Agents

### Working In This Directory
- Add a corresponding `.test.ts` file for every new source component.
- Keep tests isolated by using mock directories (`fs.mkdtemp`), overriding environment variables, or stubbing `callLlm`.

### Testing Requirements
- Ensure that `bun test` is always green and runs successfully in the workspace.
- Avoid network-dependent tests; mock external provider HTTP responses.

### Common Patterns
- Import test primitives from `"bun:test"` (`test`, `expect`, `mock`, `beforeAll`, `afterAll`).

## Dependencies

### Internal
- `src/` (the modules under test)

### External
- Bun (Runtime and built-in test runner)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
