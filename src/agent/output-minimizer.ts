/**
 * Test-runner noise filter. Strips individual *passing* test rows from
 * bun-test / jest / vitest / cargo-test style output while keeping every
 * failure line, the summary/count lines, and compiler/type diagnostics.
 *
 * This runs BEFORE `truncateToolOutput` so the head+tail cap spends its budget
 * on signal (failures, summaries) rather than thousands of green checkmarks.
 * When the original output exceeds the engine's spill threshold it is also
 * written verbatim to an artifact file (recoverable); below that threshold the
 * stripped passing rows — noise by construction — are not separately retained.
 * Either way this only shapes what the model sees inline; failures, summaries,
 * and diagnostics are always kept.
 *
 * Detection is by *line shape*, not command name: a tool that happens to be
 * `bash` can run any runner, so keying on the command would miss most cases
 * and misfire on others. We only activate when the output actually looks like
 * test output (enough strippable rows AND a recognizable summary), so plain
 * command output (`ls`, `echo`, build logs) passes through untouched.
 */

/** A line that should be DROPPED (an individual passing-test row). */
const PASS_LINE_PATTERNS: RegExp[] = [
  // bun-test / vitest / jest tick rows: "  ✓ name", "√ name", "ok name"
  /^\s*(✓|√|✔)\s/,
  // TAP-ish / node:test: "ok 12 - name" (but NOT "not ok …", handled below)
  /^\s*ok\s+\d+\b/,
  // jest/mocha textual: "PASS src/foo.test.ts" or "  pass  name"
  /^\s*(PASS|pass)\b/,
  // cargo test per-test rows: "test some::path ... ok"
  /^\s*test\s+\S.*\.\.\.\s*ok\s*$/,
];

/** A line that must always be KEPT even if a pass pattern would match it. */
const KEEP_LINE_PATTERNS: RegExp[] = [
  // failures of every flavor
  /(✗|×|✕|✘)/,
  /\b(FAIL|fail(ed|ing|ure)?|panicked|FAILED)\b/,
  /\berror\b/i,
  /error\[/, // rustc diagnostic code, e.g. error[E0382]
  // "not ok 3 - name" TAP failure
  /^\s*not ok\b/,
  // summary / count lines
  /\b\d+\s+pass(ing|ed)?\b/,
  /\b\d+\s+fail(ing|ed)?\b/,
  /\bRan\s+\d+\b/,
  /test result:/,
  /\b\d+\s+tests?\b/,
  // compiler / type diagnostics
  /warning:/,
  /\.ts\(\d+,\d+\)/,
  /\bTS\d+\b/,
];

/** A line that signals this really is runner output (a summary/total). */
const SUMMARY_PATTERNS: RegExp[] = [
  /\b\d+\s+pass(ing|ed)?\b/,
  /\b\d+\s+fail(ing|ed)?\b/,
  /test result:/,
  /\bRan\s+\d+\b/,
  /\b\d+\s+tests?\s+(passed|failed|run)\b/,
];

/** Minimum strippable rows before we treat output as runner noise. */
const MIN_STRIPPABLE = 3;

function isPassLine(line: string): boolean {
  // A keep pattern wins outright (a failing test row may also start with a tick
  // in some formats; never drop something that looks like a failure/diagnostic).
  for (const k of KEEP_LINE_PATTERNS) if (k.test(line)) return false;
  for (const p of PASS_LINE_PATTERNS) if (p.test(line)) return true;
  return false;
}

function hasSummary(text: string): boolean {
  for (const s of SUMMARY_PATTERNS) if (s.test(text)) return true;
  return false;
}

/**
 * Strip passing-test rows from runner output.
 *
 * @returns `text` (possibly filtered) and `filtered` (# of lines removed).
 *          When the output does not look like runner output, returns the input
 *          unchanged with `filtered === 0`.
 */
export function minimizeToolOutput(
  output: string,
  _tool: string
): { text: string; filtered: number } {
  if (!output) return { text: output, filtered: 0 };

  const lines = output.split("\n");
  let strippable = 0;
  for (const line of lines) if (isPassLine(line)) strippable++;

  // Only activate on genuine runner output: enough passing rows to matter AND a
  // recognizable summary/total. Otherwise leave normal command output alone.
  if (strippable < MIN_STRIPPABLE || !hasSummary(output)) {
    return { text: output, filtered: 0 };
  }

  const kept = lines.filter((line) => !isPassLine(line));
  const filtered = lines.length - kept.length;
  if (filtered === 0) return { text: output, filtered: 0 };

  const note = `…(${filtered} passing test lines hidden)…`;
  return { text: `${kept.join("\n")}\n${note}`, filtered };
}
