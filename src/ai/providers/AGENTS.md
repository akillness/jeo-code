<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-07 | Updated: 2026-06-07 -->

# providers

## Purpose
Concrete provider adapter modules that format request payloads, authorize connections, and stream server responses.

## Key Files
| File | Description |
|------|-------------|
| `anthropic.ts` | Adapter for Anthropic Messages API (handles thinking budget, versioning, and usage metrics) |
| `openai.ts` | Adapter for OpenAI Chat Completions API (handles JSON mode and usage metadata) |
| `gemini.ts` | Adapter for Google Generative Language API (strips prefixes and formats requests) |
| `ollama.ts` | Adapter for keyless local Ollama server |
| `errors.ts` | Defines `ProviderHttpError` and HTTP error wrappers |

## Subdirectories
None.

## For AI Agents

### Working In This Directory
- Model-id rewrites must only strip the provider prefixes (e.g. `google/` or `gemini/` in Gemini, `openai/` in OpenAI, etc.).
- Ensure streamed chunks yield text increments and sink accurate token usages to `onUsage`.

## Dependencies

### Internal
- `src/ai/` (uses the adapter interfaces and types)

### External
- `@types/bun`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
