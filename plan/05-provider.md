# 05 — Provider Plan (adapters, OAuth, local, streaming)

> How `joc` talks to LLM backends: the adapter interface, credential resolution
> (API key / OAuth PKCE / local keyless), and the path to streaming + more backends.

**Status:** `partially shipped` · **Last updated:** 2026-06-05 · **Tracking pass:** `docs/improvements.md §9, §11, §14`

---

## 1. Goal
Adding or swapping a provider is a one-file change behind a stable interface;
credentials resolve from a single source (OAuth > API key, with adapter-aware
overrides); local/offline works keylessly. Next: token streaming and more backends.

## 2. Current State (cite evidence)
- **Adapter interface** `src/ai/types.ts:ProviderAdapter` (`name`, `call(messages, options, credential)`);
  registry `src/ai/model-manager.ts:ADAPTERS` maps `anthropic|openai|gemini|ollama` → adapter.
- **Adapters** `src/ai/providers/{anthropic,openai,gemini,ollama}.ts` — HTTP per provider; anthropic sends
  `anthropic-beta: oauth-2025-04-20` on OAuth bearer; openai honors `baseUrl` (LM Studio/vLLM); gemini
  uses `?key=` or `Authorization: Bearer`; ollama is keyless via `ollamaBaseUrl`.
- **Credential resolution** `src/auth/storage.ts:resolveCredential()` — OAuth bearer > API key; auto-refresh
  on expiry with a **single-flight** guard; `StoredOAuth` (access/refresh/expires).
- **Real OAuth (PKCE)** `src/auth/flows/{anthropic,openai,google}.ts` + `callback-server.ts` (local callback,
  CSRF state, manual-paste fallback) + `pkce.ts`; registry `src/auth/flows/index.ts:OAUTH_FLOW_REGISTRY`
  carries `verifiedEndToEnd` (anthropic=true; openai/gemini target Codex/Cloud-Code backends).
- **Adapter-aware selection** `model-manager.call()` (pass 14): a non-verified OAuth token never shadows a
  working API key for the bundled chat/generativelanguage adapters; clear error if only an incompatible token exists.
- **Local/offline**: ollama + any OpenAI-compatible endpoint via `openaiBaseUrl` (keyless `kind:"none"` path).
- **Hardening**: `~/.jeo/config.json` `0600`, dir `0700`; bash tool timeout + output cap (`tools.ts`).

## 3. Target State (gjc / pi-mono parity)
- **gjc** `packages/ai/src/providers`: ~14 backends (Anthropic, OpenAI Chat + Responses/Codex, Azure,
  Gemini, Vertex, Bedrock+SigV4, Ollama, Copilot, GitLab Duo, Kimi, Cursor) + a transform layer + auth-broker.
- **pi-mono** `pi-ai`: unified provider-agnostic API with streaming.
- **joc** decision: keep the lean adapter map; add **streaming** first (biggest UX win, unblocks TUI tokens),
  then high-value backends (Bedrock/Vertex/Copilot) one file at a time. Skip the broker process.

## 4. Design & Architecture
- **Streaming**: extend `ProviderAdapter` with an optional `stream(messages, options, credential): AsyncIterable<string>`;
  `model-manager` exposes `callStream()`; `callLlm` (`src/agent/loop.ts`) gains an opt-in streaming path that the
  engine/TUI consume (plan 01 §M2/§9). Non-streaming `call()` stays the default for tool-loop JSON.
- **New backend** = `src/ai/providers/<name>.ts` implementing `ProviderAdapter` + one line in `ADAPTERS` +
  (if OAuth) a flow in `auth/flows/` + one `OAUTH_FLOW_REGISTRY` entry. No other file changes.

## 5. Implementation Steps
- **Slice 1 — streaming interface** (`src/ai/types.ts`, `src/ai/model-manager.ts`, `src/ai/providers/openai.ts` SSE,
  `test/stream.test.ts` against a mock SSE server). → `executor`.
- **Slice 2 — anthropic + ollama streaming** (`providers/anthropic.ts`, `providers/ollama.ts`). → `executor`.
- **Slice 3 — Bedrock adapter (SigV4)** (`providers/bedrock.ts` + `ADAPTERS` entry) — deferred, high effort.

## 6. Acceptance Criteria (testable)
- [ ] `ProviderAdapter.stream` defined; `model-manager.callStream()` yields chunks against a mock SSE server (unit test).
- [ ] OpenAI + Anthropic + Ollama adapters implement `stream`; final concatenated text equals the non-stream `call()` result for the same mock.
- [ ] Non-streaming tool-loop path (`call()`) unchanged — existing 34 tests stay green.
- [ ] Adding a no-op test provider requires editing exactly 2 files (provider file + `ADAPTERS`), proven by the diff.
- [ ] `tsc` 0; `bun test` green.

## 7. Risks & Mitigations
| Risk | Severity | Mitigation |
|------|----------|-----------|
| Streaming complicates the JSON tool loop | High | tool loop keeps using blocking `call()`; streaming only powers chat/TUI text |
| SSE parsing edge cases across providers | Medium | shared SSE reader util + per-provider tests against mock streams |
| OAuth-backed providers (openai/gemini) still backend-incompatible | Medium | keep `verifiedEndToEnd` gating; document; only Anthropic OAuth verified e2e |
| Credential leakage in logs | Medium | never log tokens; `doctor`/status print kinds + expiry only (already enforced) |

## 8. Verification Steps
```bash
bun run typecheck && bun test test/stream.test.ts
# real local: stream a short completion from ollama/qwen2.5:0.5b and assert non-empty chunked output
joc doctor                                   # provider matrix + OAuth expiry, default model [READY]
```

## 9. Long-term / Future
- OpenAI Responses/Codex + Azure + Vertex + Copilot adapters; a transform layer (gjc `transform-messages`);
  optional credential gateway. All single-file additions behind the existing interface.

## 10. Changelog
- 2026-06-05 — plan created; adapters + real OAuth + adapter-aware selection already shipped (§9, §11, §14).
