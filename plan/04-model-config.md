# 04 — Model Config Plan (routing, setup, registry)

> How a user picks and configures the model `joc` runs, and how the agent routes
> a model id to the right provider/endpoint.

**Status:** `partially shipped` · **Last updated:** 2026-06-05 · **Tracking pass:** `docs/improvements.md §4, §6`

---

## 1. Goal
Deterministic model selection: a single `defaultModel` string routes to the right
provider; local and OpenAI-compatible endpoints work keylessly; `joc setup`/`joc doctor`
make the chosen model reachable and verifiable. Next: a model registry with aliases.

## 2. Current State (cite evidence)
- **Routing** `src/ai/model-manager.ts:resolveProvider(model)`:
  `ollama/<name>` → ollama; contains `gpt`/`o1` or `openai/<name>` → openai;
  contains `gemini` or `google/<name>` → gemini; else → anthropic.
- **Config** `src/agent/state.ts:Config.defaultModel` (+ `ollamaBaseUrl`, `openaiBaseUrl`, `thinkingLevel`);
  resolved from `~/.joc/config.json` (or `JOC_CONFIG_DIR`) with an env overlay (`withEnvOverlay`).
- **Setup** `src/commands/setup.ts`: interactive provider picker (anthropic/openai/gemini/ollama/lmstudio/
  openai-compatible), **live model probing** via `/api/tags` (ollama) and `/v1/models` (OpenAI-compat),
  writes `defaultModel`.
- **Per-call override** `src/ai/types.ts:CallOptions.baseUrl` + `model`; `model-manager.call()` resolves
  `baseUrl` from config per provider.
- **Reachability** `src/commands/doctor.ts`: probes the default model's provider and prints `[READY]/[NOT READY]`,
  `--strict` exits non-zero on failure.
- **Adapter-aware selection** (pass 14): non-`verifiedEndToEnd` OAuth never shadows an API key for bundled adapters.

## 3. Target State (gjc / pi-mono parity)
- **gjc** `packages/ai`: `model-manager`, `model-cache`, `provider-models`, discovery, usage — a full registry.
- **pi-mono**: model resolver + provider config in `pi-coding-agent/src/core/model-*`.
- **joc** decision: keep the prefix router (simple, predictable) and add a thin **alias + registry** layer
  (e.g. `fast` → `ollama/qwen2.5:0.5b`) without a heavyweight cache.

## 4. Design & Architecture
- `src/ai/model-registry.ts`: `{ alias → modelId }` from config (`config.modelAliases`) + built-in defaults;
  `resolveModel(input)` expands an alias before `resolveProvider`. Backward compatible (no alias = passthrough).
- Optional `joc models` command: list configured + locally-discovered models (`/api/tags`, `/v1/models`).

## 5. Implementation Steps
- **Slice 1 — alias layer** (`src/ai/model-registry.ts`, edit `model-manager.ts` to expand aliases, `test/model-registry.test.ts`). → `executor`.
- **Slice 2 — `joc models` command** (`src/commands/models.ts` + `runner.ts` entry): list/probe. → `executor`.
- **Slice 3 — `setup` writes aliases** (edit `setup.ts`): offer to save a `fast`/`smart` alias.

## 6. Acceptance Criteria (testable)
- [ ] `resolveModel("fast")` returns the configured alias target; unknown input passes through unchanged (unit test).
- [ ] `joc models` lists configured aliases + probed local models; exits 0 when ollama is up.
- [ ] Existing routing unchanged: `resolveProvider("gemini-2.0-flash")==="gemini"`, `"ollama/x"→"ollama"`, etc. (unit test).
- [ ] `tsc` 0; `bun test` green.

## 7. Risks & Mitigations
| Risk | Severity | Mitigation |
|------|----------|-----------|
| Alias expansion breaks existing model strings | High | passthrough when no alias matches; cover with a routing-unchanged test |
| Probing slow/unreachable endpoints blocks setup | Medium | 2s `AbortSignal.timeout` (already used in setup.ts); degrade to manual entry |

## 8. Verification Steps
```bash
bun run typecheck && bun test test/model-registry.test.ts
joc models                                  # lists aliases + local models
JOC_CONFIG_DIR=/tmp/c joc doctor            # [READY] for the configured default
```

## 9. Long-term / Future
- Usage/cost tracking (gjc `usage`), model capability metadata, auto-pick by task — deferred.

## 10. Changelog
- 2026-06-05 — plan created; routing + setup + doctor already shipped (§4, §6, §13, §15).
