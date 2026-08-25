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
import { OPENAI_COMPAT_PROVIDERS, type OpenAICompatProviderDef } from "./providers/openai-compatible-catalog";
import { customProviderDefs, onCustomProvidersChanged, type CustomProviderDef } from "./providers/custom-providers";
import type { ProviderAdapter, ProviderName } from "./types";

providerRegistry.register("anthropic", anthropicAdapter);
providerRegistry.register("openai", openaiAdapter);
providerRegistry.register("gemini", geminiAdapter);
providerRegistry.register("antigravity", antigravityAdapter);
providerRegistry.register("ollama", ollamaAdapter);
providerRegistry.register("lmstudio", lmstudioAdapter);
providerRegistry.register("xai", xaiAdapter);
providerRegistry.register("kimi", kimiAdapter);

/** Build the thin factory adapter for one catalog row, selected by wire protocol. */
function adapterFor(def: OpenAICompatProviderDef): ProviderAdapter {
  return def.protocol === "anthropic"
    ? makeAnthropicCompatibleAdapter({ name: def.name, baseUrl: def.baseUrl })
    : makeOpenAICompatibleAdapter({ name: def.name, baseUrl: def.baseUrl, thinkingFormat: def.thinkingFormat });
}

// gjc-style data-driven providers: every catalog entry gets a thin factory adapter,
// selected by wire protocol. Add a provider by adding ONE catalog row.
for (const def of OPENAI_COMPAT_PROVIDERS) {
  providerRegistry.register(def.name, adapterFor(def));
}

/** Every adapter registered above (built-ins + compiled-in catalog). Snapshotted BEFORE
 *  any custom provider is registered so it stays a pure built-in set. */
const BUILTIN_ADAPTER_NAMES: ReadonlySet<ProviderName> = new Set(providerRegistry.listProviders());

/** Custom-provider adapters currently registered, so a removal can be un-registered
 *  precisely (never touching a built-in that happens to share a name). */
const registeredCustom = new Set<ProviderName>();

/**
 * (Re)register every user-defined provider from `config.customProviders`.
 *
 * Idempotent and diff-based: providers dropped from the config are unregistered so a
 * removed endpoint stops resolving mid-session, and surviving ones are rebuilt so an
 * edited base URL / protocol takes effect without restarting jeo.
 */
export function syncCustomProviderAdapters(defs: readonly CustomProviderDef[] = customProviderDefs()): void {
  // A custom row whose id collides with a shipped provider is INERT: `openaiCompatDef`
  // already prefers the built-in, so registering its adapter would silently reroute a
  // built-in provider — and, worse, removing that row later would unregister the
  // built-in adapter entirely. Drop collisions here so the two layers agree.
  const usable = defs.filter(d => !BUILTIN_ADAPTER_NAMES.has(d.name));
  const next = new Set<ProviderName>(usable.map(d => d.name));
  for (const name of registeredCustom) {
    if (!next.has(name)) {
      providerRegistry.unregister(name);
      registeredCustom.delete(name);
    }
  }
  for (const def of usable) {
    providerRegistry.register(def.name, adapterFor(def));
    registeredCustom.add(def.name);
  }
}

// Keep the adapter set in lockstep with the custom-provider store: any code path that
// calls `setCustomProviders` (startup config load, `/provider add`, `/provider remove`)
// re-registers adapters without having to remember to do it itself.
onCustomProvidersChanged(defs => syncCustomProviderAdapters(defs));

// Pick up providers registered BEFORE this module was first imported (config load
// races module import order in short-lived commands like `jeo doctor`).
syncCustomProviderAdapters();
