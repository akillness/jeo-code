<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-14 -->

# util

## Purpose
General utilities, helper functions, and shared types used across the application.

## Key Files
| File | Description |
|------|-------------|
| `clipboard-image.ts` | Brief description of purpose |
| `env.ts` | Brief description of purpose |
| `provider-error.ts` | Error normalization helpers |
| `retry.ts` | Rate-limit backoff and generic retry mechanisms |
| `update-check.ts` | Async check for newer npm versions |

## Subdirectories
*(None)*

## For AI Agents

### Working In This Directory
- Keep utilities pure and stateless where possible.
- Avoid circular dependencies.

### Testing Requirements
- High unit test coverage expected.

### Common Patterns
- Retry loops use exponential backoff respecting `Retry-After` headers.

## Dependencies

### Internal
- Used globally.

### External
*(None)*

<!-- MANUAL: -->
