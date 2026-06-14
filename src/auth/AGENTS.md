<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-14 -->

# auth

## Purpose
Authentication and credential management for OAuth flows and API keys. Ensures secure storage and retrieval of provider credentials.

## Key Files
| File | Description |
|------|-------------|
| `callback-server.ts` | Brief description of purpose |
| `index.ts` | Brief description of purpose |
| `oauth.ts` | Brief description of purpose |
| `pkce.ts` | Brief description of purpose |
| `refresh.ts` | Brief description of purpose |
| `storage.ts` | Brief description of purpose |
| `types.ts` | Brief description of purpose |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `flows/` | Specific OAuth implementations (see `flows/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- NEVER log credentials or sensitive tokens.
- Handle token refresh transparently.
- Ensure atomic file writes when updating local credential caches.

### Testing Requirements
- Mock the filesystem when testing the credential store.

### Common Patterns
- Fallback chains: Memory cache -> Config File -> Environment Variables.

## Dependencies

### Internal
- Used by `src/ai/providers/` to authenticate requests.

### External
- OS-level secure storage if applicable, or local encrypted files.

<!-- MANUAL: -->
