/**
 * Slack-style direct-request detection (ops/specs/slack-autopilot.md).
 *
 * Goal: free-form natural-language input ("fix the build error") routes to
 * the interactive agent, while command invocations (`joc status`), flags,
 * and single-token typos still reach the normal dispatcher so command
 * resolution and "did you mean" suggestions keep working.
 *
 * Pure, domain-agnostic helpers only (src/util convention).
 */

/** Command-shaped token: `status`, `evolve-core`, `skills:list`, … */
const COMMAND_SHAPED = /^[a-z][a-z0-9:_-]*$/i;

/**
 * Slack command-prefix check: `/deploy` and `!ops` style messages are
 * explicit commands, never direct requests.
 */
export function isSlackDM(text: string): boolean {
  return !text.startsWith("/") && !text.startsWith("!");
}

/**
 * True when the argv tokens look like a free-form request rather than a
 * CLI command invocation.
 *
 * - empty / flags-only input → false (dispatcher owns defaults)
 * - `/cmd` or `!cmd` prefix → false (explicit command style)
 * - single command-shaped token → false (could be a typo of a real
 *   command; the dispatcher must keep its suggestion path)
 * - anything else (multi-word sentences, CJK text, punctuation) → true
 */
export function isDirectRequest(tokens: readonly string[]): boolean {
  const words = tokens.filter(t => !t.startsWith("-"));
  if (words.length === 0) return false;
  const first = words[0];
  if (!isSlackDM(first)) return false;
  if (words.length === 1 && COMMAND_SHAPED.test(first)) return false;
  return true;
}
