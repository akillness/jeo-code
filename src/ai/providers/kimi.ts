import type { Credential } from "../../auth";
import { getKimiCommonHeaders } from "../../auth/flows/kimi";
import type { CallOptions, ProviderAdapter } from "../types";
import { anthropicAdapter } from "./anthropic";
import { makeOpenAICompatibleAdapter } from "./openai-compatible";
import { relabelProviderError } from "./errors";
import { companyLabel } from "../model-catalog";

/**
 * Kimi (Moonshot) — two credential-dependent backends (gjc parity):
 * - API key (KIMI_API_KEY / `providers.kimi`): OpenAI-compatible cloud API at
 *   https://api.moonshot.ai/v1. Thinking models (kimi-thinking-preview) stream
 *   reasoning via `reasoning_content`/`<think>` → onReasoning.
 * - OAuth (Kimi Code subscription, device-code login): Anthropic-compatible API at
 *   https://api.kimi.com/coding (`${base}/v1/messages` pinned by the anthropic
 *   adapter), authenticated with `Authorization: Bearer` + X-Msh-* device headers.
 */
export const KIMI_BASE_URL = "https://api.moonshot.ai/v1";
// gjc: KIMI_ANTHROPIC_BASE_URL — the SDK/adapter appends /v1/messages, so no /v1 here.
export const KIMI_ANTHROPIC_BASE_URL = "https://api.kimi.com/coding";

const openaiCompatKimi = makeOpenAICompatibleAdapter({ name: "kimi", baseUrl: KIMI_BASE_URL });
const KIMI_LABEL = companyLabel("kimi");

/** Route the `kimi/` prefix + OAuth base/headers onto the anthropic adapter. */
// ponytail: model ids pass through untranslated — the moonshot catalog ids (kimi-latest, …)
// may not exist on the Kimi Code endpoint (which serves e.g. kimi-for-coding). Upgrade path:
// add kimi-code entries to model-catalog.ts and map them here per credential kind.
function prepOAuth(o: CallOptions): CallOptions {
  return {
    ...o,
    model: o.model.startsWith("kimi/") ? o.model.slice(5) : o.model,
    baseUrl: o.baseUrl ?? KIMI_ANTHROPIC_BASE_URL,
    extraHeaders: { ...getKimiCommonHeaders(), ...o.extraHeaders },
  };
}

/** Dispatch on credential kind: OAuth → Kimi Code Anthropic endpoint; else the
 *  original OpenAI-compatible moonshot adapter (API-key behavior unchanged).
 *  The OAuth path delegates to `anthropicAdapter`, which hardcodes "Anthropic" at
 *  its `ProviderHttpError`/`ProviderStreamError` construction sites — relabel to
 *  "Moonshot" (same fix as `makeAnthropicCompatibleAdapter`/`makeOpenAICompatibleAdapter`)
 *  so a Kimi Code failure never sends the user to fix their Anthropic account. */
export const kimiAdapter: ProviderAdapter = {
  name: "kimi",
  supportsNativeTools: openaiCompatKimi.supportsNativeTools,
  call: async (messages, options, credential) => {
    if (credential.kind !== "oauth") return openaiCompatKimi.call(messages, options, credential);
    try {
      return await anthropicAdapter.call(messages, prepOAuth(options), credential);
    } catch (err) {
      throw relabelProviderError(err, KIMI_LABEL);
    }
  },
  async *stream(messages, options, credential) {
    if (credential.kind !== "oauth") {
      yield* openaiCompatKimi.stream!(messages, options, credential);
      return;
    }
    try {
      yield* anthropicAdapter.stream!(messages, prepOAuth(options), credential);
    } catch (err) {
      throw relabelProviderError(err, KIMI_LABEL);
    }
  },
};

/** Credential carrier for Kimi calls — an api_key bearer (the adapter only reads the
 *  token); a keyless `none` when no key is set. */
export function kimiCredential(key: string | undefined): Credential {
  return key ? { kind: "api_key", provider: "openai", token: key } : { kind: "none", provider: "openai" };
}
