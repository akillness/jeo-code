export interface RetryOptions {
  retries?: number;        // default 3 total attempts
  baseDelayMs?: number;    // default 250
  maxDelayMs?: number;     // default 4000
  isRetryable?: (err: unknown, attempt: number) => boolean;
  sleep?: (ms: number) => Promise<void>;   // injectable for tests (default real setTimeout)
  random?: () => number;   // injectable RNG for jitter (default Math.random); equal-jitter in [0.5x, 1x]
  /** Notified before each backoff wait; `delayMs` is the wait actually applied.
   *  Returning `false` (explicitly) aborts the retry ladder immediately — the
   *  pending error is thrown right away instead of sleeping and re-attempting.
   *  Lets a caller with a same-tier FALLBACK model available bail out of a
   *  same-model rate-limit retry loop early rather than riding the full
   *  `rateLimitRetries` budget (up to ~90s of escalating backoff) before the
   *  turn-level equivalent-pool fallback ever gets a chance to switch models.
   *  Any other return value (including `undefined`, the common case) continues
   *  the retry ladder unchanged. */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void | false;
  /** Aborts an in-progress backoff wait (e.g. Ctrl-C / turn cancel). Already-aborted or
   *  aborted-mid-wait rejects immediately instead of completing the sleep — the escape hatch
   *  for a long, honored provider `Retry-After` (see `rateLimitMaxServerDelayMs`: those are no
   *  longer capped by default). Does NOT cancel the in-flight `fn()` call itself; thread the
   *  same signal into the request (e.g. `fetch`) for that. */
  signal?: AbortSignal;
  /** Minimum backoff (ms) applied specifically to rate-limit (429) errors. The floor
   *  ESCALATES per attempt (floor × 2^(attempt-1), capped at RATE_LIMIT_FLOOR_CAP_MS) because a
   *  rate-limit window rarely clears in <1s and often needs tens of seconds — a flat
   *  sub-second retry cadence just burns the budget; default 0 (no floor) preserves
   *  generic behavior. */
  rateLimitMinDelayMs?: number;
  /** Total attempt cap used specifically when the current error is a rate limit (429).
   *  When higher than `retries`, rate-limit errors get extra attempts so a transient
   *  per-minute window can reset; non-rate-limit errors still use `retries`. */
  rateLimitRetries?: number;
  /** Opt-in ceiling on a 429's server-directed retry delay: set it and a delay beyond it fails
   *  fast with the original error instead of sleeping. Unset (the default) honors ANY
   *  server-directed delay in full, however long — gjc parity: a generic rate limit is retried
   *  forever, not treated as fatal past some arbitrary budget. Usage/quota-limit errors
   *  (`isUsageLimitError`) are unaffected either way: `defaultRetryable` already classifies
   *  them non-retryable before this wait is ever computed. Pair with `signal` so an unbounded
   *  wait stays user-cancellable. */
  rateLimitMaxServerDelayMs?: number;
}

