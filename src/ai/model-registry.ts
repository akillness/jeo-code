import { readGlobalConfig } from "../agent/state";

export interface ModelAliases {
  [alias: string]: string;
}

// Built-in aliases (used when config has none for that key).
export const BUILTIN_ALIASES: ModelAliases = {
  fast: "ollama/qwen2.5:0.5b",
  local: "ollama/qwen2.5:0.5b",
  sonnet: "claude-3-5-sonnet",
  gpt: "gpt-4o",
  flash: "gemini-2.5-flash",
};

// Expand an alias to a concrete model id. Unknown input passes through unchanged.
export function expandAlias(input: string, aliases: ModelAliases = BUILTIN_ALIASES): string {
  if (Object.prototype.hasOwnProperty.call(aliases, input)) {
    return aliases[input];
  }
  return input;
}

// Async: merge BUILTIN_ALIASES with config.modelAliases (config wins) and expand.
export async function resolveModelId(input: string): Promise<string> {
  const config = await readGlobalConfig();
  const modelAliases = (config as any).modelAliases ?? {};
  const merged: ModelAliases = { ...BUILTIN_ALIASES, ...modelAliases };
  return expandAlias(input, merged);
}

// List effective aliases (builtin + config).
export async function listAliases(): Promise<ModelAliases> {
  const config = await readGlobalConfig();
  const modelAliases = (config as any).modelAliases ?? {};
  return { ...BUILTIN_ALIASES, ...modelAliases };
}
