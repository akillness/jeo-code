import type { Credential } from "../../auth";
import { makeOpenAICompatibleAdapter } from "./openai-compatible";

/**
 * Kimi (Moonshot) — OpenAI-compatible cloud API at https://api.moonshot.ai/v1, keyed
 * by KIMI_API_KEY (or `providers.kimi`). The credential (an api_key bearer) is passed
 * through; thinking models (kimi-thinking-preview) stream reasoning via
 * `reasoning_content`/`<think>`, which the openai adapter routes to onReasoning.
 */
export const KIMI_BASE_URL = "https://api.moonshot.ai/v1";

export const kimiAdapter = makeOpenAICompatibleAdapter({ name: "kimi", baseUrl: KIMI_BASE_URL });

/** Credential carrier for Kimi calls — an api_key bearer (the adapter only reads the
 *  token); a keyless `none` when no key is set. */
export function kimiCredential(key: string | undefined): Credential {
  return key ? { kind: "api_key", provider: "openai", token: key } : { kind: "none", provider: "openai" };
}
