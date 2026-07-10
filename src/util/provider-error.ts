/**
 * Map a raw provider error (rate limit / auth / generic) to a concise, actionable
 * one-line message for the user. Provider adapters throw `ProviderHttpError`
 * (carrying `.status` and a body), and the agent loop surfaces failures both as a
 * thrown error and as a `doneReason`, so this lives in a shared util used by both.
 */
import { isUsageLimitError, isRefusalError, isConnectionError, ConnectionContextError } from "./retry";
import { companyLabel } from "../ai/model-catalog";
import { ProviderHttpError, ProviderStreamError } from "../ai/providers/errors";
// Re-export: engine.ts and callers import the refusal predicate from here; the
// definition lives in retry.ts so defaultRetryable can fail fast without a cycle.
export { isRefusalError } from "./retry";

/** Provider-authoritative context-overflow signal (HTTP 400/413 family). The
 *  local token estimate can drift under the real count (images, tokenizer
 *  mismatch) — when the PROVIDER says the prompt doesn't fit, the loop can react
 *  (reactive trim + one retry) instead of dying on an opaque 400 (round-6 #4). */
export function isContextOverflowError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const status = statusOf(err);
  const pattern = /context[ _-]?length|context window|prompt is too long|input is too long|too many tokens|maximum (input|context)|exceeds.{0,30}(context|token)/i;
  if (pattern.test(msg)) return true;
  return status === 413; // payload-too-large is always an overflow signal
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

/** Narrow an unknown error to one carrying a numeric `.status` field — covers the
 *  known structured classes AND ad-hoc errors a caller/test attaches `.status` to
 *  directly (`Object.assign(new Error(...), { status: 413 })`), matching the prior
 *  permissive cast-based read without an unchecked `as`. */
function hasNumericStatus(err: unknown): err is { status: number } {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof err.status === "number"
  );
}

/** True provider label for an error, when it's known: `ProviderHttpError`/
 *  `ProviderStreamError` always carry the ACTUAL backend's DISPLAY label (already
 *  `companyLabel`'d at every throw site — see `relabelProviderError`'s callers), so
 *  use it as-is rather than guessing from message text. `undefined` for anything else
 *  (bare `Error`, a re-wrapped doneReason string, …), letting the caller fall back to
 *  the regex-based guess below. */
function knownErrorProvider(err: unknown): string | undefined {
  if (err instanceof ProviderHttpError || err instanceof ProviderStreamError) {
    return err.provider;
  }
  return undefined;
}

function statusOf(err: unknown): number | undefined {
  if (err instanceof ProviderHttpError || err instanceof ProviderStreamError) {
    return err.status;
  }
  return hasNumericStatus(err) ? err.status : undefined;
}

function retryAfterMsOf(err: unknown): number | undefined {
  return err instanceof ProviderHttpError ? err.retryAfterMs : undefined;
}

