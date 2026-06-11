<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-11 -->

# auth

## Purpose
Authentication and credential management for OAuth flows and API keys. Ensures secure storage and retrieval of provider credentials.

## Key Files
| File | Description |
|------|-------------|
| `store.ts` | Secure credential storage mechanism |
| `config.ts` | Resolution of keys from environment variables and config files |

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
