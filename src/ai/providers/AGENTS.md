<!-- Parent: ../../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-11 -->

# providers

## Purpose
Concrete implementations for various LLM providers, translating generic requests into provider-specific API calls.

## Key Files
| File | Description |
|------|-------------|
| `anthropic.ts` | Anthropic Claude integration |
| `openai.ts` | OpenAI (and Codex backend) integration |
| `gemini.ts` | Google Gemini (and Cloud Code Assist) integration |
| `antigravity.ts` | Antigravity desktop-app OAuth client integration |
| `ollama.ts` | Local Ollama integration |

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
