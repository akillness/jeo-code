import { readGlobalConfig, type Config } from "../agent/state";
import { listProviderModels } from "../ai/model-discovery";
import { credentialForCall, effectiveCredentialForProvider, qualifyModelId, resolveProvider } from "../ai/model-manager";
import { resolveModelId } from "../ai/model-registry";
import { resolveCredential, type AuthProvider, type Credential } from "../auth";

/** Select only from the account's live catalog; never substitute a static model. */
export async function selectDiscordModel(
  explicit: string | undefined,
  opts: { config?: Config; signal?: AbortSignal; list?: typeof listProviderModels; credential?: typeof resolveCredential } = {},
): Promise<string> {
  const config = opts.config ?? await readGlobalConfig();
  const requested = explicit?.trim() ? await resolveModelId(explicit.trim(), config) : undefined;
  const provider = resolveProvider(requested || await resolveModelId(config.defaultModel, config));
  if (!requested && provider !== "anthropic" && provider !== "openai" && provider !== "antigravity") {
    throw new Error(`Discord automatic model selection does not support provider ${provider}; configure an explicit model`);
  }
  const result = await (opts.list ?? listProviderModels)(provider, { config, signal: opts.signal, limit: Number.POSITIVE_INFINITY, preferOAuth: true });
  if (opts.signal?.aborted) throw new Error("Messenger request aborted");
  if (!result.ok || result.fallback || result.source === "none" || (result.source === "keyless" && (!requested || (provider !== "ollama" && provider !== "lmstudio"))) || !result.models.length) {
    throw new Error(`Discord cannot verify available models for ${provider}; check login and live model discovery`);
  }
  const canonical = (model: string) => qualifyModelId(model, provider);
  const verified = async (model: string): Promise<string> => {
    const authProvider: AuthProvider | undefined = provider === "anthropic" ? "anthropic" : provider === "openai" ? "openai" : undefined;
    if (authProvider && config.providers[authProvider]) {
      const credential: Credential = await (opts.credential ?? resolveCredential)(authProvider);
      const effective = effectiveCredentialForProvider(authProvider, credential, config, model);
      const actual = credentialForCall(provider, effective, config, provider === "openai" ? config.openaiBaseUrl : undefined);
      if (actual.kind !== result.source) {
        throw new Error(`Discord cannot verify ${provider} model access for the credential used at runtime`);
      }
    }
    return canonical(model);
  };
  if (requested) {
    const prefix = `${provider}/`;
    const requestedId = requested.startsWith(prefix) ? requested.slice(prefix.length) : requested;
    const match = result.models.find(model => (model.startsWith(prefix) ? model.slice(prefix.length) : model) === requestedId);
    if (!match) throw new Error(`Discord configured model is not available for ${provider}: ${requested}`);
    return verified(match);
  }
  const family = provider === "anthropic" ? /sonnet/i : provider === "openai" ? /terra/i : /gemini.*flash/i;
  const models = [...new Set(result.models.filter(model => family.test(provider === "antigravity" ? (result.displayNames?.[model] ?? model) : model)))];
  if (!models.length) throw new Error(`Discord found no available ${provider} model in the required family`);
  if (models.length === 1) return verified(models[0]!);
  // Antigravity wire aliases can advertise a different version than their IDs.
  // Only the display name from the same live response establishes recency.
  if (provider === "antigravity" && models.some(model => !result.displayNames?.[model])) {
    throw new Error("Discord cannot determine the newest Antigravity Flash model; configure an explicit model");
  }
  const ranked = models.map(model => {
    const name = provider === "antigravity" ? result.displayNames![model]! : model;
    const snapshot = provider === "anthropic" ? name.match(/-(\d{8})$/) : null;
    const versionName = snapshot ? name.slice(0, -snapshot[0].length) : name;
    return { model, version: (versionName.match(/\d+/g) ?? []).map(Number), snapshot: Number(snapshot?.[1] ?? 0), tier: provider === "antigravity" ? (/\bhigh\b/i.test(name) ? 2 : /\blow\b/i.test(name) ? 1 : 0) : 0 };
  });
  if (ranked.some(item => !item.version.length)) {
    throw new Error(`Discord cannot determine the newest ${provider} model; configure an explicit model`);
  }
  const compare = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const difference = (b[i] ?? 0) - (a[i] ?? 0);
      if (difference) return difference;
    }
    return 0;
  };
  ranked.sort((a, b) => compare(a.version, b.version) || b.snapshot - a.snapshot || b.tier - a.tier);
  if (compare(ranked[0]!.version, ranked[1]!.version) === 0 && ranked[0]!.snapshot === ranked[1]!.snapshot && ranked[0]!.tier === ranked[1]!.tier) {
    throw new Error(`Discord cannot distinguish the newest ${provider} models; configure an explicit model`);
  }
  return verified(ranked[0]!.model);
}
