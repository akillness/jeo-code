import type { ProviderAdapter, CallOptions, ProviderName } from "../types";
import { anthropicAdapter } from "./anthropic";
import { relabelProviderError } from "./errors";
import { companyLabel } from "../model-catalog";

/**
 * Factory for Anthropic-Messages-compatible providers (z.ai, MiniMax, …). They speak
 * the same `/v1/messages` wire protocol as Anthropic with an `x-api-key` bearer, so each
 * is a thin shim over `anthropicAdapter`: strip the `<name>/` routing prefix and pin the
 * base URL (resolved upstream into `options.baseUrl`). The credential is an api_key —
 * `anthropicAdapter` emits the plain `x-api-key` Messages headers for api_key creds
 * (no Claude-Code OAuth cloaking / billing / betas), so it works as a generic client.
 */
export function makeAnthropicCompatibleAdapter(opts: { name: ProviderName; baseUrl: string }): ProviderAdapter {
  const prefix = `${opts.name}/`;
  const label = companyLabel(opts.name);
  const prep = (o: CallOptions): CallOptions => ({
    ...o,
    model: o.model.startsWith(prefix) ? o.model.slice(prefix.length) : o.model,
    baseUrl: o.baseUrl ?? opts.baseUrl,
  });
  // `anthropicAdapter` hardcodes "Anthropic" as the provider label on every thrown
  // ProviderHttpError/ProviderStreamError — relabel to the REAL backend (e.g. "Tencent",
  // "z.ai") so friendlyProviderError/the fallback classifier/the user all see the true
  // account that needs attention (auth, billing, rate limit) instead of Anthropic's.
  return {
    name: opts.name,
    supportsNativeTools: anthropicAdapter.supportsNativeTools,
    call: async (messages, options, credential) => {
      try {
        return await anthropicAdapter.call(messages, prep(options), credential);
      } catch (err) {
        throw relabelProviderError(err, label);
      }
    },
    async *stream(messages, options, credential) {
      try {
        yield* anthropicAdapter.stream!(messages, prep(options), credential);
      } catch (err) {
        throw relabelProviderError(err, label);
      }
    },
  };
}
