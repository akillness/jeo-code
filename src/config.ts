/**
 * jeoc config — provider + model configuration.
 *
 * Resolution order (later wins): defaults < user (~/.jeoc/config.json) <
 * project (./.jeoc/config.json). API key precedence: config.apiKey > env[apiKeyEnv].
 * Secrets are never printed; `config show` masks them.
 *
 * Zero external dependencies (Node stdlib only).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export type ProviderName = "gemini" | "anthropic" | "openai" | "mock";

export interface JeocConfig {
  provider: ProviderName;
  model: string;
  apiKey?: string | null;
  apiKeyEnv?: string;
  maxTurns: number;
  baseUrl?: string;
}

export interface ResolvedConfig extends JeocConfig {
  apiKey: string | null;
  apiKeySource: "config" | "env" | "none";
  configPath: string | null;
}

const USER_CONFIG = path.join(os.homedir(), ".jeoc", "config.json");
const PROJECT_CONFIG = path.join(".jeoc", "config.json");

export const DEFAULT_ENV: Record<ProviderName, string[]> = {
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  mock: [],
};

export const DEFAULT_MODEL: Record<ProviderName, string> = {
  gemini: "gemini-2.5-flash",
  anthropic: "claude-3-5-sonnet-latest",
  openai: "gpt-4o-mini",
  mock: "mock-1",
};

function defaults(): JeocConfig {
  return { provider: "mock", model: DEFAULT_MODEL.mock, apiKey: null, maxTurns: 20 };
}

function readJson(file: string): Partial<JeocConfig> | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Partial<JeocConfig>;
  } catch {
    throw new Error(`jeoc config: corrupt JSON at ${file}`);
  }
}

/** Which config file `config set` writes to: project if .jeoc exists or no user cfg, else user. */
function writeTarget(scope?: "user" | "project"): string {
  if (scope === "user") return USER_CONFIG;
  if (scope === "project") return PROJECT_CONFIG;
  if (fs.existsSync(path.dirname(PROJECT_CONFIG)) || fs.existsSync(PROJECT_CONFIG)) return PROJECT_CONFIG;
  if (fs.existsSync(USER_CONFIG)) return USER_CONFIG;
  return PROJECT_CONFIG;
}

function envApiKey(cfg: JeocConfig): { key: string | null; envName: string | null } {
  const candidates = cfg.apiKeyEnv ? [cfg.apiKeyEnv] : DEFAULT_ENV[cfg.provider] ?? [];
  for (const name of candidates) {
    const v = process.env[name];
    if (v && v.trim()) return { key: v.trim(), envName: name };
  }
  return { key: null, envName: candidates[0] ?? null };
}

export function loadMerged(): { cfg: JeocConfig; sourcePath: string | null } {
  const user = readJson(USER_CONFIG);
  const proj = readJson(PROJECT_CONFIG);
  const cfg = { ...defaults(), ...(user ?? {}), ...(proj ?? {}) } as JeocConfig;
  if (!cfg.model) cfg.model = DEFAULT_MODEL[cfg.provider] ?? DEFAULT_MODEL.mock;
  const sourcePath = fs.existsSync(PROJECT_CONFIG) ? PROJECT_CONFIG : fs.existsSync(USER_CONFIG) ? USER_CONFIG : null;
  return { cfg, sourcePath };
}

export function resolveConfig(overrides?: Partial<JeocConfig>): ResolvedConfig {
  const { cfg: base, sourcePath } = loadMerged();
  const cleanOverrides = Object.fromEntries(
    Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined),
  ) as Partial<JeocConfig>;
  const cfg = { ...base, ...cleanOverrides } as JeocConfig;
  if (cleanOverrides.provider && !cleanOverrides.model) cfg.model = DEFAULT_MODEL[cfg.provider] ?? cfg.model;
  let apiKey: string | null = cfg.apiKey ?? null;
  let apiKeySource: ResolvedConfig["apiKeySource"] = apiKey ? "config" : "none";
  if (!apiKey) {
    const { key } = envApiKey(cfg);
    if (key) {
      apiKey = key;
      apiKeySource = "env";
    }
  }
  return { ...cfg, apiKey, apiKeySource, configPath: sourcePath };
}

