/**
 * Structured provider error so the retry layer can act on the HTTP status.
 *
 * Previously every adapter threw a bare `Error("... HTTP 429 ...")`. The retry
 * predicate (`defaultRetryable`) inspects a numeric `.status`, so those bare
 * errors were never retried — a 429 (rate limit) or 503/529 (overloaded) bubbled
 * straight up instead of backing off. Carrying `.status` (and any `Retry-After`)
 * fixes that and lets `withRetry` honor server-directed backoff.
 */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly provider: string;
  /** Server-directed backoff from a `Retry-After` header, in ms (if present). */
  readonly retryAfterMs?: number;
  constructor(provider: string, status: number, detail: string, context?: string, retryAfterMs?: number) {
    super(`${provider} request failed (HTTP ${status})${context ? ` ${context}` : ""}: ${detail}`);
    this.name = "ProviderHttpError";
    this.status = status;
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Parse a `Retry-After` header into ms. Supports the delta-seconds form
 * (`"5"`) and the HTTP-date form (`"Wed, 21 Oct 2025 07:28:00 GMT"`).
 * Returns undefined for missing/garbage values.
 */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const secs = Number(trimmed);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(trimmed);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return undefined;
}

/**
 * Extract a server-directed retry delay from a 429/503 response *body* (in ms).
 * Some providers (notably Google/Gemini) omit the `Retry-After` header and instead
 * put the hint in the JSON, e.g. `"retryDelay": "8s"` or `"Please retry in 8.6s"`.
 */
export function parseRetryFromBody(detail: string | null | undefined): number | undefined {
  if (!detail) return undefined;
  const m = detail.match(/"retryDelay"\s*:\s*"?([\d.]+)s/i) || detail.match(/retry in ([\d.]+)\s*s/i);
  if (!m) return undefined;
  const s = Number(m[1]);
  return Number.isFinite(s) ? Math.max(0, s * 1000) : undefined;
}

/**
 * Build a {@link ProviderHttpError} from a non-ok `Response`, capturing the body
 * and any `Retry-After`. Use at every adapter's `!response.ok` site so the retry
 * layer sees a uniform, status-carrying, backoff-aware error.
 */
export async function providerHttpError(provider: string, response: Response, context?: string): Promise<ProviderHttpError> {
  const detail = await response.text().catch(() => "");
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after")) ?? parseRetryFromBody(detail);
  return new ProviderHttpError(provider, response.status, detail, context, retryAfterMs);
}
