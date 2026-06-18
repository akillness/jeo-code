import type { ProviderAdapter, CallOptions, ProviderName } from "../types";
import { anthropicAdapter } from "./anthropic";

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
  const prep = (o: CallOptions): CallOptions => ({
    ...o,
    model: o.model.startsWith(prefix) ? o.model.slice(prefix.length) : o.model,
    baseUrl: o.baseUrl ?? opts.baseUrl,
  });
  return {
    name: opts.name,
    supportsNativeTools: anthropicAdapter.supportsNativeTools,
    call: (messages, options, credential) => anthropicAdapter.call(messages, prep(options), credential),
    async *stream(messages, options, credential) {
      yield* anthropicAdapter.stream!(messages, prep(options), credential);
    },
  };
}
