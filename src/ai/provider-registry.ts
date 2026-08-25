import type { ProviderAdapter, ProviderName } from "./types";

/**
 * Provider Registry: Central hub for managing and loading LLM providers.
 * Decouples model-manager from specific provider implementations.
 */
class ProviderRegistry {
  private adapters = new Map<ProviderName, ProviderAdapter>();

  register(name: ProviderName, adapter: ProviderAdapter) {
    this.adapters.set(name, adapter);
  }

  get(name: ProviderName): ProviderAdapter | undefined {
    return this.adapters.get(name);
  }

  /** Drop an adapter. Used when a user removes a custom provider mid-session so the
   *  next `/model` or routing pass cannot resolve a provider that no longer exists. */
  unregister(name: ProviderName): boolean {
    return this.adapters.delete(name);
  }

  has(name: ProviderName): boolean {
    return this.adapters.has(name);
  }

  listProviders(): ProviderName[] {
    return Array.from(this.adapters.keys());
  }
}

export const providerRegistry = new ProviderRegistry();
