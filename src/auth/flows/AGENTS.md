<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-14 -->

# flows

## Purpose
Specific OAuth flow implementations for various providers.

## Key Files
| File | Description |
|------|-------------|
| `anthropic.ts` | Anthropic (claude.ai) PKCE OAuth |
| `antigravity.ts` | Google Antigravity OAuth (desktop-app client, dedicated project discovery) |
| `google-project.ts` | Cloud Code Assist project discovery/onboarding shared by gemini + antigravity |
| `google.ts` | Google Gemini CLI OAuth (authorization-code) |
| `index.ts` | OAUTH_FLOW_REGISTRY wiring flows to providers |
| `kimi.ts` | Kimi Code (Moonshot subscription) device-authorization OAuth — no callback server |
| `openai.ts` | OpenAI Codex PKCE OAuth + device-code fallback when port 1455 is busy |

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

### Internal
{References to other parts of the codebase this depends on}

### External
{Key external packages/libraries used}

<!-- MANUAL: -->