export function friendlyProviderError(err: unknown): string {
  if (err instanceof ConnectionContextError) {
    const provider = companyLabel(err.provider);
    const target = err.baseUrl ? ` at ${err.baseUrl}` : "";
    const isLocal = err.provider === "ollama" || err.provider === "lmstudio";
    const hint = isLocal
      ? ` Start the ${provider} server (or check it's still running), verify the base URL in 'jeo setup' / config.json ('${err.provider}BaseUrl'), or switch model with /model.`
      : ` Check the configured base URL, your network connection, or switch model with /model.`;
    return `Could not connect to ${provider}${target}.${hint}`;
  }
  if (isConnectionError(err)) {
    return `Could not connect to the provider. Check the configured base URL, your network connection, or switch model with /model.`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  const status = statusOf(err);
  // Prefer the error's OWN carried provider (accurate even for compat backends like
  // Tencent/groq that speak Anthropic's/OpenAI's wire protocol — see
  // `relabelProviderError`); only guess from message text for errors that never
  // carried a `.provider` field (bare Error, a re-wrapped doneReason string, …).
  const provider = knownErrorProvider(err) ?? (
    /antigravity/i.test(msg)
      ? "Antigravity"
      : /anthropic/i.test(msg)
        ? "Anthropic"
        : /openai/i.test(msg)
          ? "OpenAI"
          : /gemini|google/i.test(msg)
            ? "Gemini"
            : "the provider"
  );

  if (isUsageLimitError(err)) {
    return `${provider} usage/quota limit reached — this window will not clear in seconds, so auto-retry was skipped. Switch model with /model (e.g. a local ollama model), use another provider, or wait for the limit window to reset.`;
  }
  if (status === 402 || /\b402\b/.test(msg) || /payment required|insufficient credit|billing (?:is )?not enabled|free trial quota/i.test(msg)) {
    return `${provider} requires billing/payment on this account (HTTP 402) — free trial quota exhausted or postpaid billing not enabled. Enable billing on the ${provider} account, or switch model with /model.`;
  }
  if (status === 429 || /\b429\b/.test(msg) || /rate[ _]?limit/i.test(msg)) {
    const retryAfterMs = retryAfterMsOf(err);
    const retry = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? ` Server requested retry after ${formatDuration(retryAfterMs)}.`
      : "";
    return `Rate limited by ${provider} (HTTP 429).${retry} Auto-retry cannot clear this window right now — slow your request rate, wait for the reset, or switch model with /model (a local ollama model never rate-limits).`;
  }
  if (status === 401 || status === 403 || /\b40[13]\b/.test(msg)) {
    return `${provider} rejected the credential (HTTP ${status ?? "401/403"}). Run 'jeo auth status', re-login with /provider login <name>, and for Antigravity prefer '/provider login antigravity' (gemini login only works when the Cloud Code Assist backend authorizes that token).`;
  }
  // A persistent 5xx (server-side fault on the provider's backend) — `ProviderHttpError`
  // already embeds the numeric status directly in its message ("… failed (HTTP 500) …",
  // caught here too, redundantly but harmlessly), but `ProviderStreamError` (the in-band
  // SSE/stream error shape — antigravity.ts/gemini.ts's `google.rpc.Status` and
  // openai-responses.ts's `response.failed`/`error` events) composes its `.message` from
  // a STRING status code only ("Antigravity stream failed (INTERNAL): internal error"),
  // never the numeric one, even though `.status` carries it correctly (explicitStatus
  // for antigravity/gemini's google.rpc.Status `error.code`; the 500 default for
  // openai-responses's non-rate_limit_exceeded codes). Without a digit anywhere in the
  // text, launch.ts's `routeFailureReason` `/\b(?:500|502|503|504|529)\b/` text regex
  // never matched, so the equivalent-pool fallback never fired for a stream-shaped 5xx
  // even with a credentialed same-tier fallback sitting right there.
  if (status !== undefined && status >= 500 && status < 600) {
    return `${provider} hit a persistent server-side error (HTTP ${status}) — ${msg}. The provider's backend itself is failing; switch model with /model or wait and retry.`;
  }
  if ((err instanceof Error && err.name === "TimeoutError") || /the operation timed out/i.test(msg)) {
    return `${provider} did not complete the request within the call timeout (default 30min). This is expected for a HIGH/XHIGH-reasoning-effort completion that legitimately runs long on a hard problem — raise JEO_CALL_TIMEOUT_MS (ms) if this recurs, or lower the thinking level with /model.`;
  }
  if (/exceeded the overall deadline \(JEO_STREAM_MAX_MS\)/i.test(msg)) {
    return `${provider}'s stream hit the overall deadline (default 30min; JEO_STREAM_MAX_MS) despite staying active. Raise JEO_STREAM_MAX_MS (ms), set it to 0 to disable the overall cap, or lower the thinking level with /model.`;
  }
  if (isContextOverflowError(err)) {
    return `${provider} rejected the request: the conversation no longer fits the model's context window. Run /compact, drop large attachments, or start a fresh session.`;
  }
  if (isRefusalError(err)) {
    const base = `${provider} declined to answer (safety refusal — no content returned). Usually a content classifier tripped on recently read file/search content: /retry, /compact or /new to drop the triggering context, or switch model with /model. If this persists on a Claude subscription (OAuth) login, Anthropic restricts third-party OAuth clients — set ANTHROPIC_API_KEY or use another provider.`;
    const category = /Refusal \((\w+)\)/i.exec(msg)?.[1] ?? /category=(\w+)/i.exec(msg)?.[1];
    if (category === "reasoning_extraction") {
      return `${base} (Category: reasoning_extraction — this classifier flags requests that look like probing the model's internal reasoning; jeo's own thinking-block replay across multi-step tool use is a common benign trigger, not an actual violation. /retry after a /compact usually clears it.)`;
    }
    return base;
  }
  if (status === 404) {
    return `${provider} does not recognize the requested model (HTTP 404). The id may be retired, gated, or mistyped — pick another with /model.`;
  }
  return msg;
}
