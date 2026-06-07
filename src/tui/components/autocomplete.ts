/**
 * Interactive autocomplete engine for the REPL.
 *
 * Completes slash-command *names* and their *arguments*:
 *  - `/mod`            → `/model`, `/models`
 *  - `/model gpt`      → live (logged-in) model ids + aliases + catalog ids
 *  - `/provider an`    → provider names; second arg → that provider's live models
 *  - `/agents exec`    → subagent role ids; second arg → live model ids
 *  - `/thinking h`     → low/medium/high
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
  /** Live model ids for a given provider (for `/provider <p> <model>`). */
  modelsForProvider: (provider: string) => string[];
}

export interface CompletionResult {
  /** Candidate completions for `token`, ranked, de-duplicated, capped. */
  completions: string[];
  /** The substring being completed (what readline should replace). */
  token: string;
  /** What was completed: command | model | provider | role | thinking | subcommand | none. */
  kind: string;
}

const MAX_COMPLETIONS = 50;
const THINKING_LEVELS = ["low", "medium", "high"];

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
 * Compute completions for the current input line. Returns an empty list for
 * non-slash input (free-text prompts are not completed).
 */
export function complete(line: string, ctx: CompletionContext): CompletionResult {
  if (!line.startsWith("/")) return { completions: [], token: line, kind: "none" };

  const { tokens, trailingSpace } = tokenize(line);
  // Completing the command name itself (single token, still typing it).
  if (tokens.length <= 1 && !trailingSpace) {
    const token = tokens[0] ?? "/";
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
      if (argIndex === 0) return finish(["save", ...rankedModelPool(ctx)], "model");
      // `/model save <id>` second arg → models
      if (argIndex === 1 && tokens[1]?.toLowerCase() === "save") return finish(rankedModelPool(ctx), "model");
      return { completions: [], token, kind: "none" };
    }
    case "/models":
      return argIndex === 0 ? finish(["refresh"], "subcommand") : { completions: [], token, kind: "none" };
    case "/provider": {
      if (argIndex === 0) return finish(ctx.providers, "provider");
      if (argIndex === 1) return finish(ctx.modelsForProvider(tokens[1] ?? ""), "model");
      return { completions: [], token, kind: "none" };
    }
    case "/agents": {
      if (argIndex === 0) return finish(ctx.roleIds, "role");
      if (argIndex === 1) return finish(["maxSteps", ...rankedModelPool(ctx)], "model");
      if (argIndex === 2 && tokens[2]?.toLowerCase() === "maxsteps") return { completions: [], token, kind: "none" };
      return { completions: [], token, kind: "none" };
    }
    case "/thinking":
      return argIndex === 0 ? finish(ctx.thinkingLevels, "thinking") : { completions: [], token, kind: "none" };
    default:
      return { completions: [], token, kind: "none" };
  }
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
