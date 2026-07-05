/**
 * Lone-surrogate sanitization for provider request bodies (gjc 0.8.1 parity).
 *
 * Tool-call arguments, tool-result output, and message content are embedded raw into
 * provider request bodies before `JSON.stringify`. A truncated multi-byte emoji (or
 * model-echoed text) can leave an unpaired UTF-16 surrogate in a string; `JSON.stringify`
 * happily emits it as a lone `\ud8xx`/`\udcxx` escape, which strict provider JSON parsers
 * reject (e.g. Anthropic 400 "no low surrogate in string"). `sanitizeJsonStrings` walks an
 * arbitrary JS value and replaces every string (both object keys and values) with its
 * `.toWellFormed()` form, which turns lone surrogates into U+FFFD without touching valid
 * surrogate pairs (real emoji, etc.).
 */

/** Recursively sanitize every string value and object key in `value` for well-formed UTF-16.
 *  Cycle-safe via a `WeakMap` of already-sanitized objects/arrays. */
export function sanitizeJsonStrings<T>(value: T): T {
  return sanitizeJsonStringsInner(value, new WeakMap<object, unknown>()) as T;
}

function sanitizeJsonStringsInner(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return value.toWellFormed();
  if (!value || typeof value !== "object") return value;

  const cached = seen.get(value);
  if (cached !== undefined) return cached;

  if (Array.isArray(value)) {
    const sanitized: unknown[] = [];
    seen.set(value, sanitized);
    for (const item of value) {
      sanitized.push(sanitizeJsonStringsInner(item, seen));
    }
    return sanitized;
  }

  const sanitized: Record<string, unknown> = {};
  seen.set(value, sanitized);
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    sanitized[key.toWellFormed()] = sanitizeJsonStringsInner(nestedValue, seen);
  }
  return sanitized;
}
