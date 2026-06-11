<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-11 -->

# util

## Purpose
General utilities, helper functions, and shared types used across the application.

## Key Files
| File | Description |
|------|-------------|
| `update-check.ts` | Async check for newer npm versions |
| `retry.ts` | Rate-limit backoff and generic retry mechanisms |
| `provider-error.ts` | Error normalization helpers |

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
