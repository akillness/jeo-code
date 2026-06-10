# 05 — Provider & OAuth Plan (credential authentication & refresh for gem)

> Detailed specification for provider adapter wrappers, real interactive browser-based
> OAuth (PKCE) login, and transparent in-process token auto-refresh.

**Status:** `planned` · **Owner:** Agent · **Last updated:** 2026-06-05 · **Tracking pass:** `docs/improvements.md §M4`

---

## 1. Goal
Provide secure, enterprise-grade authentication. Implement browser-directed PKCE OAuth callback flows for Claude Pro/Max (Anthropic), ChatGPT/Codex (OpenAI), and Gemini CLI (Google Cloud Code Assist). Store credentials securely (chmod 600) and automatically refresh expired access tokens using stored refresh tokens before LLM calls.

## 2. Current State (cite evidence)
- `jeo-code/coding-agent/src/auth/` contains the callback server, PKCE utilities, and provider-specific flows (`anthropic.ts`, `openai.ts`, `google.ts`).
- `jeo-code/coding-agent/src/commands/auth.ts` exposes `joc auth login`, `logout`, `refresh`, and `status` commands.
- `jeo-code/coding-agent/src/auth/storage.ts:resolveCredential()` has a dynamic import hook to check token expiration and trigger auto-refresh before API requests.
- Configuration is loaded and saved via `readGlobalConfig()` / `saveGlobalConfig()` in `state.ts`.

## 3. Target State (gjc / pi-mono parity)
- **gjc:** Exposes a background daemon (`AuthBrokerRefresher`) that periodically polls and rotates tokens, storing them in a local SQLite database.
- **pi-mono:** Relies mostly on API keys; does not implement complex PKCE browser loop.
- **gem** decision: Run a **lazy, in-process auto-refresh** loop instead of a heavy background daemon process. When `resolveCredential` is called right before an outbound LLM call, if the access token has expired (or expires within 5 minutes), it performs the OAuth refresh call, saves the updated credentials to `~/.gem/config.json` (chmod 600), and returns the new token.

## 4. Design & Architecture
OAuth flow classes under `src/auth/flows/`:
```
src/auth/
├── callback-server.ts  # Bun.serve listener; handles code callback or manual code paste
├── pkce.ts             # PKCE cryptographic helper (SHA-256 base64url challenge)
├── storage.ts          # Reads/writes ~/.gem/config.json with chmod 600 best-effort
├── refresh.ts          # Dispatches flows to refresh tokens
└── flows/
    ├── anthropic.ts    # Client ID OWQx..., token endpoint claude.ai, port 54545
    ├── openai.ts       # Client ID app_EMoa..., token endpoint auth.openai.com, port 1455
    └── google.ts       # Client ID Google CLI, token endpoint accounts.google.com, port 8085
```

Auto-Refresh Flow:
```
[callLlm]
   │
   ▼
[resolveCredential(provider)]
   │
   ├─► [Has API Key] ─────────────────────────────────────────► Returns API key
   │
   └─► [Has OAuth Credentials]
         │
         ├──► [Token Valid] ──────────────────────────────────► Returns Access Token
         │
         └──► [Token Expired / Expires < 5 mins]
                │
                ▼
            [refreshOAuthToken(provider)]
                │ (Calls Upstream token endpoint)
                ▼
            [Save rotated tokens to ~/.gem/config.json] ──────► Returns New Access Token
```

## 5. Implementation Steps
- **Slice 1 — PKCE & Local Callback Server** (`src/auth/pkce.ts`, `src/auth/callback-server.ts`):
  Implement SHA-256 base64url challenge generation. Construct a port-resilient `Bun.serve` server that handles CSRF state verification and displays success page.
- **Slice 2 — Provider OAuth Flow Implementation** (`src/auth/flows/`):
  Implement authorization URL generation and token exchange code for Anthropic, OpenAI, and Google.
- **Slice 3 — Lazy Auto-Refresher Hook** (`src/auth/refresh.ts`, edit `src/auth/storage.ts`):
  Hook the refresh logic into the credential resolver. Check expiration times on every read, overwrite config atomic-safely, and fail-safe (with fallback logs) if network is offline.

## 6. Acceptance Criteria (testable)
- [ ] Executing `gem auth login anthropic` spins a server on port 54545, opens browser, and successfully captures redirected token.
- [ ] Mock tests verify that if a token is expired, `resolveCredential` automatically triggers the token endpoint refresh call and saves the new access token.
- [ ] The configuration file `~/.gem/config.json` is saved with permissions restricted to the owner (`0600`) to prevent credential leakage.
- [ ] Direct token login (`gem auth login anthropic --token <bearer>`) stores a manual key without refresh capability.

## 7. Risks & Mitigations
| Risk | Severity | Mitigation |
|------|----------|-----------|
| Local callback port is occupied by another process | Medium | Implement port fallback to a random free port (defaulting to port 0) and pass the actual bound URI to the authorize query params (except for OpenAI which requires fixed port 1455). |
| Outbound OAuth refresh network call hangs indefinitely, blocking the main loop | Medium | Force a 30s `AbortSignal.timeout` on the refresh fetch call, gracefully falling back to using the stale token (which will prompt the user to re-authenticate on HTTP 401). |

## 8. Verification Steps
```bash
bun x tsc -p tsconfig.json --noEmit
bun test test/oauth.test.ts
# Manual OAuth flow verify
gem auth login anthropic
gem auth status
```

## 9. Long-term / Future
- Secure keychain storage integration (macOS Keychain, Linux Secret Service).
- Multi-account credential switching and organization-level usage limits.

## 10. Changelog
- 2026-06-05 — Plan drafted.
