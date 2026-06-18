/**
 * Built-in provider registration (the registry bootstrap).
 *
 * Importing this module for its side effect registers every bundled LLM adapter
 * into the shared `providerRegistry`. `model-manager` then resolves adapters
 * through the registry alone — it no longer imports, or even names, concrete
 * providers. To add a new built-in provider, register it HERE only; nothing in
 * `model-manager` changes.
 */
import { providerRegistry } from "./provider-registry";
import { anthropicAdapter } from "./providers/anthropic";
import { openaiAdapter } from "./providers/openai";
import { geminiAdapter } from "./providers/gemini";
import { ollamaAdapter } from "./providers/ollama";
import { lmstudioAdapter } from "./providers/lmstudio";
import { xaiAdapter } from "./providers/xai";
import { antigravityAdapter } from "./providers/antigravity";
import { kimiAdapter } from "./providers/kimi";
import { makeOpenAICompatibleAdapter } from "./providers/openai-compatible";
import { makeAnthropicCompatibleAdapter } from "./providers/anthropic-compatible";
import { OPENAI_COMPAT_PROVIDERS } from "./providers/openai-compatible-catalog";

providerRegistry.register("anthropic", anthropicAdapter);
providerRegistry.register("openai", openaiAdapter);
providerRegistry.register("gemini", geminiAdapter);
providerRegistry.register("antigravity", antigravityAdapter);
providerRegistry.register("ollama", ollamaAdapter);
providerRegistry.register("lmstudio", lmstudioAdapter);
providerRegistry.register("xai", xaiAdapter);
providerRegistry.register("kimi", kimiAdapter);

// gjc-style data-driven providers: every catalog entry gets a thin factory adapter,
// selected by wire protocol. Add a provider by adding ONE catalog row.
for (const def of OPENAI_COMPAT_PROVIDERS) {
  const adapter = def.protocol === "anthropic"
    ? makeAnthropicCompatibleAdapter({ name: def.name, baseUrl: def.baseUrl })
    : makeOpenAICompatibleAdapter({ name: def.name, baseUrl: def.baseUrl });
  providerRegistry.register(def.name, adapter);
}
