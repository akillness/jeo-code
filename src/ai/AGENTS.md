<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-07 | Updated: 2026-06-07 -->

# ai

## Purpose
AI Model Manager layer that handles provider resolution, credentials mapping, alias registration, capability catalogs, and request dispatching.

## Key Files
| File | Description |
|------|-------------|
| `index.ts` | Exports all public AI adapter, manager, discovery, and picker modules |
| `model-manager.ts` | Creates the model manager, resolves providers, handles API key fallbacks and retry budgets |
| `model-registry.ts` | Maintains the friendly model alias mapper (fast, local, sonnet, etc.) |
| `model-catalog.ts` | curates static capabilities (context, output size, thinking levels, image support) |
| `model-discovery.ts` | Discovers live available models using OAuth bearers or API keys |
| `model-picker.ts` | Flatten discovery lists into numbered pick lists |
| `model-enrich.ts` | Merges live discovered models with static capability metadata |
| `provider-status.ts` | Determines the credential readiness and label status of registered providers |
| `types.ts` | Shared type declarations (Message, CallOptions, ProviderAdapter) |
| `sse.ts` | Server-Sent Events SSE parser wrapper |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `providers/` | Concrete provider adapters (Anthropic, OpenAI, Gemini, Ollama) (see `providers/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Add any new models or capability data directly to `model-catalog.ts`.
- Update the default aliases in `model-registry.ts` or `model-manager.ts` if adding a new base model.
- Keep adapter-specific request parsing encapsulated under `providers/`.

## Dependencies

### Internal
- `src/auth/` (uses `resolveCredential` and token storage)
- `src/util/` (uses `withRetry` helper)

### External
- `@types/bun`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
