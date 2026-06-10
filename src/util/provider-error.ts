/**
 * Map a raw provider error (rate limit / auth / generic) to a concise, actionable
 * one-line message for the user. Provider adapters throw `ProviderHttpError`
 * (carrying `.status` and a body), and the agent loop surfaces failures both as a
 * thrown error and as a `doneReason`, so this lives in a shared util used by both.
 */
import { isUsageLimitError } from "./retry";

function formatDuration(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.ceil(totalSeconds / 60);
  if (minutes < 60) return `~${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? `~${hours}h ${rem}m` : `~${hours}h`;
}

export function friendlyProviderError(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  const status = (err as { status?: number })?.status;
  const provider = /antigravity/i.test(msg)
    ? "Antigravity"
    : /anthropic/i.test(msg)
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
    const retryAfterMs = (err as { retryAfterMs?: number })?.retryAfterMs;
    const retry = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? ` Server requested retry after ${formatDuration(retryAfterMs)}.`
      : "";
    return `Rate limited by ${provider} (HTTP 429).${retry} Auto-retry cannot clear this window right now — slow your request rate, wait for the reset, or switch model with /model (a local ollama model never rate-limits).`;
  }
  if (status === 401 || status === 403 || /\b40[13]\b/.test(msg)) {
    return `${provider} rejected the credential (HTTP ${status ?? "401/403"}). Run 'joc auth status', re-login with /provider login <name>, and for Antigravity prefer '/provider login antigravity' (gemini login only works when the Cloud Code Assist backend authorizes that token).`;
  }
  return msg;
}
