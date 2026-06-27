/**
 * Global llm-wiki vault-root helpers extracted from launch.ts.
 *
 * Two pure pieces that were previously inline closures inside the ~4k-line
 * `runLaunchCommand`, now independently unit-testable:
 *   - `wikiRootPromptLine` — the system-prompt clause stating the shared wiki root.
 *   - `decideWikiSlash`     — the `/wiki [path|off]` decision (show/clear/set/invalid).
 *
 * The handler keeps its side effects (config persistence, env export, memory
 * refresh) in launch.ts; only the textual decision is extracted here.
 */

import { normalizeWikiRoot } from "../../agent/state";

/**
 * System-prompt clause for the global llm-wiki vault, or "" when no root is set.
 * Pure so `composeSystemPrompt` can re-derive it after a mid-session `/wiki`.
 */
export function wikiRootPromptLine(root: string | undefined): string {
  return root
    ? `\n\nGlobal llm-wiki vault: the single shared knowledge wiki for EVERY session lives at \`${root}\` (also exported as $JEO_WIKI_ROOT). On any knowledge/follow-up query read \`${root}/index.md\` first, then its \`wiki/\` pages; file durable findings under \`${root}/wiki/\`. This vault is global on purpose and is NOT \`.jeo/memory/\` (that store is project-scoped, not the wiki).`
    : "";
}

/** Outcome of parsing a `/wiki ...` command line. `lines` are printed verbatim. */
export type WikiSlashDecision =
  | { kind: "show"; lines: string[] }
  | { kind: "clear"; lines: string[] }
  | { kind: "set"; root: string; persistArg: string; lines: string[] }
  | { kind: "invalid"; lines: string[] };

/**
 * Decide what `/wiki [path|off]` should do, given the currently-resolved root and
 * whether that root came from the env override.
 *
 * @param input   raw command, e.g. "/wiki", "/wiki off", "/wiki ~/vaults/llm-wiki"
 * @param current resolved active root (env→config precedence), or undefined
 * @param fromEnv true when `current` originates from $JEO_WIKI_ROOT
 */
export function decideWikiSlash(
  input: string,
  current: string | undefined,
  fromEnv: boolean,
): WikiSlashDecision {
  const arg = input.substring("/wiki".length).trim();
  if (!arg) {
    const lines = current
      ? [`Global llm-wiki root: ${current}  (from ${fromEnv ? "env JEO_WIKI_ROOT" : "~/.jeo/config.json"})`]
      : ["No global llm-wiki root set. Set one with /wiki <path> (e.g. /wiki ~/vaults/llm-wiki)."];
    lines.push("Clear with /wiki off.");
    return { kind: "show", lines };
  }
  if (arg === "off" || arg === "clear" || arg === "none") {
    return { kind: "clear", lines: ["Global llm-wiki root cleared — saved to ~/.jeo/config.json"] };
  }
  const resolved = normalizeWikiRoot(arg);
  if (!resolved) {
    return { kind: "invalid", lines: ["Invalid path. Usage: /wiki <path> | /wiki off"] };
  }
  return {
    kind: "set",
    root: resolved,
    persistArg: arg,
    lines: [`Global llm-wiki root set to ${resolved} — saved to ~/.jeo/config.json (applies to all sessions).`],
  };
}
