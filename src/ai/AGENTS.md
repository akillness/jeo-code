<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-11 -->

# ai

## Purpose
Abstractions for LLM inference, provider management, tool formatting, and token counting. Decouples the core agent loop from specific API implementations.

## Key Files
| File | Description |
|------|-------------|
| `registry.ts` | Central registry for available providers and model resolution |
| `types.ts` | Common interfaces for AI requests, responses, and streams |
| `format.ts` | Conversion between internal tool schemas and provider-specific formats |

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