// Default retryable predicate: true for transient network errors, transient/overload
// keywords, or a transient HTTP status (408/425/429/500/502/503/504/529) found either on a
// numeric `.status` field or embedded as "HTTP <code>" in the error message.
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
export function defaultRetryable(err: unknown): boolean {
  if (!err) {
    return false;
  }
  // Persistent usage/quota limits (e.g. a subscription window exhausted) never clear
  // within a retry budget — fail fast so the caller can switch model/provider instead
  // of sitting through the whole backoff ladder (gjc parity: QUOTA_EXHAUSTED is not
  // retried like a per-minute 429).
  if (isUsageLimitError(err)) {
    return false;
  }
  // Safety refusals are DETERMINISTIC for identical conversation content: the
  // classifier trips on what's IN the context, so a transport-level resend of the
  // same payload re-refuses every time (observed: each engine ladder rung burned
  // 2 extra billed calls before this check). Fail fast — the engine's refusal
  // ladder owns recovery because it mutates the context between attempts.
  if (isRefusalError(err)) {
    return false;
  }
  // A pre-response connection failure (refused / unresolved host) — retryable: a
  // local provider that is mid-restart, or a transient DNS blip, can clear within
  // the backoff budget. A provider that is simply never running exhausts the
  // budget and surfaces friendlyProviderError's actionable message instead of a
  // bare "Unable to connect" (see isConnectionError's docs for the full rationale).
  if (isConnectionError(err)) {
    return true;
  }

  let message = "";
  if (err instanceof Error) {
    message = err.message;
  } else if (typeof err === "object" && "message" in err && typeof (err as any).message === "string") {
    message = (err as any).message;
  } else {
    message = String(err);
  }

  const lowerMessage = message.toLowerCase();
  if (
    lowerMessage.includes("fetch") ||
    lowerMessage.includes("network") ||
    lowerMessage.includes("econn") ||
    lowerMessage.includes("timeout") ||
    lowerMessage.includes("overloaded") ||
    lowerMessage.includes("rate limit") ||
    lowerMessage.includes("rate_limit") ||
    // A per-chunk stream-idle stall ("stream idle for <ms>ms (no chunk)") is a
    // transient stall (provider load / long TTFT) — retry it like a timeout. The
    // OVERALL-deadline message ("stream exceeded the overall deadline") is a hard
    // wall-clock cap and is deliberately NOT matched here (it must fail fast).
    lowerMessage.includes("stream idle") ||
    lowerMessage.includes("no chunk") ||
    // A live TCP/TLS socket dying mid-request/mid-stream — Bun's fetch/undici
    // ("The socket connection was closed unexpectedly …", the ConnectionClosed
    // class) and Node's equivalent ("socket hang up", "other side closed",
    // UND_ERR_SOCKET). Field case: OpenAI Codex OAuth SSE streams through
    // chatgpt.com's backend die mid-stream after ~20-30min of active traffic
    // (an infra-side connection-duration cap, not an idle timeout) — the
    // request itself is fine, a fresh connection succeeds.
    lowerMessage.includes("socket connection was closed") ||
    lowerMessage.includes("socket hang up") ||
    lowerMessage.includes("other side closed") ||
    lowerMessage.includes("und_err_socket")
  ) {
    return true;
  }

  // Transient empty 200s — a provider returned a successful response with no content.
  // This is a known intermittent failure (load/edge races on Anthropic/Gemini/OpenAI), so
  // retry it like an overload instead of letting one empty reply drop the turn. EXCEPTION:
  // deterministic budget exhaustion (max_tokens / length / "output budget exhausted") re-empties
  // on every retry — fail fast so the caller sees the raise-maxTokens/lower-thinking hint.
  if (lowerMessage.includes("returned no content")) {
    return !/max_tokens|max_output_tokens|finish_reason=length|done_reason=length|output budget exhausted/.test(lowerMessage);
  }

  // Numeric `.status` field (structured provider errors, fetch responses).
  if (typeof err === "object" && err !== null) {
    const status = (err as any).status;
    const numericStatus = typeof status === "number" ? status : (typeof status === "string" ? Number(status) : NaN);
    if (!isNaN(numericStatus) && RETRYABLE_STATUS.has(numericStatus)) {
      return true;
    }
  }

  // Fallback: a status embedded in the message, e.g. "... (HTTP 503): overloaded".
  const httpMatch = lowerMessage.match(/http[\s/]*?(\d{3})/);
  if (httpMatch && RETRYABLE_STATUS.has(Number(httpMatch[1]))) {
    return true;
  }

  return false;
}

// Synthetic per-minute floor for a 429 that carries NO server `Retry-After` (see
// `rateLimitMinDelayMs`) — caps the escalating floor so a SILENT rate limit still waits a
// realistic window instead of ~8s. Does NOT cap a genuine server-directed Retry-After: a
// provider that names its own wait is authoritative and is honored in full (gjc parity);
// `rateLimitMaxServerDelayMs` is the opt-in ceiling for a caller that truly cannot wait that long.
const RATE_LIMIT_FLOOR_CAP_MS = 30_000;

