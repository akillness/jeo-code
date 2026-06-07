/**
 * Pure helpers for the model/provider setting flow (`joc setup`). Extracted from
 * the readline-driven command so the validation, normalization, recommendation,
 * and summary logic is unit-testable without a TTY.
 */
import type { ProviderName } from "../ai/types";
import { recommendedModel, validateModelId, suggestModels, findCatalogEntry, catalogForProvider } from "../ai/model-catalog-compat";
import { resolveProvider } from "../ai/model-manager";
import type { Config } from "../agent/state";

/**
 * Normalize a base URL: trim, default when blank, add `http://` when no scheme,
 * strip trailing slashes. Returns the fallback unchanged when input is empty.
 */
export function normalizeBaseUrl(input: string | undefined, fallback: string): string {
  let u = (input ?? "").trim();
  if (!u) u = fallback;
  if (!u) return u;
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u.replace(/\/+$/, "");
}

export interface ModelChoiceResult {
  model: string;
  known: boolean;
  /** Non-fatal advisory (provider mismatch or uncatalogued id). */
  warning?: string;
  /** "Did you mean" candidates when the typed id is unrecognized. */
  suggestions: string[];
}

/**
 * Resolve the default model from a (possibly blank) typed value for a provider:
 *  - blank → the provider's recommended model
 *  - known id → accepted (warns when it routes to a different provider)
 *  - unknown id → accepted but flagged with "did you mean" suggestions
 */
export function chooseDefaultModel(typed: string | undefined, provider: ProviderName): ModelChoiceResult {
  const t = (typed ?? "").trim();
  if (!t) {
    const rec = recommendedModel(provider) ?? "";
    return { model: rec, known: !!findCatalogEntry(rec), suggestions: [] };
  }
  const v = validateModelId(t, provider);
  if (v.known) {
    const warning =
      v.providerMatch === false ? `Note: '${t}' routes to ${v.entry!.provider}, not ${provider}.` : undefined;
    return { model: t, known: true, warning, suggestions: [] };
  }
  return {
    model: t,
    known: false,
    warning: `'${t}' is not in the model catalog (it may still work).`,
    suggestions: suggestModels(t),
  };
}

/** Top-N recommended catalog rows for a provider, as `id — note` display lines. */
export function recommendedModelsFor(provider: ProviderName, n = 5): string[] {
  return catalogForProvider(provider)
    .slice(0, n)
    .map(e => `${e.id}${e.note ? ` — ${e.note}` : ""}`);
}

/** Human list of providers that are configured in a config object. */
export function buildEnabledProviders(config: Config): string[] {
  const enabled: string[] = [];
  const cfg = config as Config & { openaiBaseUrl?: string };
  if (cfg.providers?.anthropic || cfg.oauth?.anthropic) enabled.push("anthropic");
  if (cfg.providers?.openai || cfg.oauth?.openai) enabled.push("openai");
  if (cfg.providers?.gemini || cfg.oauth?.gemini) enabled.push("gemini");
  if (cfg.ollamaBaseUrl) enabled.push(`ollama(${cfg.ollamaBaseUrl})`);
  if (cfg.openaiBaseUrl) enabled.push(`openai-compatible(${cfg.openaiBaseUrl})`);
  return enabled;
}

/**
 * Build the post-save summary lines: default model + the provider it routes to,
 * catalog metadata when known, and the enabled-provider list.
 */
export function buildSetupSummary(config: Config): string[] {
  const lines: string[] = [];
  const model = config.defaultModel;
  const provider = resolveProvider(model);
  const entry = findCatalogEntry(model);
  const meta = entry
    ? ` (${entry.contextWindow ? `${Math.round(entry.contextWindow / 1000)}k ctx` : "ctx ?"}${entry.reasoning ? ", reasoning" : ""})`
    : "";
  lines.push(`Default model: ${model} → ${provider}${meta}`);
  const enabled = buildEnabledProviders(config);
  lines.push(`Enabled providers: ${enabled.join(", ") || "None"}`);
  return lines;
}
