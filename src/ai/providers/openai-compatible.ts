import type { ProviderAdapter, CallOptions, ProviderName } from "../types";
import type { Credential } from "../../auth";
import { openaiAdapter } from "./openai";

/**
 * Factory for OpenAI-compatible providers (LM Studio, xAI/Grok, …). They all speak
 * the same `/chat/completions` wire protocol, so each is a thin shim over
 * `openaiAdapter`: strip the `<name>/` routing prefix, pin the base URL, and pass the
 * credential (or force keyless for local servers that ignore auth). `keyless` keeps
 * the openai adapter on plain /chat/completions (an oauth credential would divert to
 * the Codex Responses backend).
 */
const KEYLESS: Credential = { kind: "none", provider: "openai" };

export function makeOpenAICompatibleAdapter(opts: { name: ProviderName; baseUrl: string; keyless?: boolean }): ProviderAdapter {
  const prefix = `${opts.name}/`;
  const prep = (o: CallOptions): CallOptions => ({
    ...o,
    model: o.model.startsWith(prefix) ? o.model.slice(prefix.length) : o.model,
    baseUrl: o.baseUrl ?? opts.baseUrl,
  });
  const credFor = (c: Credential): Credential => (opts.keyless ? KEYLESS : c);
  return {
    name: opts.name,
    supportsNativeTools: openaiAdapter.supportsNativeTools,
    call: (messages, options, credential) => openaiAdapter.call(messages, prep(options), credFor(credential)),
    async *stream(messages, options, credential) {
      yield* openaiAdapter.stream!(messages, prep(options), credFor(credential));
    },
  };
}
