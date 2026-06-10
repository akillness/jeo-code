<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-07 | Updated: 2026-06-07 -->

# util

## Purpose
Common utility functions. It includes retry helpers and custom error formatting modules.

## Key Files
| File | Description |
|------|-------------|
| `retry.ts` | Exponential backoff logic (`withRetry`) retrying transient network errors |
| `provider-error.ts` | Formatter for API HTTP status codes and detail outputs |

## Subdirectories
None.

## For AI Agents

### Working In This Directory
- Keep utilities pure and highly unit-tested.
- Implement only domain-agnostic helpers here.

## Dependencies

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
