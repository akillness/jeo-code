<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-14 -->

# ai

## Purpose
Abstractions for LLM inference, provider management, tool formatting, and token counting. Decouples the core agent loop from specific API implementations.

## Key Files
| File | Description |
|------|-------------|
| `index.ts` | Brief description of purpose |
| `model-catalog-compat.ts` | Brief description of purpose |
| `model-catalog.ts` | Brief description of purpose |
| `model-discovery.ts` | Brief description of purpose |
| `model-enrich.ts` | Brief description of purpose |
| `model-manager.ts` | Brief description of purpose |
| `model-picker.ts` | Brief description of purpose |
| `model-registry.ts` | Brief description of purpose |
| `pricing.ts` | Brief description of purpose |
| `provider-registry.ts` | Brief description of purpose |
| `provider-status.ts` | Brief description of purpose |
| `register-providers.ts` | Brief description of purpose |
| `sse.ts` | Brief description of purpose |
| `types.ts` | Common interfaces for AI requests, responses, and streams |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `providers/` | Concrete implementations for Anthropic, OpenAI, Gemini, Ollama, etc. (see `providers/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- When adding a new provider, implement the standard interface defined in `types.ts` and register it in `registry.ts`.
- Ensure streaming outputs are parsed reliably.
- Handle rate limits (429) gracefully, exposing standard retry hints to the caller.

### Testing Requirements
- Unit tests for formatting and parsing.
- Integration tests (or skipped e2e tests) for actual provider connectivity.

### Common Patterns
- Factory functions for instantiating provider clients.
- Normalization of diverse API error structures into standard exceptions.

## Dependencies

### Internal
- Consumed by `src/agent/loop.ts`.

### External
- HTTP fetch (Bun.fetch).

<!-- MANUAL: -->
