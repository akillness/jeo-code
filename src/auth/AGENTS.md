<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-07 | Updated: 2026-06-07 -->

# auth

## Purpose
Authentication manager handling PKCE login flows, callback HTTP server, token storage, and background token rotation.

## Key Files
| File | Description |
|------|-------------|
| `index.ts` | Barrel file exporting public storage, OAuth callback, and flows modules |
| `storage.ts` | Stores credentials in global `config.json`, provides credential snapshots, and manages token expiry checks |
| `callback-server.ts` | Launches a temporary local HTTP server to receive OAuth redirect codes |
| `oauth.ts` | Drives the interactive login browser/redirect flow |
| `refresh.ts` | Rotates expired OAuth tokens using provider-specific refresh flows |
| `pkce.ts` | Generates random verifiers, SHA-256 challenges, and CSRF states |
| `types.ts` | OAuth controller interfaces and credential types |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `flows/` | Provider-specific OAuth parameters and refresh request formats (see `flows/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Token storage must keep credentials separate from other plain configuration fields.
- Rotate tokens automatically before executing calls if the token's life has expired.

## Dependencies

### Internal
- `src/agent/` (uses global config read/save helpers)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
