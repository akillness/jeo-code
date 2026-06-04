/**
 * Robust JSON object extraction for LLM tool-call responses.
 *
 * Models (especially non-jsonMode backends like Anthropic/Ollama) routinely
 * wrap JSON in prose, ```json fences, or trailing commentary. This recovers the
 * first balanced top-level `{...}` object, respecting strings and escapes.
 */
export function extractJsonObject<T = unknown>(text: string): T {
  const raw = text.trim();

  // Fast path: already pure JSON.
  try {
    return JSON.parse(raw) as T;
  } catch {
    /* fall through to recovery */
  }

  // Strip common code fences and retry.
  const defenced = raw.replace(/```(?:json|JSON)?/g, "").trim();
  try {
    return JSON.parse(defenced) as T;
  } catch {
    /* fall through to brace scan */
  }

  const candidate = firstBalancedObject(defenced) ?? firstBalancedObject(raw);
  if (candidate) {
    return JSON.parse(candidate) as T;
  }
  throw new Error(`No parseable JSON object found in model output: ${truncate(raw, 200)}`);
}

/** Like {@link extractJsonObject} but returns null instead of throwing. */
export function tryExtractJsonObject<T = unknown>(text: string): T | null {
  try {
    return extractJsonObject<T>(text);
  } catch {
    return null;
  }
}

/** Scan for the first brace-balanced object, ignoring braces inside strings. */
function firstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
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
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