function maskKey(k: string | null): string {
  if (!k) return "(none)";
  if (k.length <= 8) return "****";
  return `${k.slice(0, 4)}…${k.slice(-2)} (len ${k.length})`;
}

function setValue(cfg: Record<string, unknown>, key: string, value: string): void {
  if (key === "maxTurns") cfg[key] = Number(value);
  else cfg[key] = value;
}

/** Merge multiple updates into the target config file (used by `jeoc setup`). Returns the path. */
export function applyConfig(updates: Partial<JeocConfig>, scope?: "user" | "project"): string {
  const target = writeTarget(scope);
  const existing = (readJson(target) as Record<string, unknown>) ?? {};
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined && v !== null) existing[k] = v;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(existing, null, 2) + "\n");
  return target;
}

export function maskApiKey(k: string | null): string {
  if (!k) return "(none)";
  if (k.length <= 8) return "****";
  return `${k.slice(0, 4)}…${k.slice(-2)} (len ${k.length})`;
}

export function runConfig(argv: string[]): void {
  const [cmd, ...rest] = argv;
  const die = (m: string): never => {
    console.error(`jeoc config: ${m}`);
    process.exit(1);
  };
  switch (cmd) {
    case "set": {
      const [key, ...vparts] = rest.filter((a) => a !== "--user" && a !== "--project");
      const value = vparts.join(" ");
      if (!key || value === "") die("usage: jeoc config set <key> <value> [--user|--project]");
      const allowed = ["provider", "model", "apiKey", "apiKeyEnv", "maxTurns", "baseUrl"];
      if (!allowed.includes(key)) die(`unknown key '${key}' (allowed: ${allowed.join(", ")})`);
      const scope = rest.includes("--user") ? "user" : rest.includes("--project") ? "project" : undefined;
      const target = writeTarget(scope);
      const existing = (readJson(target) as Record<string, unknown>) ?? {};
      setValue(existing, key, value);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(existing, null, 2) + "\n");
      console.log(`jeoc config: set ${key}=${key === "apiKey" ? maskKey(value) : value} → ${target}`);
      break;
    }
    case "get": {
      const r = resolveConfig();
      const key = rest[0];
      if (key) {
        const v = (r as Record<string, unknown>)[key];
        console.log(key === "apiKey" ? maskKey(r.apiKey) : String(v ?? "(unset)"));
      } else {
        console.log(JSON.stringify({ ...r, apiKey: maskKey(r.apiKey) }, null, 2));
      }
      break;
    }
    case "show": {
      const r = resolveConfig();
      console.log("jeoc config (resolved)\n");
      console.log(`  provider    ${r.provider}`);
      console.log(`  model       ${r.model}`);
      console.log(`  apiKey      ${maskKey(r.apiKey)}  [source: ${r.apiKeySource}]`);
      console.log(`  apiKeyEnv   ${r.apiKeyEnv ?? DEFAULT_ENV[r.provider]?.join("|") ?? "(none)"}`);
      console.log(`  maxTurns    ${r.maxTurns}`);
      console.log(`  configFile  ${r.configPath ?? "(none — using defaults)"}`);
      if (r.provider !== "mock" && !r.apiKey) {
        const envs = DEFAULT_ENV[r.provider].join(" or ");
        console.log(`\n  ⚠️  no API key — set one of: export ${envs}=...  OR  jeoc config set apiKey <key>`);
      }
      break;
    }
    case "path":
      console.log(`user:    ${USER_CONFIG}`);
      console.log(`project: ${path.resolve(PROJECT_CONFIG)}`);
      break;
    case undefined:
    case "help":
    case "--help":
      console.log(
        [
          "jeoc config — provider + model configuration",
          "",
          "  set <key> <value> [--user|--project]   keys: provider model apiKey apiKeyEnv maxTurns baseUrl",
          "  get [key]                              resolved value (apiKey masked)",
          "  show                                   resolved config + key source",
          "  path                                   config file locations",
          "",
          "providers: gemini | anthropic | openai | mock",
        ].join("\n"),
      );
      break;
    default:
      die(`unknown subcommand: ${cmd} (try: jeoc config help)`);
  }
}

if (import.meta.main) runConfig(process.argv.slice(2));
