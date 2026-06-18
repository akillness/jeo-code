import type { Credential } from "../../auth";
import { makeOpenAICompatibleAdapter } from "./openai-compatible";

/**
 * xAI (Grok) — OpenAI-compatible cloud API at https://api.x.ai/v1, keyed by
 * XAI_API_KEY (or `providers.xai`). The credential (an api_key bearer) is passed
 * through; grok reasoning models (grok-4.3, grok-4-fast-*, grok-code-fast-1) stream
 * reasoning via `reasoning_content`, which the openai adapter routes to onReasoning.
 */
export const XAI_BASE_URL = "https://api.x.ai/v1";

export const xaiAdapter = makeOpenAICompatibleAdapter({ name: "xai", baseUrl: XAI_BASE_URL });

/** Credential carrier for xAI calls — an api_key bearer (the adapter only reads the
 *  token); a keyless `none` when no key is set. */
export function xaiCredential(key: string | undefined): Credential {
  return key ? { kind: "api_key", provider: "openai", token: key } : { kind: "none", provider: "openai" };
}
