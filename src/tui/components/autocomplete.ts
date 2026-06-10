/**
 * Interactive autocomplete engine for the REPL.
 *
 * Completes slash-command *names* and their *arguments*:
 *  - `/mod`            → `/model`, `/models`
 *  - `/model gpt`      → live (logged-in) model ids + aliases + catalog ids
 *  - `/provider an`    → provider names; second arg → that provider's live models
 *  - `/agents exec`    → subagent role ids; second arg → live model ids
 *  - `/thinking h`     → minimal/low/medium/high/xhigh
 *
 * Pure + synchronous: the dynamic data (live models from the OAuth-authenticated
 * accounts, alias snapshot) is passed in via `CompletionContext`, so the readline
 * completer never blocks on the network. Static data (slash names, catalog ids,
 * provider names, role ids) is filled by `staticCompletionContext()`.
 */
import { SLASH_COMMANDS } from "./slash";
import { catalogIds } from "../../ai/model-catalog-compat";
import { PROVIDER_NAMES } from "../../ai/provider-status";
import { SUBAGENT_ROLES } from "../../agent/subagents";
import { skillNames } from "../../skills/catalog";
import { listThemes } from "./themes";

export interface CompletionContext {
  slashCommands: string[];
  /** Flattened live model ids discovered from logged-in providers (cache). */
  liveModels: string[];
  /** Alias names (e.g. fast/sonnet/gpt). */
  aliases: string[];
  /** Curated catalog model ids. */
  catalogModels: string[];
  providers: string[];
  roleIds: string[];
  thinkingLevels: string[];
  /** Resolved skill names (bundled + user/project). Falls back to bundled when omitted. */
  skillNames?: string[];
  /** Live model ids for a given provider (for `/provider <p> <model>`). */
  modelsForProvider: (provider: string) => string[];
  /** Sync path suggestions for free-text `@path` mentions (relative to cwd). */
  mentionPaths?: (prefix: string) => string[];
}

export interface CompletionResult {
  /** Candidate completions for `token`, ranked, de-duplicated, capped. */
  completions: string[];
  /** The substring being completed (what readline should replace). */
  token: string;
  /** What was completed: command | model | provider | role | thinking | subcommand | none. */
  kind: string;
}

const PREVIEW_LABEL: Record<string, string> = {
  command: "Commands",
  model: "Models",
  provider: "Providers",
  role: "Subagent roles",
  thinking: "Thinking levels",
  subcommand: "Subcommands",
  path: "Paths",
};
const MAX_COMPLETIONS = 50;
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"];

/** Static half of a completion context (no network/config needed). */
export function staticCompletionContext(): Omit<CompletionContext, "liveModels" | "aliases" | "modelsForProvider"> {
  return {
    slashCommands: [...SLASH_COMMANDS],
    catalogModels: catalogIds(),
    providers: [...PROVIDER_NAMES],
    roleIds: SUBAGENT_ROLES.map(r => r.id),
    thinkingLevels: [...THINKING_LEVELS],
  };
}

/** Tokenize a line into words + whether it ends with whitespace (→ completing a new token). */
export function tokenize(line: string): { tokens: string[]; trailingSpace: boolean } {
  const trailingSpace = /\s$/.test(line);
  const tokens = line.split(/\s+/).filter(t => t.length > 0);
  return { tokens, trailingSpace };
}

function prefixHits(pool: string[], token: string): string[] {
  const q = token.toLowerCase();
  return pool.filter(c => c.toLowerCase().startsWith(q));
}

/** De-duplicate (case-insensitive, first wins), preserving order, capped. */
function dedupeCap(items: string[], cap = MAX_COMPLETIONS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const k = it.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
    if (out.length >= cap) break;
  }
  return out;
}

/** Rank model candidates: live (logged-in) first, then aliases, then catalog. */
function rankedModelPool(ctx: CompletionContext): string[] {
  return dedupeCap([...ctx.liveModels, ...ctx.aliases, ...ctx.catalogModels], Number.MAX_SAFE_INTEGER);
}

/**
 * Compute completions for the current input line. Slash commands are completed as
 * before; free-text input stays untouched except for `@path` mentions, which can
 * surface local relative paths.
 */
