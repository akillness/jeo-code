/**
 * Robust JSON object extraction for LLM tool-call responses.
 *
 * Models (especially non-jsonMode backends like Anthropic/Ollama) routinely
 * wrap JSON in prose, ```json fences, or trailing commentary. This recovers the
 * first balanced top-level `{...}` object, respecting strings and escapes.
 *
 * gjc-robustness hardening (the JSON-mode path is the hot path for the default
 * antigravity provider, which is text-only and cannot use native tool-calling):
 *   - tolerate trailing commas before `}`/`]` (a frequent small-model slip);
 *   - `preferKeys` lets the tool-call caller prefer the balanced object that
 *     actually carries a `tool`/`tools` field over an earlier stray JSON object.
 */
export function extractJsonObject<T = unknown>(
  text: string,
  opts?: { preferKeys?: string[] },
): T {
  const raw = text.trim();
  const preferKeys = opts?.preferKeys;

  // Fast path: already pure JSON (optionally with a trailing comma to repair).
  const fast = tryParse<T>(raw);
  if (fast !== undefined) return fast;

  // Strip common code fences and retry (pure, then trailing-comma-repaired).
  const defenced = raw.replace(/```(?:json|JSON)?/g, "").trim();
  const fromDefencedWhole = tryParse<T>(defenced);
  if (fromDefencedWhole !== undefined) return fromDefencedWhole;

  const parsedFromDefenced = findAndParseBalancedObject<T>(defenced, preferKeys);
  if (parsedFromDefenced !== undefined) {
    return parsedFromDefenced;
  }
  const parsedFromRaw = findAndParseBalancedObject<T>(raw, preferKeys);
  if (parsedFromRaw !== undefined) {
    return parsedFromRaw;
  }
  throw new Error(`No parseable JSON object found in model output: ${truncate(raw, 200)}`);
}

/** Like {@link extractJsonObject} but returns null instead of throwing. */
export function tryExtractJsonObject<T = unknown>(
  text: string,
  opts?: { preferKeys?: string[] },
): T | null {
  try {
    return extractJsonObject<T>(text, opts);
  } catch {
    return null;
  }
}

/**
 * Parse `s` as JSON, tolerating a single class of common model slip: a trailing
 * comma right before a closing `}` or `]`. Returns `undefined` (not null — a bare
 * `null`/`false` is a legal JSON value) when nothing parses.
 */
function tryParse<T>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T;
  } catch {
    /* fall through to a trailing-comma repair */
  }
  const repaired = stripTrailingCommas(s);
  if (repaired !== s) {
    try {
      return JSON.parse(repaired) as T;
    } catch {
      /* unrecoverable here */
    }
  }
  return undefined;
}

/**
 * Remove a comma that directly precedes a closing `}` or `]` (ignoring
 * whitespace), but never a comma inside a string literal. String/escape state is
 * tracked so a comma inside `"a,}"` is preserved.
 */
function stripTrailingCommas(s: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < s.length && (s[j] === " " || s[j] === "\t" || s[j] === "\n" || s[j] === "\r")) j++;
      if (j < s.length && (s[j] === "}" || s[j] === "]")) {
        continue; // drop the trailing comma
      }
    }
    out += ch;
  }
  return out;
}

/** Scan for a brace-balanced object starting at startIndex, ignoring braces inside strings. */
function extractBalancedObject(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }
  return null;
}

/**
 * Find the first balanced `{...}` that parses as JSON. When `preferKeys` is given,
 * keep scanning past an earlier parseable object that lacks every preferred key and
 * return the first object that DOES carry one (e.g. the real `{ "tool": ... }` call
 * after a stray JSON-looking object in reasoning prose); fall back to the first
 * parseable object when none carries a preferred key.
 */
function findAndParseBalancedObject<T>(text: string, preferKeys?: string[]): T | undefined {
  let firstParsed: T | undefined;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      const candidate = extractBalancedObject(text, i);
      if (candidate) {
        const parsed = tryParse<T>(candidate);
        if (parsed !== undefined) {
          if (firstParsed === undefined) firstParsed = parsed;
          if (!preferKeys || preferKeys.length === 0) return parsed;
          if (
            parsed !== null &&
            typeof parsed === "object" &&
            preferKeys.some(k => k in (parsed as Record<string, unknown>))
          ) {
            return parsed;
          }
          // else: keep scanning for an object that carries a preferred key
        }
      }
    }
  }
  return firstParsed;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
