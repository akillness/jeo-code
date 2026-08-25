/** Slash-command palette/autocomplete for the interactive REPL (TUI M3). */
import chalk from "chalk";
import { editDistance } from "../../ai/model-catalog-compat";

/** Order-preserving subsequence test: every char of `needle` appears in `hay`
 *  left-to-right (gjc-style fuzzy match, e.g. "expt" ⊑ "export"). */
function subsequence(needle: string, hay: string): boolean {
  if (needle === "") return true;
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

export interface SlashCommandInfo {
  command: string;
  usage: string;
  description: string;
  group: "session" | "models" | "subagents" | "code" | "skills" | "system";
}

export const SLASH_COMMAND_DETAILS: readonly SlashCommandInfo[] = [
  { command: "/help", usage: "/help", description: "Show this help message", group: "system" },
  { command: "/clear", usage: "/clear", description: "Clear conversation history (keeps system prompt)", group: "session" },
  { command: "/new", usage: "/new", description: "Start a new session (fresh history + new session id)", group: "session" },
  { command: "/drop", usage: "/drop", description: "Delete the current session and start a new one", group: "session" },
  { command: "/session", usage: "/session [info|delete]", description: "Show current session info, or delete it", group: "session" },
  { command: "/rename", usage: "/rename <title>", description: "Rename the current session", group: "session" },
  { command: "/resume", usage: "/resume [id|gajae:<session-id>[#<leaf>]] [--any-cwd]", description: "Resume a saved session or import a read-only GJC v5 session", group: "session" },
  { command: "/changelog", usage: "/changelog [--full]", description: "Show recent release notes (use --full for the complete changelog)", group: "system" },
  { command: "/retry", usage: "/retry", description: "Retry the last request", group: "session" },
  { command: "/undo", usage: "/undo", description: "Undo the last jeo auto-commit and restore the working tree", group: "session" },
  { command: "/history", usage: "/history [n|all]", description: "Re-print the worked turn history (prompts, tool steps, replies) into scrollback", group: "session" },
  { command: "/export", usage: "/export [path] [json]", description: "Export the session transcript to a file", group: "session" },
  { command: "/dump", usage: "/dump", description: "Copy the session transcript to the clipboard", group: "session" },
  { command: "/btw", usage: "/btw <question>", description: "Ask an ephemeral side question (history untouched)", group: "session" },
  { command: "/compact", usage: "/compact", description: "Summarize older turns to free context", group: "session" },
  { command: "/handoff", usage: "/handoff [focus]", description: "Generate a bounded handoff summary without mutating session history", group: "session" },
  { command: "/goal", usage: "/goal <condition>", description: "Set a natural language stop condition for the session", group: "session" },
  { command: "/model", usage: "/model [id|#N|save|thinking <level>|subagent <role> <model|#N|thinking L>]", description: "Show/switch model; picker can apply to default or any subagent role and set thinking", group: "models" },
  { command: "/fast", usage: "/fast [on|off|status]", description: "Toggle fast thinking mode when the active model supports it", group: "models" },
  { command: "/provider", usage: "/provider [login [name] | key [name] [key] | add --base-url <url> [--model <m>]]", description: "Provider onboarding: `login [name]` starts OAuth; `key [name]` stores an API key (groq, deepseek, …); `add --base-url <url>` registers an OpenAI-compatible endpoint. Switch the active model/provider with /model", group: "models" },
  { command: "/login", usage: "/login [provider]", description: "OAuth login — opens a provider picker showing live login status (account · expiry) for each provider (alias of /provider login)", group: "models" },
  { command: "/logout", usage: "/logout <anthropic|openai|gemini|antigravity>", description: "Remove the stored OAuth token for a provider", group: "models" },
  { command: "/roles", usage: "/roles [tier model]", description: "Show or set model role tiers (smol/slow/plan)", group: "models" },
  { command: "/thinking", usage: "/thinking [level]", description: "Show or set thinking budget (low/medium/high/xhigh)", group: "models" },
  { command: "/route", usage: "/route [on|off|why|history [n]|save|on save|off save]", description: "Show/toggle prompt-based model routing for this session, explain the last routing decision, or list recent routing history (add save to persist on/off)", group: "models" },
  { command: "/agents", usage: "/agents [edit|role] [model|#N|thinking L|maxSteps N|reset]", description: "List subagent roles; use /agents edit for the interactive picker or pin role model/settings", group: "subagents" },
  { command: "/subagent", usage: "/subagent [role]", description: "Show the current subagent composition (per-role model · thinking · steps); alias of /agents", group: "subagents" },
  { command: "/view", usage: "/view <file> [a-b]", description: "Render a file with line numbers + light highlight", group: "code" },
  { command: "/diff", usage: "/diff [file]", description: "Render `git diff` with +/- coloring", group: "code" },
  { command: "/find", usage: "/find <glob>", description: "List files matching a glob", group: "code" },
  { command: "/search", usage: "/search <pat> [glob]", description: "Search the repo for a pattern", group: "code" },

  { command: "/sessions", usage: "/sessions", description: "List saved sessions", group: "session" },
  { command: "/jobs", usage: "/jobs [list|tail|await|cancel]", description: "List, inspect, await, or cancel background jobs in this session", group: "system" },
  { command: "/usage", usage: "/usage", description: "Show cumulative token usage for this session", group: "system" },
  { command: "/context", usage: "/context", description: "Show context token usage breakdown", group: "system" },
  { command: "/tools", usage: "/tools", description: "Show the tools currently visible to the agent", group: "system" },
  { command: "/computer", usage: "/computer [on|off]", description: "Show/toggle the desktop-automation 'computer' tool (screenshot/click/type/etc) for this session", group: "system" },

  { command: "/hotkeys", usage: "/hotkeys", description: "Show keyboard shortcuts", group: "system" },
  { command: "/theme", usage: "/theme [name]", description: "Show or set the TUI theme (cosmic/matrix/solar/mono)", group: "system" },
  { command: "/wiki", usage: "/wiki [path|off]", description: "Show or set the global llm-wiki vault root (shared across all sessions)", group: "system" },
  { command: "/settings", usage: "/settings", description: "Show effective runtime configuration (alias of /config)", group: "system" },
  { command: "/evolve", usage: "/evolve", description: "Simulate and view the agent's evolutionary gallery", group: "system" },
  { command: "/config", usage: "/config", description: "Show the effective runtime configuration", group: "system" },
  { command: "/exit", usage: "/exit", description: "Exit the agent", group: "system" },
  { command: "/quit", usage: "/quit", description: "Exit the agent", group: "system" },
];

export const SLASH_COMMANDS = SLASH_COMMAND_DETAILS.map(c => c.command);

/** Bundled command name → lowercased description (gjc §2.1 description matching). */
export const SLASH_COMMAND_DESCRIPTIONS = new Map<string, string>(
  SLASH_COMMAND_DETAILS.map(c => [c.command, c.description.toLowerCase()]),
);

export function mergeSlashCommandDetails(extra: readonly SlashCommandInfo[] = []): SlashCommandInfo[] {
  const byCommand = new Map<string, SlashCommandInfo>();
  for (const d of [...SLASH_COMMAND_DETAILS, ...extra]) byCommand.set(d.command, d);
  return [...byCommand.values()];
}

/** Return the slash commands that match `input` (case-insensitive). Prefix matches
 *  come first; a fuzzy subsequence fallback (gjc-style, e.g. `/expt` → `/export`)
 *  follows so typos / abbreviations still surface a command. When NOTHING matches
 *  the name, fall back to a description substring match (gjc §2.1) so intent-style
 *  queries with no literal name match still resolve — e.g. `/oauth` → `/login`,
 *  `/clipboard` → `/dump`. A bare `/` lists every command. Empty for non-slash input. */
export function matchSlash(input: string, commands: string[] = SLASH_COMMANDS): string[] {
  if (!input.startsWith("/")) return [];
  const q = input.toLowerCase();
  const body = q.slice(1);
  if (body === "") return [...commands];
  const starts = commands.filter(c => c.toLowerCase().startsWith(q));
  const fuzzy = commands.filter(c => !starts.includes(c) && subsequence(body, c.slice(1).toLowerCase()));
  const named = [...starts, ...fuzzy];
  if (named.length > 0) return named;
  // Description fallback: only when no name matches, and only for queries of ≥2
  // chars with a real substring hit (not a loose subsequence), to avoid flooding.
  if (body.length < 2) return [];
  return commands.filter(c => SLASH_COMMAND_DESCRIPTIONS.get(c)?.includes(body) ?? false);
}

/** True when `input` looks like a slash command (starts with "/" and has no space). */
export function isSlashAttempt(input: string): boolean {
  return input.startsWith("/") && !input.slice(1).includes(" ");
}

/** Near-miss slash commands for a true typo — edit distance ≤ 2 on the command body,
 *  excluding the prefix/fuzzy hits `matchSlash` already surfaces. gjc parity for the
 *  `/provicer` → `/provider` correction. Ranked closest-first and capped. */
export function suggestSlashCommands(input: string, commands: string[] = SLASH_COMMANDS, limit = 3): string[] {
  if (!input.startsWith("/")) return [];
  const body = input.slice(1).toLowerCase();
  if (body === "") return [];
  const already = new Set(matchSlash(input, commands));
  return commands
    .filter(c => !already.has(c))
    .map(c => ({ c, d: editDistance(body, c.slice(1).toLowerCase()) }))
    .filter(s => s.d <= 2)
    .sort((a, b) => a.d - b.d || a.c.localeCompare(b.c))
    .slice(0, limit)
    .map(s => s.c);
}

const GROUP_LABELS: Record<SlashCommandInfo["group"], string> = {
  session: "Session",
  models: "Models / Providers",
  subagents: "Subagents",
  code: "Code tools",
  skills: "Skills",
  system: "System",
};

const GROUP_ORDER: readonly SlashCommandInfo["group"][] = ["models", "subagents", "code", "skills", "session", "system"];
/** Format a visible command palette for `/`, `/help`, or a partial slash prefix. */
export function formatSlashCommandList(input = "/", extra: readonly SlashCommandInfo[] = []): string[] {
  const details = mergeSlashCommandDetails(extra);
  const commands = details.map(c => c.command);
  const query = input === "/?" ? "/" : input;
  const matches = matchSlash(query, commands);
  if (matches.length === 0) {
    const near = suggestSlashCommands(query, commands);
    const tail = near.length ? `Did you mean ${near.join(", ")}?` : "Try /help.";
    return [`Unknown command '${input}'. ${tail}`];
  }
  const wanted = new Set(matches);
  const rows = details.filter(c => wanted.has(c.command));
  const usageWidth = Math.max(...rows.map(c => c.usage.length), 6);
  const title = query === "/" || query === "/help"
    ? "Slash Commands:"
    : `Slash Commands matching '${query}':`;
  const lines = [title];
  for (const group of GROUP_ORDER) {
    const groupRows = rows.filter(c => c.group === group);
    if (groupRows.length === 0) continue;
    lines.push(`  ${GROUP_LABELS[group]}:`);
    for (const c of groupRows) lines.push(`    ${c.usage.padEnd(usageWidth)} - ${c.description}`);
  }
  lines.push("Tip: type a slash prefix like '/mod' and press Tab to autocomplete.");
  return lines;
}

export interface SkillPreviewItem {
  name: string;
  summary?: string;
}

function renderPreviewRows(
  rows: { usage: string; description: string }[],
  max: number,
  selected: number,
): string[] {
  const fmt = (r: { usage: string; description: string }, on: boolean): string => {
    const head = on ? chalk.cyan(`▸ ${r.usage}`) : `  ${r.usage}`;
    return `${head}  ${chalk.dim(r.description)}`;
  };
  const n = rows.length;
  if (n === 0) return [];
  // HARD row-budget contract: the returned lines NEVER exceed `max` — the caller
  // reserves exactly that many footer rows, and one extra line shifts the input
  // box / caret math (the "broken input box" corruption). When the list overflows,
  // up to two slots are spent on ↑/↓ "more" markers INSIDE the budget.
  const overflowing = n > max;
  const slots = overflowing ? Math.max(1, max - 2) : n;
  const sel = selected < 0 ? 0 : Math.min(selected, n - 1);
  const start = Math.max(0, Math.min(sel - Math.floor(slots / 2), n - slots));
  const lines: string[] = [];
  // Position counter (1-based) of the selected row within the full match list,
  // shown on a "more" marker so an overflowing list reads like gjc's `(3/33)`.
  // When nothing is selected, the window starts at the top → `(1/total)`.
  const counter = `(${sel + 1}/${n})`;
  const below = n - (start + slots);
  if (start > 0) lines.push(below > 0 ? `  ↑ ${start} more` : `  ↑ ${start} more   ${counter}`);
  for (let i = start; i < start + slots && i < n; i++) lines.push(fmt(rows[i]!, i === selected));
  if (below > 0) lines.push(`  ↓ ${below} more   ${counter}`);
  return lines;
}

/** Skills matching a `$keyword` probe (no space yet). Prefix matches come first,
 *  then a fuzzy subsequence fallback (gjc-style, e.g. `$dintv` → `$deep-interview`).
 *  A bare `$` lists every skill. */
function dollarMatches(trimmed: string, skills: readonly SkillPreviewItem[]): SkillPreviewItem[] {
  const prefix = trimmed.slice(1).toLowerCase();
  if (prefix === "") return [...skills];
  const starts = skills.filter(s => s.name.toLowerCase().startsWith(prefix));
  const fuzzy = skills.filter(s => !starts.includes(s) && subsequence(prefix, s.name.toLowerCase()));
  return [...starts, ...fuzzy];
}

/** The `/command` or `$skill` token actively being typed, ANYWHERE in the line. */
export interface ActiveTrigger {
  kind: "/" | "$";
  /** The trigger token itself (`/mo`, `$te`, bare `/`, bare `$`, …). */
  token: string;
  /** Index of the token's first character in `line` — for in-place replacement. */
  start: number;
}

/**
 * Find the trigger token the user is typing, regardless of where it sits in the
 * line (mention-style): the LAST whitespace-delimited word, when it starts with
 * `/` or `$` and the caret is still on it (the word ends the line — no space
 * after it yet). `"fix the bug /mo"` → `/mo`, `"explain $te"` → `$te`,
 * `"/model"` → `/model`. No trigger once a space follows (`"/model gpt"` →
 * the active word is `gpt`), and never for `/`/`$` glued inside a word
 * (`"src/cli"`, `"FOO$BAR"` — paths/vars stay popup-free).
 */
export function activeTriggerToken(line: string): ActiveTrigger | undefined {
  const m = /(^|\s)([/$]\S*)$/.exec(line);
  if (!m) return undefined;
  const token = m[2]!;
  return { kind: token[0] as "/" | "$", token, start: (m.index ?? 0) + m[1]!.length };
}

/**
 * The LEADING `/command` or `$skill` keyword once it has been committed with a
 * trailing space — `"/model gpt-4"` → `/model`, `"$test the bug"` → `$test`.
 * Unlike {@link activeTriggerToken} (which only matches the word the caret still
 * sits on) this keeps the invoked keyword recognizable while arguments are typed,
 * so the trigger highlight persists after the space instead of vanishing. Only
 * the leading word counts — a command is invoked at the start of the line — and a
 * still-being-typed keyword (no space yet) returns undefined so the active-token
 * path owns it. Returns the same shape as {@link activeTriggerToken}.
 */
export function committedTriggerToken(line: string): ActiveTrigger | undefined {
  const m = /^(\s*)([/$]\S+)\s/.exec(line);
  if (!m) return undefined;
  const token = m[2]!;
  return { kind: token[0] as "/" | "$", token, start: Array.from(m[1]!).length };
}

/**
 * EVERY `/command` or `$skill` trigger token in the line (mention-style), in
 * left-to-right order — `"/model x then $test y"` → [`/model`, `$test`]. Each
 * is a whitespace-delimited word whose first char is `/`·`$` (paths like
 * `src/cli` and vars like `FOO$BAR` stay excluded, just like the single-token
 * helpers). `start` is the token's first-character index in `line`. Used to
 * highlight all invocations at once, independent of caret position. Pure.
 */
export function allTriggerTokens(line: string): ActiveTrigger[] {
  const out: ActiveTrigger[] = [];
  const re = /(^|\s)([/$]\S*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const token = m[2]!;
    out.push({ kind: token[0] as "/" | "$", token, start: m.index + m[1]!.length });
  }
  return out;
}

/**
 * Compact live preview shown beneath the input box while a `/command` or
 * `$skill` keyword is being typed — at any position in the line (mention-style,
 * gjc/Codex parity): `"do X then /mo"` previews commands, `"…then $te"`
 * previews skills. Returns matching usages + descriptions, capped, or [] when
 * no trigger token is active (finished words stay popup-free). Match ORDER is
 * preserved from matchSlash/dollarMatches so prefix hits sit above fuzzy hits.
 */
export function formatSlashPreview(
  line: string,
  max = 6,
  selected = -1,
  extra: readonly SlashCommandInfo[] = [],
  skills: readonly SkillPreviewItem[] = [],
): string[] {
  const trigger = activeTriggerToken(line);
  if (!trigger) return [];
  if (trigger.kind === "$") {
    const rows = dollarMatches(trigger.token, skills).map(s => ({
      usage: `$${s.name} [intent]`,
      description: s.summary?.trim() || "run this skill directly",
    }));
    return renderPreviewRows(rows, max, selected);
  }
  const details = mergeSlashCommandDetails(extra);
  const byCommand = new Map(details.map(c => [c.command, c] as const));
  const rows = matchSlash(trigger.token, details.map(c => c.command))
    .map(cmd => byCommand.get(cmd))
    .filter((c): c is SlashCommandInfo => Boolean(c));
  if (rows.length === 0) return [];
  return renderPreviewRows(rows, max, selected);
}

/** The matching command names for an active `/cmd` or `$name` trigger token
 *  (anywhere in the line), in display order (prefix-first, then fuzzy). */
export function slashPreviewMatches(
  line: string,
  extra: readonly SlashCommandInfo[] = [],
  skills: readonly SkillPreviewItem[] = [],
): string[] {
  const trigger = activeTriggerToken(line);
  if (!trigger) return [];
  if (trigger.kind === "$") return dollarMatches(trigger.token, skills).map(s => `$${s.name}`);
  const details = mergeSlashCommandDetails(extra);
  return matchSlash(trigger.token, details.map(c => c.command));
}

/**
 * Tab-completion target for the live `/`·`$` popup: the highlighted row when the
 * user arrowed to one, else the TOP match (prefix hits sort first). Returns the
 * completed line WITH a trailing space — arguments follow, and the space closes
 * the keyword popup (a space means a real invocation is being typed). Pure.
 */
export function tabCompleteSelection(line: string, matches: readonly string[], selected: number): string | undefined {
  if (matches.length === 0) return undefined;
  const trigger = activeTriggerToken(line);
  if (!trigger) return undefined;
  const pick = matches[selected >= 0 && selected < matches.length ? selected : 0]!;
  return line.slice(0, trigger.start) + `${pick} `;
}

