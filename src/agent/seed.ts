/**
 * Shared seed-document helpers (round-12, architect ref 8-Round10Planning #5).
 *
 * The deep-interview WRITER and the ultragoal READER of seed lists used to live
 * in different files with different rules — the writer JSON-encoded each value
 * while the reader stripped EVERY double quote, so a criterion like
 * `Display "Done" message` was mangled to `Display \Done\ message` by the time
 * it reached the verification report. Writer and parser now share one module
 * and one encoding, and deep-interview asserts the round-trip at freeze time so
 * any future drift fails loudly instead of corrupting the ledger silently.
 */

/** Serialize a named YAML list with JSON-encoded scalar items. */
export function yamlList(name: string, values: string[]): string {
  if (values.length === 0) return `${name}: []`;
  return `${name}:\n${values.map(value => `  - ${JSON.stringify(value)}`).join("\n")}`;
}

/** Parse a named list out of a seed document written by `yamlList` (with a
 *  lenient fallback for legacy / hand-edited unquoted items). */
export function parseSeedList(content: string, name: string): string[] {
  const out: string[] = [];
  let inList = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${name}:`)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    if (trimmed.startsWith("- ")) {
      const rawValue = trimmed.replace(/^-\s*/, "");
      if (rawValue.startsWith('"')) {
        try {
          out.push(JSON.parse(rawValue) as string);
          continue;
        } catch { /* not a clean JSON string — fall through to the lenient path */ }
      }
      // Legacy/hand-written item: strip only a MATCHED outer quote pair, never
      // interior quotes (the old reader's replace(/"/g,"") mangled those).
      out.push(rawValue.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1").trim());
    } else if (trimmed === "" || /^[A-Za-z_][\w-]*:/.test(trimmed)) {
      inList = false; // blank line or next section header ends the list
    }
  }
  return out.filter(v => v.length > 0);
}

/** The acceptance-criteria list ultragoal verifies against. */
export function parseSeedAcceptanceCriteria(content: string): string[] {
  return parseSeedList(content, "acceptance_criteria");
}
/** A single acceptance criterion, optionally carrying an executable check command.
 *  Authors make a criterion INDIVIDUALLY verifiable by appending a trailing
 *  `{verify: <shell command>}` directive; ultragoal runs that command and records a
 *  real PASS/FAIL instead of leaving the criterion UNVERIFIED. Criteria without a
 *  directive stay honest-by-default (UNVERIFIED on a green suite). */
export interface ParsedCriterion {
  /** Human-readable criterion text with any {verify:...} directive stripped. */
  text: string;
  /** Optional shell command whose exit status proves this specific criterion. */
  verify?: string;
}

const VERIFY_DIRECTIVE = /\s*\{verify:\s*([^}]+?)\s*\}\s*$/i;

/** Split an optional trailing `{verify: <cmd>}` directive off a criterion string.
 *  The directive lives INSIDE the JSON-encoded seed value, so it round-trips
 *  unmangled through `yamlList`/`parseSeedList` like any other criterion text. */
export function parseCriterion(raw: string): ParsedCriterion {
  const match = raw.match(VERIFY_DIRECTIVE);
  if (!match) return { text: raw.trim() };
  const verify = match[1].trim();
  const text = raw.replace(VERIFY_DIRECTIVE, "").trim();
  return verify ? { text, verify } : { text };
}