export function complete(line: string, ctx: CompletionContext): CompletionResult {
  const { tokens, trailingSpace } = tokenize(line);
  if (!line.startsWith("/")) {
    const token = trailingSpace ? "" : tokens[tokens.length - 1] ?? "";
    if (token.startsWith("@")) {
      const prefix = token.slice(1);
      const pool = (ctx.mentionPaths?.(prefix) ?? []).map(p => (p.startsWith("@") ? p : `@${p}`));
      return { completions: dedupeCap(prefixHits(pool, token)), token, kind: "path" };
    }
    return { completions: [], token: line, kind: "none" };
  }

  // Completing the command name itself (single token, still typing it).
  if (tokens.length <= 1 && !trailingSpace) {
    const token = tokens[0] ?? "/";
    if (token.toLowerCase().startsWith("/skill:")) {
      const prefix = token.slice("/skill:".length);
      const names = ctx.skillNames ?? skillNames();
      return { completions: dedupeCap(prefixHits(names.map(n => `/skill:${n}`), `/skill:${prefix}`)), token, kind: "command" };
    }
    return { completions: dedupeCap(prefixHits(ctx.slashCommands, token)), token, kind: "command" };
  }

  const cmd = tokens[0]!.toLowerCase();
  // Token currently being completed (empty when the line ends with a space).
  const token = trailingSpace ? "" : tokens[tokens.length - 1]!;
  // 0-based index of the argument being completed.
  const argIndex = (trailingSpace ? tokens.length : tokens.length - 1) - 1;

  const finish = (pool: string[], kind: string): CompletionResult => ({
    completions: dedupeCap(prefixHits(pool, token)),
    token,
    kind,
  });

  switch (cmd) {
    case "/model": {
      if (token.startsWith("#")) return { completions: [], token, kind: "none" }; // numbered pick
      if (argIndex === 0) return finish(["save", "subagent", "role", ...rankedModelPool(ctx)], "model");
      if (argIndex === 1 && (tokens[1]?.toLowerCase() === "save")) return finish(rankedModelPool(ctx), "model");
      if (argIndex === 1 && (tokens[1]?.toLowerCase() === "subagent" || tokens[1]?.toLowerCase() === "role")) return finish(ctx.roleIds, "role");
      if (argIndex === 2 && (tokens[1]?.toLowerCase() === "subagent" || tokens[1]?.toLowerCase() === "role")) return finish(rankedModelPool(ctx), "model");
      return { completions: [], token, kind: "none" };
    }
    case "/models":
      return argIndex === 0 ? finish(["refresh", "caps", "catalog"], "subcommand") : { completions: [], token, kind: "none" };
    case "/provider": {
      const cloud = ["anthropic", "openai", "gemini", "antigravity"];
      if (argIndex === 0) return finish(["login", "auth", ...ctx.providers], "provider");
      // `/provider login|auth <name>` → cloud provider names (OAuth-capable).
      if (argIndex === 1 && (tokens[1]?.toLowerCase() === "login" || tokens[1]?.toLowerCase() === "auth")) return finish(cloud, "provider");
      if (argIndex === 1) return finish(ctx.modelsForProvider(tokens[1] ?? ""), "model");
      return { completions: [], token, kind: "none" };
    }
    case "/logout":
      return argIndex === 0 ? finish(["anthropic", "openai", "gemini", "antigravity"], "provider") : { completions: [], token, kind: "none" };
    case "/agents": {
      if (argIndex === 0) return finish(ctx.roleIds, "role");
      if (argIndex === 1) return finish(["reset", "maxSteps", ...rankedModelPool(ctx)], "model");
      if (argIndex === 2 && (tokens[2]?.toLowerCase() === "maxsteps" || tokens[2]?.toLowerCase() === "steps")) return { completions: [], token, kind: "none" };
      return { completions: [], token, kind: "none" };
    }
    case "/skill":
      return argIndex === 0 ? finish(ctx.skillNames ?? skillNames(), "subcommand") : { completions: [], token, kind: "none" };
    case "/roles": {
      const tiers = ["smol", "slow", "plan"];
      if (argIndex === 0) return finish(tiers, "role");
      if (argIndex === 1 && tiers.includes(tokens[1]?.toLowerCase() ?? "")) return finish(rankedModelPool(ctx), "model");
      return { completions: [], token, kind: "none" };
    }
    case "/thinking":
      return argIndex === 0 ? finish(ctx.thinkingLevels, "thinking") : { completions: [], token, kind: "none" };
    case "/session":
      return argIndex === 0 ? finish(["info", "delete"], "subcommand") : { completions: [], token, kind: "none" };
    case "/theme":
      return argIndex === 0 ? finish(listThemes().map(t => t.name), "subcommand") : { completions: [], token, kind: "none" };
    case "/login":
      return argIndex === 0 ? finish(["anthropic", "openai", "gemini", "antigravity"], "provider") : { completions: [], token, kind: "none" };
    case "/export":
      return argIndex <= 1 ? finish(["json", "markdown"], "subcommand") : { completions: [], token, kind: "none" };
    default:
      return { completions: [], token, kind: "none" };
  }
}

/** Compact live preview for slash-command arguments (`/subagent `, `/provider login `, ...). */
export function formatCompletionPreview(line: string, ctx: CompletionContext, max = 6): string[] {
  if (max <= 0) return [];
  const result = complete(line, ctx);
  if (result.kind === "none" || result.kind === "command" || result.completions.length === 0) return [];
  const label = PREVIEW_LABEL[result.kind] ?? "Matches";
  const budget = Math.max(1, max - 1);
  const shown = result.completions.slice(0, budget);
  const lines = [`${label}:`, ...shown.map(c => `  ${c}`)];
  const hidden = result.completions.length - shown.length;
  if (hidden > 0) {
    if (lines.length >= max) lines[lines.length - 1] = `  …(+${hidden + 1} more)`;
    else lines.push(`  …(+${hidden} more)`);
  }
  return lines;
}

/** Longest common prefix of a list (for tab "fill to ambiguity"). */
export function commonPrefix(items: string[]): string {
  if (items.length === 0) return "";
  let prefix = items[0]!;
  for (const s of items.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i]!.toLowerCase() === s[i]!.toLowerCase()) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

/**
 * Adapter for Node/Bun `readline` completer contract: returns
 * `[completions, tokenBeingReplaced]`. When nothing matches, returns the empty
 * hit list with the whole line so readline leaves the input untouched.
 */
export function readlineCompleter(line: string, ctx: CompletionContext): [string[], string] {
  const r = complete(line, ctx);
  return [r.completions, r.completions.length ? r.token : line];
}
