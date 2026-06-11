# 04 — Model Config Plan (routing, setup, registry for gem)

> Model configuration and routing specification for `gem`. Emphasizes Gemini-native
> routing, local provider probing, thinking levels, and user-friendly aliases.

**Status:** `planned` · **Owner:** Agent · **Last updated:** 2026-06-05 · **Tracking pass:** `docs/improvements.md §M5`

---

## 1. Goal
Provide robust, multi-provider model routing. Route `google/*` or `gemini/*` queries to Google AI Studio, `ollama/*` to local Ollama endpoints, `openai/*` to OpenAI (or local OpenAI-compat like LM Studio), and others to Anthropic. Support interactive setup probing, custom model aliases (`smart`, `fast`), and thinking budget controls.

## 2. Current State (cite evidence)
- `jeo-code/coding-agent/src/ai/model-manager.ts:resolveProvider()` contains hardcoded substrings to route models.
- `jeo-code/coding-agent/src/commands/setup.ts` prompts for provider type and probes `/api/tags` (Ollama) or `/v1/models` (OpenAI-compat) to find models.
- Default configuration is saved to `~/.joc/config.json`.
- `doctor.ts` checks connectivity and defaults to `gemini-2.0-flash` (which fails under free tier; we manually shifted to `gemini-flash-latest` to get active quota).

## 3. Target State (gjc / pi-mono parity)
- **gjc:** Implements complex model capability checks, usage limits, and discovery cache.
- **pi-mono:** Integrates model config aliases directly in `model-manager` and maps parameters.
- **gem** decision: Simplify routing via pre-configured aliases (`smart` -> Gemini Flash/Claude, `fast` -> local Ollama). Save configs to `~/.gem/config.json`. Auto-detect light/heavy thinking thresholds and pass reasoning parameters (such as `thinking: { budget: 2048 }` or provider equivalents) to the adapters.

## 4. Design & Architecture
Alias mapping registry (`src/ai/model-registry.ts`):
```json
{
  "aliases": {
    "smart": "google/gemini-flash-latest",
    "fast": "ollama/qwen2.5:0.5b"
  }
}
```

Model config file: `~/.gem/config.json`:
```json
{
  "providers": {
    "gemini": "AIzaSy...",
    "anthropic": "sk-ant-..."
  },
  "defaultModel": "smart",
  "ollamaBaseUrl": "http://localhost:11434",
  "thinkingLevel": "medium",
  "modelAliases": {
    "smart": "google/gemini-flash-latest",
    "fast": "ollama/qwen2.5:0.5b"
  }
}
```

Control Flow:
```
[callLlm("smart")] ──▶ [model-registry: Expand Alias] ──▶ "google/gemini-flash-latest"
                                                                   │
                                                                   ▼
                                                       [model-manager: Resolve Provider]
                                                                   │
                                                                   ▼
                                                           "gemini" (adapter)
```

## 5. Implementation Steps
- **Slice 1 — Model Registry & Alias Expansion** (`src/ai/model-registry.ts`, edit `model-manager.ts`, `test/model-registry.test.ts`):
  Write the resolver that translates aliases to absolute model IDs. Add unit tests verifying expansion and fallback behavior.
- **Slice 2 — Configured Setup Probe** (edit `src/commands/setup.ts`):
  Allow the user to select or customize aliases during the interactive `gem setup` run. Probe local servers to auto-select `fast`.
- **Slice 3 — Thinking Parameters & Adapters** (edit `src/ai/providers/*.ts`):
  Parse `thinkingLevel` (`low`, `medium`, `high`) and translate it to target API body options (e.g. Gemini `thinkingConfig` or Anthropic `thinking` parameters).

## 6. Acceptance Criteria (testable)
- [ ] Calling `resolveModel("smart")` successfully expands to `google/gemini-flash-latest` (or user override).
- [ ] Passing a non-aliased model string passes through unchanged (e.g. `claude-3-5-sonnet-20241022`).
- [ ] `gem setup` correctly writes aliases to `~/.gem/config.json`.
- [ ] Modifying `thinkingLevel` in config alters the generated API payload options.

## 7. Risks & Mitigations
| Risk | Severity | Mitigation |
|------|----------|-----------|
| Invalid alias leads to infinite recursion or routing crash | High | Enforce strict regex validation on alias names (only `[a-z0-9_-]+`) and prevent circular alias references. |
| Model provider changes its API parameters for thinking / reasoning | Medium | Gracefully strip thinking options if the API returns 400 parameter errors, falling back to non-thinking completion. |

## 8. Verification Steps
```bash
bun x tsc -p tsconfig.json --noEmit
bun test test/model-registry.test.ts
# Manual setup and verification
gem setup # Choose Ollama, map to 'fast'
gem doctor
```

## 9. Long-term / Future
- Implement automated cost calculation based on logged prompt and completion token counts.
- Add model latency benchmarking in `gem doctor`.

## 10. Changelog
- 2026-06-05 — Plan drafted.
