<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-14 -->

# providers

## Purpose
Concrete implementations for various LLM providers, translating generic requests into provider-specific API calls.

## Key Files
| File | Description |
|------|-------------|
| `anthropic.ts` | Anthropic Claude integration |
| `antigravity.ts` | Antigravity desktop-app OAuth client integration |
| `errors.ts` | Brief description of purpose |
| `gemini.ts` | Google Gemini (and Cloud Code Assist) integration |
| `ollama.ts` | Local Ollama integration |
| `openai-responses.ts` | Brief description of purpose |
| `openai.ts` | OpenAI (and Codex backend) integration |

## Subdirectories
*(None)*

## For AI Agents

### Working In This Directory
- Each provider must handle its specific tool-calling syntax and streaming chunk format.
- Ensure strict parsing of SSE (Server-Sent Events) streams.

### Testing Requirements
- Unit test stream parsing with mock payloads.

### Common Patterns
- Native fetch calls with `for await` loops over text decoding streams.

## Dependencies

### Internal
- `src/ai/types.ts` for interfaces.
- `src/auth/` for retrieving tokens.

### External
- HTTP `fetch`.

<!-- MANUAL: -->
