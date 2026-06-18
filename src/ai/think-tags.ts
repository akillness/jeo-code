/**
 * Streaming `<think>…</think>` splitter for OpenAI-compatible / Ollama models.
 *
 * Many open/local reasoning models (DeepSeek-R1, Qwen "thinking", QwQ, …) do NOT
 * expose a separate reasoning channel; they inline their chain-of-thought as
 * `<think>…</think>` inside the normal content stream. Without splitting, that
 * reasoning is dumped into the answer as literal text. This stateful splitter
 * routes think-tag content to `onReasoning` (the dimmed live trace) and returns
 * only the user-visible answer text — handling tags that straddle chunk
 * boundaries, so it is safe to feed raw streamed deltas one at a time.
 *
 * Passthrough is near-free: text with no `<think>` tag flows through unchanged
 * (only a trailing partial-tag fragment is briefly buffered).
 */
const OPEN = "<think>";
const CLOSE = "</think>";

/** Longest suffix of `s` that is a non-empty proper prefix of `tag` (0 if none). */
function partialTail(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let k = max; k > 0; k--) {
    if (s.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

export interface ThinkSplitter {
  /** Feed one streamed delta; returns the visible (answer) text to yield. */
  push(delta: string): string;
  /** Flush any buffered partial tag at stream end; returns trailing visible text. */
  flush(): string;
}

export function createThinkSplitter(onReasoning?: (delta: string) => void): ThinkSplitter {
  let inThink = false;
  let pending = ""; // a tail that might be the start of an OPEN/CLOSE tag

  const push = (delta: string): string => {
    let s = pending + delta;
    pending = "";
    let visible = "";
    for (;;) {
      if (!inThink) {
        const idx = s.indexOf(OPEN);
        if (idx === -1) {
          const tail = partialTail(s, OPEN);
          visible += s.slice(0, s.length - tail);
          pending = s.slice(s.length - tail);
          break;
        }
        visible += s.slice(0, idx);
        s = s.slice(idx + OPEN.length);
        inThink = true;
      } else {
        const idx = s.indexOf(CLOSE);
        if (idx === -1) {
          const tail = partialTail(s, CLOSE);
          const think = s.slice(0, s.length - tail);
          if (think) onReasoning?.(think);
          pending = s.slice(s.length - tail);
          break;
        }
        const think = s.slice(0, idx);
        if (think) onReasoning?.(think);
        s = s.slice(idx + CLOSE.length);
        inThink = false;
      }
    }
    return visible;
  };

  const flush = (): string => {
    const out = pending;
    pending = "";
    // An unterminated tail is literal content: emit it on whichever channel was open.
    if (inThink) {
      if (out) onReasoning?.(out);
      return "";
    }
    return out;
  };

  return { push, flush };
}
