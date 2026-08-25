/**
 * Interactive autocomplete engine for the REPL.
 *
 * Completes slash-command *names* and their *arguments*:
 *  - `/mod`            → `/model`
 *  - `/model gpt`      → live (logged-in) model ids + aliases + catalog ids
 *  - `/provider an`    → provider names; second arg → that provider's live models
 *  - `/agents exec`    → subagent role ids; second arg → live model ids
 *  - `/thinking h`     → low/medium/high/xhigh
 *
 * Pure + synchronous: the dynamic data (live models from the OAuth-authenticated
 * accounts, alias snapshot) is passed in via `CompletionContext`, so the readline
 * completer never blocks on the network. Static data (slash names, catalog ids,
 * provider names, role ids) is filled by `staticCompletionContext()`.
 */
import { SLASH_COMMANDS, SLASH_COMMAND_DESCRIPTIONS } from "./slash";
import { catalogIds } from "../../ai/model-catalog-compat";
import { PROVIDER_NAMES, allProviderNames } from "../../ai/provider-status";
import { PROVIDER_PRESET_IDS } from "../../ai/providers/provider-presets";
import { customProviderNames } from "../../ai/providers/custom-providers";
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
  /** Preset ids offered after `/provider add --preset`. */
  providerPresets: string[];
  /** Ids of the user's registered custom providers (for `/provider remove <id>`). */
  customProviders: string[];
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
  skill: "Skills",
  model: "Models",
  provider: "Providers",
  role: "Subagent roles",
  thinking: "Thinking levels",
  subcommand: "Subcommands",
  path: "Paths",
};
const MAX_COMPLETIONS = 50;
const THINKING_LEVELS = ["low", "medium", "high", "xhigh"];

/** Static half of a completion context (no network/config needed). */
export function staticCompletionContext(): Omit<CompletionContext, "liveModels" | "aliases" | "modelsForProvider"> {
  return {
    slashCommands: [...SLASH_COMMANDS],
    catalogModels: catalogIds(),
    // Custom providers are runtime state, so list from `allProviderNames()` — a user's
    // own endpoint must be completable the same as a shipped one.
    providers: [...allProviderNames()],
    roleIds: SUBAGENT_ROLES.map(r => r.id),
    thinkingLevels: [...THINKING_LEVELS],
    providerPresets: [...PROVIDER_PRESET_IDS],
    customProviders: [...customProviderNames()],
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

/**
 * Fuzzy subsequence test (gjc parity): every char of `query` appears in
 * `target` in order (not necessarily adjacent). Empty query matches everything.
 */
export function fuzzyMatch(query: string, target: string): boolean {
  if (!query) return true;
  let qi = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) qi++;
  }
  return qi === query.length;
}

/**
 * Score a match (gjc parity): exact=100 > startsWith=80 > includes=60 >
 * subsequence(40 − gaps×5, min 1). Returns 0 when `query` is not a subsequence.
 */
export function fuzzyScore(query: string, target: string): number {
  if (!query) return 80;
  if (query === target) return 100;
  if (target.startsWith(query)) return 80;
  if (target.includes(query)) return 60;
  let qi = 0;
  let gaps = 0;
  let lastMatch = -1;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) {
      if (lastMatch !== -1 && ti !== lastMatch + 1) gaps++;
      lastMatch = ti;
      qi++;
    }
  }
  if (qi < query.length) return 0;
  return Math.max(1, 40 - gaps * 5);
}

/**
 * Fuzzy command-name matches, ranked best-first (gjc §2.1): higher fuzzyScore
 * first, ties broken by registration order so the list stays stable. Prefix
 * matches always outrank looser subsequence hits, so `/mod`→`/model` is kept
 * while `/mdl`→`/model` now also completes.
 */
