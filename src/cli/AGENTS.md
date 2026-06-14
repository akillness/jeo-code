<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-14 -->

# cli

## Purpose
Command-line interface routing, argument parsing, and initialization logic. Defines the shape of the `jeo` binary interface.

## Key Files
| File | Description |
|------|-------------|
| `index.ts` | Brief description of purpose |
| `runner.ts` | Brief description of purpose |

## Subdirectories
*(None)*

## For AI Agents

### Working In This Directory
- Keep parsing logic declarative.
- Ensure all flags have clear help text and defaults.
- Delegate actual command execution to `src/commands/`.

### Testing Requirements
- Test CLI arg parsing with various flag combinations.

### Common Patterns
- Early exit for `--help` and `--version`.

## Dependencies

### Internal
- Routes to `src/commands/`.

### External
- Standard CLI arg parsing libraries or custom minimal parsers.

<!-- MANUAL: -->
