import type { ProviderAdapter, CallOptions, ProviderName } from "../types";
import type { Credential } from "../../auth";
import { openaiAdapter } from "./openai";
import { relabelProviderError } from "./errors";
import { companyLabel } from "../model-catalog";

/**
 * Factory for OpenAI-compatible providers (LM Studio, xAI/Grok, …). They all speak
 * the same `/chat/completions` wire protocol, so each is a thin shim over
 * `openaiAdapter`: strip the `<name>/` routing prefix, pin the base URL, and pass the
 * credential (or force keyless for local servers that ignore auth). `keyless` keeps
 * the openai adapter on plain /chat/completions (an oauth credential would divert to
 * the Codex Responses backend).
 */
const KEYLESS: Credential = { kind: "none", provider: "openai" };

export function makeOpenAICompatibleAdapter(opts: { name: ProviderName; baseUrl: string; keyless?: boolean; thinkingFormat?: CallOptions["reasoningFormat"] }): ProviderAdapter {
  const prefix = `${opts.name}/`;
  const label = companyLabel(opts.name);
  const prep = (o: CallOptions): CallOptions => ({
    ...o,
    model: o.model.startsWith(prefix) ? o.model.slice(prefix.length) : o.model,
    baseUrl: o.baseUrl ?? opts.baseUrl,
    // Carry the backend's native-reasoning enablement so openaiRequest can turn thinking
    // on with the right param (gjc parity) — without it OpenRouter/Qwen models stay silent.
    reasoningFormat: o.reasoningFormat ?? opts.thinkingFormat,
  });
  const credFor = (c: Credential): Credential => (opts.keyless ? KEYLESS : c);
  // `openaiAdapter` hardcodes "OpenAI" as the provider label on every thrown
  // ProviderHttpError/ProviderStreamError — relabel to the REAL backend (e.g. "Groq",
  // "DeepSeek") so friendlyProviderError/the fallback classifier/the user all see the
  // true account that needs attention (auth, billing, rate limit) instead of OpenAI's.
  return {
    name: opts.name,
    supportsNativeTools: openaiAdapter.supportsNativeTools,
    call: async (messages, options, credential) => {
      try {
        return await openaiAdapter.call(messages, prep(options), credFor(credential));
      } catch (err) {
        throw relabelProviderError(err, label);
      }
    },
    async *stream(messages, options, credential) {
      try {
        yield* openaiAdapter.stream!(messages, prep(options), credFor(credential));
      } catch (err) {
        throw relabelProviderError(err, label);
      }
    },
  };
}