function fuzzyHits(pool: string[], token: string): string[] {
  const q = token.toLowerCase();
  return pool
    .map((c, index) => ({ c, score: fuzzyScore(q, c.toLowerCase()), index }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(x => x.c);
}

/**
 * Command-name completion with a description fallback (gjc §2.1). Name matches
 * win outright (so `/mod`→`/model` stays precise); only when NOTHING matches the
 * name do we fall back to substring-or-better description hits, so intent-style
 * queries with no literal name match still resolve — e.g. `/oauth`→`/login`,
 * `/transcript`→`/dump`. The description fallback requires ≥2 query chars and a
 * real substring (not a loose subsequence) to avoid flooding the dropdown.
 */
function fuzzyCommandHits(pool: string[], token: string): string[] {
  const nameHits = fuzzyHits(pool, token);
  if (nameHits.length > 0) return nameHits;

  const q = token.replace(/^\//, "").toLowerCase();
  if (q.length < 2) return [];
  return pool
    .map((c, index) => {
      const desc = SLASH_COMMAND_DESCRIPTIONS.get(c);
      const hit = desc?.includes(q) ?? false;
      return { c, score: hit ? fuzzyScore(q, desc!) * 0.5 : 0, index };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(x => x.c);
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
/**
 * True when `pos` sits inside an unterminated (or paired) single-backtick span
 * opened earlier on the same line (gjc parity, #2619/#2629). A backslash
 * ALWAYS escapes the next character — an escaped backtick (`\``) never toggles
 * the span — so a composer example like "use `/model` to switch" or a literal
 * "type \` then a command" both classify correctly. Only line-local state:
 * spans never carry across lines (there is no multi-line buffer here).
 */
function insideBacktickSpan(line: string, pos: number): boolean {
  let open = false;
  let i = 0;
  while (i < pos && i < line.length) {
    const ch = line[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "`") open = !open;
    i++;
  }
  return open;
}
export function complete(line: string, ctx: CompletionContext): CompletionResult {
  const { tokens, trailingSpace } = tokenize(line);
  if (!line.startsWith("/")) {
    const token = trailingSpace ? "" : tokens[tokens.length - 1] ?? "";
    if (token.startsWith("@")) {
      const prefix = token.slice(1);
      // `mentionPaths` already does the matching (recursive fuzzy for a bare
      // fragment, single-dir listing when the prefix has a slash), so the pool
      // is returned as-is rather than re-filtered by strict prefix.
      const pool = (ctx.mentionPaths?.(prefix) ?? []).map(p => (p.startsWith("@") ? p : `@${p}`));
      return { completions: dedupeCap(pool), token, kind: "path" };
    }
    // Literal backtick spans (`` `/model` ``, `` `$skill` ``) are protected text,
    // not live mentions — suppress command/skill matching (and the Tab/Enter
    // dispatch riding on it) below so a typed example never pops the palette.
    // `@path` mentions above stay live inside a span (gjc parity: path
    // completion is preserved in literals; only command/skill matching is
    // suppressed). The token's own start offset is `line.length - token.length`
    // (or `line.length` when trailing-space, which never matches $/ below).
    if (insideBacktickSpan(line, line.length - token.length)) {
      return { completions: [], token: line, kind: "none" };
    }
    // `$skill` mention completion at ANY position in the line (mention-style;
    // a leading `$name` is additionally the direct-invocation entrypoint).
    if (token.startsWith("$")) {
      const names = ctx.skillNames ?? skillNames();
      return { completions: dedupeCap(prefixHits(names.map(n => `$${n}`), token)), token, kind: "skill" };
    }
    // `/command` mention completion mid-line (the leading-token case is the
    // dedicated command branch below, which also completes arguments).
    if (token.startsWith("/")) {
      return { completions: dedupeCap(fuzzyCommandHits(ctx.slashCommands, token)), token, kind: "command" };
    }
    return { completions: [], token: line, kind: "none" };
  }

  // Completing the command name itself (single token, still typing it).
  if (tokens.length <= 1 && !trailingSpace) {
    const token = tokens[0] ?? "/";
    return { completions: dedupeCap(fuzzyCommandHits(ctx.slashCommands, token)), token, kind: "command" };
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
      if (argIndex === 0) return finish(["save", "subagent", "role", "thinking", ...rankedModelPool(ctx)], "model");
      if (argIndex === 1 && (tokens[1]?.toLowerCase() === "save")) return finish(rankedModelPool(ctx), "model");
      if (argIndex === 1 && (tokens[1]?.toLowerCase() === "thinking" || tokens[1]?.toLowerCase() === "think")) return finish(ctx.thinkingLevels, "thinking");
      if (argIndex === 1 && (tokens[1]?.toLowerCase() === "subagent" || tokens[1]?.toLowerCase() === "role")) return finish(ctx.roleIds, "role");
      if (argIndex === 2 && (tokens[1]?.toLowerCase() === "subagent" || tokens[1]?.toLowerCase() === "role")) return finish(["thinking", ...rankedModelPool(ctx)], "model");
      if (argIndex === 3 && (tokens[1]?.toLowerCase() === "subagent" || tokens[1]?.toLowerCase() === "role") && (tokens[3]?.toLowerCase() === "thinking" || tokens[3]?.toLowerCase() === "think")) return finish(["inherit", ...ctx.thinkingLevels], "thinking");
      return { completions: [], token, kind: "none" };
    }
    case "/fast":
      return argIndex === 0 ? finish(["on", "off", "status"], "subcommand") : { completions: [], token, kind: "none" };
    case "/provider": {
      // /provider is onboarding-only (gjc parity): login, key, and the custom-provider
      // registry (add/list/remove/presets). Model switching completes under /model.
      const cloud = ["anthropic", "openai", "gemini", "antigravity"];
      if (argIndex === 0) return finish(["login", "key", "add", "list", "remove", "presets", "help"], "subcommand");
      const sub = tokens[1]?.toLowerCase();
      if (sub === "login" || sub === "auth") return argIndex === 1 ? finish(cloud, "provider") : { completions: [], token, kind: "none" };
      // Removal only ever targets a CUSTOM provider, so completing built-ins here would
      // just offer choices the command refuses.
      if (sub === "remove" || sub === "rm" || sub === "delete") {
        return argIndex === 1 ? finish([...ctx.customProviders], "provider") : { completions: [], token, kind: "none" };
      }
      if (sub === "add") {
        // Right after `--preset`, offer preset ids; otherwise the flag set.
        if (tokens[argIndex]?.toLowerCase() === "--preset") return finish([...ctx.providerPresets], "subcommand");
        return finish(
          ["--id", "--base-url", "--compat", "--api-key-env", "--api-key", "--model", "--label", "--preset", "--force", "clear"],
          "subcommand",
        );
      }
      return { completions: [], token, kind: "none" };
    }
    case "/logout":
      return argIndex === 0 ? finish(["anthropic", "openai", "gemini", "antigravity"], "provider") : { completions: [], token, kind: "none" };
    case "/agents": {
      if (argIndex === 0) return finish(["edit", ...ctx.roleIds], "role");
      if (argIndex === 1) return finish(["reset", "thinking", "maxSteps", ...rankedModelPool(ctx)], "model");
      if (argIndex === 2 && (tokens[2]?.toLowerCase() === "thinking" || tokens[2]?.toLowerCase() === "think")) return finish(["inherit", ...ctx.thinkingLevels], "thinking");
      if (argIndex === 2 && (tokens[2]?.toLowerCase() === "maxsteps" || tokens[2]?.toLowerCase() === "steps")) return { completions: [], token, kind: "none" };
      return { completions: [], token, kind: "none" };
    }

    case "/roles": {
      const tiers = ["smol", "slow", "plan"];
      if (argIndex === 0) return finish(tiers, "role");
      if (argIndex === 1 && tiers.includes(tokens[1]?.toLowerCase() ?? "")) return finish(rankedModelPool(ctx), "model");
      return { completions: [], token, kind: "none" };
    }
    case "/thinking":
      return argIndex === 0 ? finish(ctx.thinkingLevels, "thinking") : { completions: [], token, kind: "none" };
    case "/session":
      return argIndex === 0 ? finish(["list", "info", "new", "drop", "delete", "rename", "resume"], "subcommand") : { completions: [], token, kind: "none" };
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

/** Compact mid-turn command/skill preview. Like formatCompletionPreview but ALSO
 *  surfaces command-name and $skill-name matches (the kinds the argument-only preview
 *  skips), so a /command or $skill typed WHILE a turn runs visibly reacts. */
export function formatMidTurnHint(line: string, ctx: CompletionContext, max = 5): string[] {
  if (max <= 0) return [];
  const result = complete(line, ctx);
  if (result.completions.length === 0) return [];
  const label = PREVIEW_LABEL[result.kind] ?? "Matches";
  const shown = result.completions.slice(0, max);
  const hidden = result.completions.length - shown.length;
  const lines = [`${label}:`, ...shown.map(c => `  ${c}`)];
  if (hidden > 0) lines.push(`  …(+${hidden} more)`);
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