// Run fn; on a retryable error, back off and retry up to `retries` attempts. Backoff is
// exponential (baseDelay * 2^(attempt-1), capped at maxDelay) with equal jitter (the wait lands
// in [0.5x, 1x] of that cap). A server-directed `retryAfterMs` (Retry-After) wins over the
// jitter and is honored IN FULL — no cap — unless `rateLimitMaxServerDelayMs` is explicitly set
// and exceeded, in which case the original error is re-thrown immediately instead of sleeping.
// `opts.signal` can abort an in-progress wait, so an unbounded honored delay stays cancellable.
export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  const retries = opts?.retries ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 250;
  const maxDelayMs = opts?.maxDelayMs ?? 4000;
  const isRetryable = opts?.isRetryable ?? defaultRetryable;
  const sleep = opts?.sleep ?? ((ms: number) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  });
  const random = opts?.random ?? Math.random;
  const onRetry = opts?.onRetry;
  const rateLimitMinDelayMs = opts?.rateLimitMinDelayMs ?? 0;
  const rateLimitRetries = opts?.rateLimitRetries;
  const rateLimitMaxServerDelayMs = opts?.rateLimitMaxServerDelayMs;
  const signal = opts?.signal;

  let attempt = 1;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      // Rate-limit (429) errors may use a higher attempt cap so a transient per-minute window
      // can reset before we surface the failure. `rateLimitMaxServerDelayMs` is opt-in
      // (unset by default): only when explicitly configured and the server's own wait exceeds
      // it do we fail fast instead of sleeping through a window the caller declared too long.
      const rateLimited = isRateLimitError(err);
      const serverDelay = retryAfterOf(err);
      if (
        rateLimited &&
        typeof rateLimitMaxServerDelayMs === "number" &&
        serverDelay !== undefined &&
        serverDelay > rateLimitMaxServerDelayMs
      ) {
        throw err;
      }
      const cap = rateLimited && typeof rateLimitRetries === "number" ? Math.max(retries, rateLimitRetries) : retries;
      if (attempt >= cap || !isRetryable(err, attempt)) {
        throw err;
      }

      const capped = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      // Equal jitter: half fixed + half random → [0.5x, 1x] of the capped backoff.
      const jittered = capped / 2 + random() * (capped / 2);
      // Server `Retry-After` wins, honored IN FULL (no cap — gjc parity: even a multi-hour
      // provider-directed window is retried, never silently compressed). For rate limits,
      // apply the floor in BOTH cases so a 0/near-0 Retry-After (or sub-second jitter) doesn't
      // burn the 429 budget back-to-back with no real pause. The floor escalates per attempt
      // (×2 each retry, capped at RATE_LIMIT_FLOOR_CAP_MS) so a SYNTHETIC (server-silent) wait
      // spans a realistic rate-limit window (~a minute) instead of ~8s.
      const base = serverDelay !== undefined ? serverDelay : jittered;
      const floor = rateLimited
        ? Math.min(rateLimitMinDelayMs * Math.pow(2, attempt - 1), RATE_LIMIT_FLOOR_CAP_MS)
        : 0;
      const delay = Math.max(base, floor);

      // A `false` return from onRetry means the caller wants to bail NOW instead of
      // sleeping and re-attempting (see RetryOptions.onRetry's doc comment) — throw
      // the pending error immediately rather than entering the backoff wait.
      if (onRetry && onRetry(attempt, err, delay) === false) {
        throw err;
      }

      await abortableSleep(sleep, delay, signal);
      attempt++;
    }
  }
}

/** Race `sleep(ms)` against `signal`; an already-aborted or mid-wait-aborted signal rejects
 *  immediately with its abort reason instead of completing the wait. Keeps a long, honored
 *  server-directed retry delay (see `withRetry`) user-cancellable even though it is no longer
 *  capped. A no-op passthrough when no signal is supplied (existing callers/tests unaffected). */
function abortableSleep(sleep: (ms: number) => Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onAbort = () => reject(signal.reason ?? new Error("aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
  sleep(ms).then(
    value => { signal.removeEventListener("abort", onAbort); resolve(value); },
    err => { signal.removeEventListener("abort", onAbort); reject(err); },
  );
  return promise;
}

/** Abortable wait for the ENGINE's post-ladder refusal backoff: resolves EARLY (never
 *  rejects) when `signal` aborts, so the agent loop's top-of-loop cancellation check
 *  owns the exit path. Distinct from the rejecting `abortableSleep` inside `withRetry`,
 *  whose callers need the abort reason propagated as an error. */
export function waitAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    resolve();
    return promise;
  }
  const finish = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", finish);
    resolve();
  };
  const timer = setTimeout(finish, ms);
  signal?.addEventListener("abort", finish, { once: true });
  return promise;
}

