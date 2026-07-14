import { readGlobalConfig } from "../agent/state";
import { findCatalogEntry } from "./model-catalog-compat";

export interface ModelAliases {
  [alias: string]: string;
}

// Built-in aliases (used when config has none for that key).
export const BUILTIN_ALIASES: ModelAliases = {
  fast: "ollama/qwen2.5:0.5b",
  local: "ollama/qwen2.5:0.5b",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
  gpt: "gpt-5.5",
  flash: "gemini-2.5-flash",
  grok: "grok-4.3",
  kimi: "kimi-k2-0711-preview",
  // Antigravity's backend DEPRECATED this wire id (deprecatedModelIds:
  // { "gemini-3.1-pro-high": { newModelId: "gemini-pro-agent" } }) — keep
  // existing configs/roles pinned to the old id working on the successor.
  "antigravity/gemini-3.1-pro-high": "antigravity/gemini-pro-agent",
};

// Expand an alias to a concrete model id. Unknown input passes through unchanged.
export function expandAlias(input: string, aliases: ModelAliases = BUILTIN_ALIASES): string {
  if (Object.prototype.hasOwnProperty.call(aliases, input)) {
    return aliases[input];
  }
  return input;
}

// Async: merge BUILTIN_ALIASES with config.modelAliases (config wins) and expand.
// Pass an already-read `config` to skip the readGlobalConfig() round-trip (turn
// hot path: avoids re-reading the config file mid-turn for model resolution).
export async function resolveModelId(
  input: string,
  config?: { modelAliases?: ModelAliases },
): Promise<string> {
  const cfg = config ?? (await readGlobalConfig());
  const modelAliases = (cfg as any).modelAliases ?? {};
  const merged: ModelAliases = { ...BUILTIN_ALIASES, ...modelAliases };
  return expandAlias(input, merged);
}

// List effective aliases (builtin + config).
export async function listAliases(): Promise<ModelAliases> {
  const config = await readGlobalConfig();
  const modelAliases = (config as any).modelAliases ?? {};
  return { ...BUILTIN_ALIASES, ...modelAliases };
}

/** Alias names (sorted) whose target resolves to `id`. Reverse of `expandAlias`. */
export function aliasesFor(id: string, aliases: ModelAliases = BUILTIN_ALIASES): string[] {
  return Object.entries(aliases)
    .filter(([, target]) => target === id)
    .map(([alias]) => alias)
    .sort();
}

/** True when `input` is a defined alias (not a concrete model id). */
export function isAlias(input: string, aliases: ModelAliases = BUILTIN_ALIASES): boolean {
  return Object.prototype.hasOwnProperty.call(aliases, input);
}

export interface AliasDescription {
  alias: string;
  target: string;
  isAlias: boolean;
  /** True when the target is a known catalog model id. */
  knownTarget: boolean;
}

/** Describe an alias: its target + whether the target is a known catalog model. */
export function describeAlias(input: string, aliases: ModelAliases = BUILTIN_ALIASES): AliasDescription {
  const defined = isAlias(input, aliases);
  const target = defined ? aliases[input]! : input;
  return { alias: input, target, isAlias: defined, knownTarget: !!findCatalogEntry(target) };
}

/**
 * Validate an alias table: flag aliases whose target is not a known catalog
 * model (advisory — uncatalogued targets still work, but a typo usually shows up
 * here). Returns only the suspicious entries.
 */
export function validateAliases(aliases: ModelAliases): { alias: string; target: string }[] {
  return Object.entries(aliases)
    .filter(([, target]) => !findCatalogEntry(target))
    .map(([alias, target]) => ({ alias, target }))
    .sort((a, b) => a.alias.localeCompare(b.alias));
}

/** Async: reverse-alias lookup against the effective (builtin + config) table. */
export async function effectiveAliasesFor(id: string): Promise<string[]> {
  return aliasesFor(id, await listAliases());
}
