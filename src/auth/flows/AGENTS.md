<!-- Parent: ../../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-11 -->

# flows

## Purpose
Specific OAuth flow implementations for various providers.

## Key Files
| File | Description |
|------|-------------|
| `oauth.ts` / `pkce.ts` | Generic OAuth and PKCE utilities |
| `*.ts` | Provider-specific login flows (e.g., anthropic, openai, gemini) |

## Subdirectories
*(None)*

## For AI Agents

### Working In This Directory
- Handle browser launching and local callback servers securely.

### Testing Requirements
- Ensure ports and servers are closed cleanly in tests.

### Common Patterns
- Loopback HTTP servers for receiving OAuth callbacks.

## Dependencies
*(None)*

<!-- MANUAL: -->