// Extract a non-negative `retryAfterMs` from an error, if it carries one (e.g. ProviderHttpError).
function retryAfterOf(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    const v = (err as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  }
  return undefined;
}

// True when an error is an HTTP 429 / rate-limit (structured `.status` or message text).
export function isRateLimitError(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const status = (err as { status?: unknown }).status;
    const n = typeof status === "number" ? status : typeof status === "string" ? Number(status) : NaN;
    if (n === 429) return true;
  }
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /\b429\b/.test(message) || /rate[ _]?limit/i.test(message);
}

/** Message text of an unknown error (Error / string / object with message). */
function errorMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return "";
}

/**
 * Persistent usage/quota-limit detection (gjc parity: `isUsageLimitError`). These are
 * subscription/window limits ("usage limit reached", "quota exceeded", model/message
 * window limits, credit exhaustion, Anthropic ACCOUNT-level exhaustion) that need a
 * model or credential switch — retrying within seconds is pure waste, unlike a
 * per-minute 429. Bare "resource exhausted" (gRPC capacity wording) stays transient;
 * only the qualified "Resource has been exhausted (… quota/limit)" form is persistent
 * (gjc fixture parity: rate-limit-utils.test.ts).
 */
const USAGE_LIMIT_PATTERN = /usage.?limit|usage_limit_reached|usage_not_included|limit_reached|model.?limit|message.?limit|limit for this model|quota.?exceeded|out_of_credits|request would exceed your account.?s rate limit|resource has been exhausted[^\n]*(?:quota|limit)|exceeded your/i;
export function isUsageLimitError(err: unknown): boolean {
  return USAGE_LIMIT_PATTERN.test(errorMessageOf(err));
}

/** Provider safety-refusal signal: an HTTP-200 completion that returned NO
 *  content because the model/provider declined (Anthropic `stop_reason=refusal`,
 *  OpenAI `finish_reason=content_filter`, Gemini `SAFETY`/`PROHIBITED_CONTENT`
 *  block reasons). Lives here (not provider-error.ts) so `defaultRetryable` can
 *  fail fast on it: a refusal is DETERMINISTIC for the same conversation content —
 *  transport-level resends of an identical payload just burn billed calls. The
 *  engine's refusal ladder (resend → context reset → guidance strip, then unbounded
 *  capped backoff — gjc parity: a refusal is never terminal) is the correct recovery
 *  layer because it MUTATES the context between attempts. */
export function isRefusalError(err: unknown): boolean {
  return /stop_reason=refusal|finish_reason=content_filter|\(content_filter\)|(?:block|finish)Reason=(?:SAFETY|PROHIBITED_CONTENT|BLOCKLIST|RECITATION|SPII)|Refusal \(\w+\)/i.test(errorMessageOf(err));
}
/** True for a live TCP/TLS socket dying mid-request/mid-stream — Bun's fetch/undici
 *  ("The socket connection was closed unexpectedly …", the ConnectionClosed class)
 *  and Node's equivalent ("socket hang up", "other side closed", UND_ERR_SOCKET).
 *  DELIBERATELY NARROWER than `defaultRetryable`: a rate-limit/5xx/timeout error has
 *  already been through the model-manager's own `withRetry` budget (with visible
 *  `onRetry` notices) by the time it reaches the engine, so re-retrying it there would
 *  silently double the retry budget. A mid-stream socket drop is structurally
 *  DIFFERENT — `retryableStream` (model-manager.ts) only auto-retries losing the FIRST
 *  chunk; once any chunk has streamed it deliberately stops (a full re-call would
 *  replay already-emitted content), so this class NEVER gets a model-manager retry at
 *  all and needs its own engine-level recovery (see `transientNetworkRetries`). Field
 *  case: OpenAI Codex OAuth SSE through chatgpt.com's backend dies mid-stream after
 *  ~20-30min of active traffic (an infra connection-duration cap, not a broken network —
 *  a fresh request succeeds). */
