import { getEncoding, type Tiktoken, type TiktokenEncoding } from "js-tiktoken";

/** Coarse token estimate used ONLY when the BPE encoder throws (≈never). Deliberately
 *  simple (~4 chars/token) and self-contained — avoids a compaction.ts import cycle and
 *  is good enough for a degraded-path count that real BPE almost always replaces. */
function coarseTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Accurate BPE token counting for the compaction decision boundary.
 *
 * The cheap char heuristic (`estimateTokens` in compaction.ts) stays the
 * per-frame footer path; this module is for the accuracy-critical comparison
 * where over/under-counting wastes context window or triggers premature
 * compaction. Encoders are loaded lazily and cached at module scope, and
 * per-input counts are memoized in a bounded LRU-ish map so repeated counts
 * (e.g. summing the same history twice in one tick) are free.
 */

const MEMO_CAP = 512;
/** Texts longer than this are NOT memoized: the memo key would pin a (possibly
 *  compaction-dropped) multi-hundred-KB string in memory for the process
 *  lifetime, and building the `${encoding}\u0000${text}` key itself copies the
 *  whole text per lookup. One direct encode of a large text is cheaper than
 *  cumulative retention — bounded memory beats a cache hit here. */
const MEMO_MAX_TEXT = 16_384;

// Lazily-instantiated encoders, cached by encoding name. js-tiktoken ships the
// rank tables as pure JS, so loading is a one-time cost per encoding.
const encoders = new Map<TiktokenEncoding, Tiktoken>();
// Bounded memoization keyed by `${encoding}\u0000${text}` → token count.
const memo = new Map<string, number>();

/** Pick the tiktoken encoding family for a model id. */
function encodingForModel(model?: string): TiktokenEncoding {
  if (model && /gpt-4o|gpt-5|o\d/i.test(model)) return "o200k_base";
  return "cl100k_base";
}

/** Stable cache-partition key for `model`'s tokenizer family. Exposed so callers
 *  (e.g. compaction's per-message accurate cache) can key caches without
 *  duplicating the model→encoding mapping. */
export function encodingFamilyForModel(model?: string): string {
  return encodingForModel(model);
}

function getEncoder(encoding: TiktokenEncoding): Tiktoken | null {
  const cached = encoders.get(encoding);
  if (cached) return cached;
  try {
    const enc = getEncoding(encoding);
    encoders.set(encoding, enc);
    return enc;
  } catch {
    // Nearest-family fallback: an unknown/garbage encoding name degrades to the
    // default cl100k_base rather than throwing.
    if (encoding !== "cl100k_base") {
      try {
        const fallback = getEncoding("cl100k_base");
        encoders.set(encoding, fallback);
        return fallback;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Count tokens for `text` using the BPE encoder for `model` (cl100k_base by
 * default, o200k_base for gpt-4o/gpt-5/o-series). Never throws: any encoder or
 * encode failure falls back to the char heuristic so callers always get a
 * positive number.
 */
export function countTokensAccurate(text: string, model?: string): number {
  if (!text) return 0;
  const encoding = encodingForModel(model);
  const memoizable = text.length <= MEMO_MAX_TEXT;
  const key = memoizable ? `${encoding}\u0000${text}` : "";
  if (memoizable) {
    const hit = memo.get(key);
    if (hit !== undefined) {
      // Refresh recency: re-insert so eviction drops the genuinely-oldest.
      memo.delete(key);
      memo.set(key, hit);
      return hit;
    }
  }

  let count: number;
  try {
    const enc = getEncoder(encoding);
    count = enc ? enc.encode(text).length : coarseTokens(text);
  } catch {
    count = coarseTokens(text);
  }

  if (memoizable) {
    if (memo.size >= MEMO_CAP) {
      const oldest = memo.keys().next().value;
      if (oldest !== undefined) memo.delete(oldest);
    }
    memo.set(key, count);
  }
  return count;
}

/**
 * Reset module-level encoder and memo caches. Test-only: lets tests exercise
 * the lazy-load and fallback paths from a clean slate.
 */
export function resetTokenizer(): void {
  encoders.clear();
  memo.clear();
}
