export interface RetryOptions {
  retries?: number;        // default 3 total attempts
  baseDelayMs?: number;    // default 250
  maxDelayMs?: number;     // default 4000
  isRetryable?: (err: unknown, attempt: number) => boolean;
  sleep?: (ms: number) => Promise<void>;   // injectable for tests (default real setTimeout)
  random?: () => number;   // injectable RNG for jitter (default Math.random); equal-jitter in [0.5x, 1x]
  onRetry?: (attempt: number, err: unknown) => void;
}

// Default retryable predicate: true for transient network errors, transient/overload
// keywords, or a transient HTTP status (408/425/429/500/502/503/504/529) found either on a
// numeric `.status` field or embedded as "HTTP <code>" in the error message.
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
export function defaultRetryable(err: unknown): boolean {
  if (!err) {
    return false;
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
    lowerMessage.includes("rate_limit")
  ) {
    return true;
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

// Server-directed `Retry-After` is honored but capped so a CLI never hangs on a hostile header.
const RETRY_AFTER_CAP_MS = 30_000;

// Run fn; on a retryable error, back off and retry up to `retries` attempts. Backoff is
// exponential (baseDelay * 2^(attempt-1), capped at maxDelay) with equal jitter (the wait lands in
// [0.5x, 1x] of that cap), unless the error carries a `retryAfterMs` (server `Retry-After`), which
// takes precedence (capped at RETRY_AFTER_CAP_MS). Re-throws the last error when exhausted.
export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  const retries = opts?.retries ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 250;
  const maxDelayMs = opts?.maxDelayMs ?? 4000;
  const isRetryable = opts?.isRetryable ?? defaultRetryable;
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const random = opts?.random ?? Math.random;
  const onRetry = opts?.onRetry;

  let attempt = 1;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err, attempt)) {
        throw err;
      }

      const capped = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      // Equal jitter: half fixed + half random → [0.5x, 1x] of the capped backoff.
      const jittered = capped / 2 + random() * (capped / 2);
      const serverDelay = retryAfterOf(err);
      const delay = serverDelay !== undefined ? Math.min(serverDelay, RETRY_AFTER_CAP_MS) : jittered;

      if (onRetry) {
        onRetry(attempt, err);
      }

      await sleep(delay);
      attempt++;
    }
  }
}

// Extract a non-negative `retryAfterMs` from an error, if it carries one (e.g. ProviderHttpError).
function retryAfterOf(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    const v = (err as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  }
  return undefined;
}
