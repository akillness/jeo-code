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
import { antigravityAdapter } from "./providers/antigravity";

providerRegistry.register("anthropic", anthropicAdapter);
providerRegistry.register("openai", openaiAdapter);
providerRegistry.register("gemini", geminiAdapter);
providerRegistry.register("antigravity", antigravityAdapter);
providerRegistry.register("ollama", ollamaAdapter);
