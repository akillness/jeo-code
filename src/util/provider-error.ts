/**
 * Map a raw provider error (rate limit / auth / generic) to a concise, actionable
 * one-line message for the user. Provider adapters throw `ProviderHttpError`
 * (carrying `.status` and a body), and the agent loop surfaces failures both as a
 * thrown error and as a `doneReason`, so this lives in a shared util used by both.
 */
import { isUsageLimitError } from "./retry";

export function friendlyProviderError(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  const status = (err as { status?: number })?.status;
  const provider = /anthropic/i.test(msg)
    ? "Anthropic"
    : /openai/i.test(msg)
      ? "OpenAI"
      : /gemini|google/i.test(msg)
        ? "Gemini"
        : "the provider";

  if (isUsageLimitError(err)) {
    return `${provider} usage/quota limit reached — this window will not clear in seconds, so auto-retry was skipped. Switch model with /model (e.g. a local ollama model), use another provider, or wait for the limit window to reset.`;
  }
  if (status === 429 || /\b429\b/.test(msg) || /rate[ _]?limit/i.test(msg)) {
    return `Rate limited by ${provider} (HTTP 429). Auto-retry was exhausted — wait a moment and resend, slow your request rate, or switch model with /model (a local ollama model never rate-limits).`;
  }
  if (status === 401 || status === 403 || /\b40[13]\b/.test(msg)) {
    return `${provider} rejected the credential (HTTP ${status ?? "401/403"}). Run 'joc auth status', re-login with /provider login <name>, or set the provider API key — then retry.`;
  }
  return msg;
}
