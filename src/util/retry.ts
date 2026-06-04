export interface RetryOptions {
  retries?: number;        // default 3 total attempts
  baseDelayMs?: number;    // default 250
  maxDelayMs?: number;     // default 4000
  isRetryable?: (err: unknown, attempt: number) => boolean;
  sleep?: (ms: number) => Promise<void>;   // injectable for tests (default real setTimeout)
  onRetry?: (attempt: number, err: unknown) => void;
}

// Default retryable predicate: true for network errors (message contains 'fetch'/'network'/'ECONN'/'timeout') or an Error with a numeric `status` in {408,425,429,500,502,503,504}.
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
    lowerMessage.includes("timeout")
  ) {
    return true;
  }

  if (typeof err === "object") {
    const status = (err as any).status;
    const numericStatus = typeof status === "number" ? status : (typeof status === "string" ? Number(status) : NaN);
    if (!isNaN(numericStatus) && [408, 425, 429, 500, 502, 503, 504].includes(numericStatus)) {
      return true;
    }
  }

  return false;
}

// Run fn; on a retryable error, wait exponential backoff (baseDelay * 2^(attempt-1), capped at maxDelay) and retry up to `retries` attempts. Re-throw the last error when exhausted.
export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  const retries = opts?.retries ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 250;
  const maxDelayMs = opts?.maxDelayMs ?? 4000;
  const isRetryable = opts?.isRetryable ?? defaultRetryable;
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const onRetry = opts?.onRetry;

  let attempt = 1;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err, attempt)) {
        throw err;
      }

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);

      if (onRetry) {
        onRetry(attempt, err);
      }

      await sleep(delay);
      attempt++;
    }
  }
}
