/**
 * Static per-model price table for live `$` cost accounting (consensus-seed P1.B3).
 *
 * Prices are USD per 1,000,000 tokens, split input/output, and are MAINTAINED MANUALLY
 * here (no network lookup) — update against each provider's public pricing page. Matching
 * is by model-family substring so versioned ids (e.g. `claude-sonnet-4-5-20250929`) resolve
 * without an exact-id table. An UNKNOWN model returns `null` so the caller shows token
 * counts only and never fabricates a dollar figure.
 */
export interface ModelPrice {
  /** USD per 1M input tokens. */
  inPerM: number;
  /** USD per 1M output tokens. */
  outPerM: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Family price table. Order matters: the FIRST substring that matches the lowercased
 * model id wins, so list more-specific families before generic ones.
 */
const PRICE_TABLE: ReadonlyArray<readonly [pattern: string, price: ModelPrice]> = [
  // Anthropic Claude
  ["claude-opus", { inPerM: 15, outPerM: 75 }],
  ["claude-sonnet", { inPerM: 3, outPerM: 15 }],
  ["claude-haiku", { inPerM: 0.8, outPerM: 4 }],
  ["opus", { inPerM: 15, outPerM: 75 }],
  ["sonnet", { inPerM: 3, outPerM: 15 }],
  ["haiku", { inPerM: 0.8, outPerM: 4 }],
  // OpenAI o-series (reasoning) — pricier; match before generic gpt
  ["o3", { inPerM: 2, outPerM: 8 }],
  ["o4", { inPerM: 2, outPerM: 8 }],
  ["o1", { inPerM: 15, outPerM: 60 }],
  // OpenAI GPT
  ["gpt-5", { inPerM: 1.25, outPerM: 10 }],
  ["gpt-4o-mini", { inPerM: 0.15, outPerM: 0.6 }],
  ["gpt-4o", { inPerM: 2.5, outPerM: 10 }],
  ["gpt-4", { inPerM: 2.5, outPerM: 10 }],
  ["gpt", { inPerM: 1.25, outPerM: 10 }],
  // Google Gemini
  ["gemini-2.5-pro", { inPerM: 1.25, outPerM: 10 }],
  ["gemini-1.5-pro", { inPerM: 1.25, outPerM: 5 }],
  ["gemini-2.5-flash", { inPerM: 0.3, outPerM: 2.5 }],
  ["gemini-2.0-flash", { inPerM: 0.1, outPerM: 0.4 }],
  ["gemini", { inPerM: 0.3, outPerM: 2.5 }],
];

/** Resolve the price for a model id by family substring, or `null` when unknown. */
export function priceForModel(model: string | undefined): ModelPrice | null {
  if (!model) return null;
  const id = model.toLowerCase();
  // Strip a leading `provider/` qualifier (e.g. `ollama/qwen`, `antigravity/...`).
  const bare = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  for (const [pattern, price] of PRICE_TABLE) {
    if (bare.includes(pattern)) return price;
  }
  return null;
}

/**
 * USD cost for a turn's token usage on `model`, or `null` when the model has no known
 * price (caller then shows tokens only). Local/keyless models (ollama/*) and unlisted
 * families return null by design — there is no real dollar cost to display.
 */
export function costForUsage(model: string | undefined, usage: TokenUsage | null | undefined): number | null {
  if (!usage) return null;
  const price = priceForModel(model);
  if (!price) return null;
  const cost = (usage.inputTokens / 1_000_000) * price.inPerM + (usage.outputTokens / 1_000_000) * price.outPerM;
  return Number.isFinite(cost) ? cost : null;
}

/** Format a USD cost compactly: `$0.42`, `$1.20`, `$12.3`, `<$0.01` for tiny non-zero. */
export function formatCost(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  if (usd < 10) return `$${usd.toFixed(2)}`;
  if (usd < 100) return `$${usd.toFixed(1)}`;
  return `$${Math.round(usd)}`;
}
