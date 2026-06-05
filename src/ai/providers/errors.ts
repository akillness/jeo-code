/**
 * Structured provider error so the retry layer can act on the HTTP status.
 *
 * Previously every adapter threw a bare `Error("... HTTP 429 ...")`. The retry
 * predicate (`defaultRetryable`) inspects a numeric `.status`, so those bare
 * errors were never retried — a 429 (rate limit) or 503/529 (overloaded) bubbled
 * straight up instead of backing off. Carrying `.status` fixes that.
 */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly provider: string;
  constructor(provider: string, status: number, detail: string, context?: string) {
    super(`${provider} request failed (HTTP ${status})${context ? ` ${context}` : ""}: ${detail}`);
    this.name = "ProviderHttpError";
    this.status = status;
    this.provider = provider;
  }
}