export function isTransientStreamDropError(err: unknown): boolean {
  return /socket connection was closed|socket hang up|other side closed|und_err_socket/i.test(errorMessageOf(err));
}

/** True for a pre-response TCP-level connection failure — the request never reached
 *  a server at all (refused, DNS unresolved, host unreachable), as opposed to a
 *  server responding with an error status or a mid-stream drop (see
 *  `isTransientStreamDropError` for the latter). Bun's fetch/undici throws a bare
 *  `Error("Unable to connect. Is the computer able to access the url?")` with
 *  `.code === "ConnectionRefused"` for BOTH a refused connection and an unresolvable
 *  host — no HTTP status is ever attached, so `defaultRetryable`'s status-based
 *  checks never catch it. Node's equivalent carries a `.code` of ECONNREFUSED /
 *  ENOTFOUND / EHOSTUNREACH / EAI_AGAIN. Most commonly hit when a local provider
 *  (ollama/lmstudio) isn't running, or a custom base URL is misconfigured — see
 *  `friendlyProviderError`, which turns this into an actionable message naming the
 *  provider and base URL (attached by model-manager's `resolveCall` callers). */
export function isConnectionError(err: unknown): boolean {
  let code: string | undefined;
  if (err && typeof err === "object" && "code" in err) code = String(err.code);
  if (code && ["ConnectionRefused", "ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "EAI_AGAIN"].includes(code)) return true;
  return /unable to connect\. is the computer able to access the url\?/i.test(errorMessageOf(err));
}

/** A raw `isConnectionError` failure re-thrown with the provider/URL context the bare
 *  fetch error never carries (see `isConnectionError`'s docs). `.cause` preserves the
 *  original error so `isConnectionError`/`defaultRetryable` still recognize it (both
 *  inspect `.code` and the message text, which this class forwards). */
export class ConnectionContextError extends Error {
  readonly code: string | undefined;
  constructor(readonly provider: string, readonly baseUrl: string | undefined, cause: unknown) {
    const causeCode = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : undefined;
    super(errorMessageOf(cause), { cause });
    this.name = "ConnectionContextError";
    this.code = causeCode;
  }
}

/** Run `fn`; a raw `isConnectionError` failure is re-thrown as a `ConnectionContextError`
 *  naming `provider`/`baseUrl` so `friendlyProviderError` can turn Bun's context-free
 *  "Unable to connect. Is the computer able to access the url?" into an actionable
 *  message. Every other error (including a non-connection failure) passes through
 *  unchanged. */
export async function withConnectionContext<T>(fn: () => Promise<T>, provider: string, baseUrl: string | undefined): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isConnectionError(err)) throw new ConnectionContextError(provider, baseUrl, err);
    throw err;
  }
}

/** True for an in-band provider stream failure: the HTTP response itself was 200 (a
 *  live SSE connection), but the provider emitted a terminal error EVENT instead of
 *  completing (OpenAI Responses `response.failed`/`error`:
 *  `{"error":{"code":"server_error",...}}`) — see `ProviderStreamError` in
 *  `ai/providers/errors.ts`. Narrowed via `instanceof Error` + `.name` (not an import
 *  of the concrete class) to keep this generic util free of a provider-layer
 *  dependency, mirroring the existing `.name === "TimeoutError"` check in
 *  `provider-error.ts`. Every instance is treated as retryable here: OpenAI's own
 *  guidance for the two documented codes (`server_error`, `rate_limit_exceeded`) is
 *  "retry with exponential backoff", and any other/unenumerated code is rare enough
 *  that defaulting to retryable beats hard-failing a whole turn on one backend
 *  hiccup. Note `ProviderStreamError` ALSO carries a numeric `.status` (429/500), so
 *  `defaultRetryable`'s existing status check already retries it in the
 *  pre-first-chunk/non-streaming path; this predicate exists for the SEPARATE
 *  engine-level mid-stream ladder (see `transientNetworkRetries` in engine.ts),
 *  which — like `isTransientStreamDropError` — deliberately does not call
 *  `defaultRetryable` there to avoid double-spending that budget. */
export function isProviderStreamError(err: unknown): boolean {
  return err instanceof Error && err.name === "ProviderStreamError";
}
