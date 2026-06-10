/**
 * Terminal unicode capability detection for the evolution TUI.
 *
 * The art is ASCII, but the spinner (braille), meter (block glyphs), and track
 * (●/○) use unicode. On a terminal that cannot render them (legacy `linux`
 * console, `dumb`, or a non-UTF locale) we fall back to ASCII-only glyph sets.
 * Pure + injectable so tests can pin the decision.
 */
import type { EnvLike } from "./color";

/**
 * Whether the terminal can render the unicode glyphs the TUI uses. Heuristics:
 *  - `TERM=dumb`/`linux` → no (legacy console fonts lack braille).
 *  - any locale var (`LC_ALL`/`LC_CTYPE`/`LANG`) mentioning UTF → yes.
 *  - a locale var set but NOT mentioning UTF → no.
 *  - nothing set → default yes (modern emulators are UTF-8).
 */
export function supportsUnicode(env: EnvLike = process.env): boolean {
  const term = (env.TERM ?? "").toLowerCase();
  if (term === "dumb" || term === "linux") return false;

  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG;
  if (locale !== undefined && locale !== "") {
    return /utf-?8/i.test(locale);
  }

  // No locale signal — assume a modern UTF-8 terminal.
  return true;
}
