/**
 * Map a raw provider error (rate limit / auth / generic) to a concise, actionable
 * one-line message for the user. Provider adapters throw `ProviderHttpError`
 * (carrying `.status` and a body), and the agent loop surfaces failures both as a
 * thrown error and as a `doneReason`, so this lives in a shared util used by both.
 */
import { isUsageLimitError } from "./retry";

/** Provider-authoritative context-overflow signal (HTTP 400/413 family). The
 *  local token estimate can drift under the real count (images, tokenizer
 *  mismatch) — when the PROVIDER says the prompt doesn't fit, the loop can react
 *  (reactive trim + one retry) instead of dying on an opaque 400 (round-6 #4). */
export function isContextOverflowError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? String(err);
  const status = (err as { status?: number })?.status;
  const pattern = /context[ _-]?length|context window|prompt is too long|input is too long|too many tokens|maximum (input|context)|exceeds.{0,30}(context|token)/i;
  if (pattern.test(msg)) return true;
  return status === 413; // payload-too-large is always an overflow signal
}

/** Provider safety-refusal signal: an HTTP-200 completion that returned NO
 *  content because the model/provider declined (Anthropic `stop_reason=refusal`,
 *  OpenAI `finish_reason=content_filter`, Gemini `SAFETY`/`PROHIBITED_CONTENT`
 *  block reasons). On routine coding work these are usually transient
 *  false-positives — the engine retries the step (bounded) instead of killing
 *  the turn with a dead "Error: … returned no content". */
export function isRefusalError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? String(err);
  return /stop_reason=refusal|finish_reason=content_filter|\(content_filter\)|\(SAFETY\)|\(PROHIBITED_CONTENT\)|\(BLOCKLIST\)/i.test(msg);
}

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
    return `${provider} rejected the credential (HTTP ${status ?? "401/403"}). Run 'jeo auth status', re-login with /provider login <name>, and for Antigravity prefer '/provider login antigravity' (gemini login only works when the Cloud Code Assist backend authorizes that token).`;
  }
  if (isContextOverflowError(err)) {
    return `${provider} rejected the request: the conversation no longer fits the model's context window. Run /compact, drop large attachments, or start a fresh session.`;
  }
  if (isRefusalError(err)) {
    return `${provider} declined to answer (safety refusal — no content returned) even after automatic retries with a context reset. Usually a content classifier tripped on recently read file/search content: /retry once more, /compact or /new to drop the triggering context, or switch model with /model. If this persists on a Claude subscription (OAuth) login, Anthropic restricts third-party OAuth clients — set ANTHROPIC_API_KEY or use another provider.`;
  }
  if (status === 404) {
    return `${provider} does not recognize the requested model (HTTP 404). The id may be retired, gated, or mistyped — pick another with /model.`;
  }
  return msg;
}
