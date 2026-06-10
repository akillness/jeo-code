<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-07 | Updated: 2026-06-07 -->

# flows

## Purpose
Provider-specific OAuth login flows configurations.

## Key Files
| File | Description |
|------|-------------|
| `index.ts` | Exports all cloud OAuth configs and sets `verifiedEndToEnd` compat flags |
| `anthropic.ts` | Configures PKCE endpoints and token exchange for Anthropic |
| `openai.ts` | Configures login endpoints and exchange formatting for OpenAI |
| `google.ts` | Configures login endpoints and exchange formatting for Google Gemini |

## Subdirectories
None.

## For AI Agents

### Working In This Directory
- `verifiedEndToEnd` determines if the minted OAuth token can run directly with joc's bundled adapter. Set to `false` for OpenAI/Google (which prefer API keys for chat completions but support OAuth for discovery).

## Dependencies

### Internal
- `src/auth/` (used during PKCE callback server exchanges)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
