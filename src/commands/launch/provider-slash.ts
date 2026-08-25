/**
 * `/provider add|list|remove|presets` — the custom-provider onboarding surface.
 *
 * Everything here is a PURE function over parsed tokens + a config snapshot, returning
 * the lines to print and the config patch to persist. The slash handler in `launch.ts`
 * only does the IO (read config, save patch, refresh the model cache), which is what
 * makes this whole flow unit-testable without a TUI, a network, or a real `~/.jeo`.
 *
 * Backwards compatibility matters here: `/provider add --base-url <url>` (no `--id`)
 * kept meaning "rebind the built-in openai provider" for two releases, and users have
 * that in their notes/scripts. That spelling still does exactly what it did; the new
 * named-provider behavior is opt-in via `--id` or `--preset`.
 */
import type { Config } from "../../agent/state";
import {
  assertValidProviderId,
  normalizeCustomBaseUrl,
  normalizeProviderId,
  parseModelList,
  parseProviderCompatibility,
  redactSecret,
  type CustomProviderConfig,
  type ProviderCompatibility,
} from "../../ai/providers/custom-providers";
import {
  expandProviderPreset,
  findProviderPreset,
  formatProviderPresetList,
} from "../../ai/providers/provider-presets";
import { isBuiltinCompatProvider } from "../../ai/providers/openai-compatible-catalog";

/** Flags accepted by `/provider add`. */
export interface ParsedProviderAdd {
  id?: string;
  baseUrl?: string;
  compat?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  label?: string;
  defaultModel?: string;
  models: string[];
  preset?: string;
  force: boolean;
  /** `/provider add clear` — legacy: drop `openaiBaseUrl`. */
  clear: boolean;
  /** Unrecognized `--flag`s, reported instead of silently ignored. */
  unknown: string[];
}

/**
 * Parse `/provider add` tokens. Bare positionals stay supported (`/provider add <url>
 * <model>`) because the previous release accepted them; a positional that looks like a
 * URL becomes `--base-url`, anything else becomes the default model.
 */
export function parseProviderAddArgs(tokens: readonly string[]): ParsedProviderAdd {
  const out: ParsedProviderAdd = { models: [], force: false, clear: false, unknown: [] };
  const rest = [...tokens];
  if ((rest[0] ?? "").toLowerCase() === "clear") return { ...out, clear: true };
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!;
    const next = (): string | undefined => rest[++i];
    switch (t) {
      case "--id":
      case "--name":
        out.id = next();
        break;
      case "--base-url":
      case "--url":
        out.baseUrl = next();
        break;
      case "--compat":
      case "--protocol":
        out.compat = (next() ?? "").toLowerCase();
        break;
      case "--api-key-env":
      case "--key-env":
        out.apiKeyEnv = next();
        break;
      case "--api-key":
      case "--key":
        out.apiKey = next();
        break;
      case "--label":
        out.label = next();
        break;
      case "--default-model":
        out.defaultModel = next();
        break;
      case "--model":
      case "--models":
        {
          const v = next();
          if (v) out.models.push(v);
        }
        break;
      case "--preset":
        out.preset = next();
        break;
      case "--force":
        out.force = true;
        break;
      default:
        if (t.startsWith("--")) out.unknown.push(t);
        else if (out.baseUrl === undefined && /^https?:\/\//i.test(t)) out.baseUrl = t;
        else if (out.defaultModel === undefined) out.defaultModel = t;
        break;
    }
  }
  return out;
}

export interface ProviderAddResult {
  /** Lines to print. */
  lines: string[];
  /** Provider id that was registered, when a custom provider was created. */
  id?: string;
  /** The entry to persist under `config.customProviders[id]`. */
  config?: CustomProviderConfig;
  /** Legacy path: set/clear `config.openaiBaseUrl` instead of adding a named provider. */
  legacyOpenaiBaseUrl?: string | null;
  /** Model id to make the active default, when the user asked for one. */
  selectModel?: string;
  /** True when nothing should be persisted (usage output / validation error). */
  noop: boolean;
}

const USAGE: readonly string[] = [
  "Usage:",
  "  /provider add --id <id> --base-url <url> [--compat openai|anthropic]",
  "                [--api-key-env <ENV>] [--api-key <key>] [--model a,b] [--label <name>] [--force]",
  "  /provider add --preset <preset> [--base-url <url>] [--id <id>]      · list presets: /provider presets",
  "  /provider list                      · show registered custom providers",
  "  /provider remove <id>               · unregister a custom provider",
  "  /provider add --base-url <url>      · legacy: rebind the built-in openai provider",
  "  /provider add clear                 · legacy: clear that openai base URL",
];

export function providerAddUsage(): readonly string[] {
  return USAGE;
}

/**
 * Turn parsed flags + the current config into a decision. Never throws for user error —
 * every invalid combination comes back as printable `lines` with `noop: true`, because
 * this runs inside the REPL loop where an exception would kill the session.
 */
export function planProviderAdd(parsed: ParsedProviderAdd, config: Pick<Config, "customProviders" | "openaiBaseUrl">): ProviderAddResult {
  const existing = config.customProviders ?? {};

  if (parsed.unknown.length) {
    return { lines: [`Unknown flag(s): ${parsed.unknown.join(", ")}`, ...USAGE], noop: true };
  }

  // ---- legacy: `/provider add clear` -------------------------------------
  if (parsed.clear) {
    return {
      lines: ["OpenAI-compatible base URL cleared — saved to ~/.jeo/config.json.", "(custom providers are unaffected — remove one with /provider remove <id>)"],
      legacyOpenaiBaseUrl: null,
      noop: false,
    };
  }

  // ---- preset path -------------------------------------------------------
  if (parsed.preset) {
    let expanded;
    try {
      expanded = expandProviderPreset({
        preset: parsed.preset,
        id: parsed.id,
        baseUrl: parsed.baseUrl,
        apiKeyEnv: parsed.apiKeyEnv,
        apiKey: parsed.apiKey,
        models: parsed.models.length ? parseModelList(parsed.models) : undefined,
      });
    } catch (err) {
      return { lines: [(err as Error).message], noop: true };
    }
    const collision = checkCollision(expanded.id, existing, parsed.force);
    if (collision) return { lines: collision, noop: true };
    const cfg: CustomProviderConfig = {
      ...expanded.config,
      label: parsed.label?.trim() || expanded.config.label,
      defaultModel: parsed.defaultModel?.trim() || expanded.config.defaultModel,
    };
    return {
      lines: describeRegistration(expanded.id, cfg, `preset ${expanded.preset.id}`),
      id: expanded.id,
      config: cfg,
      selectModel: selectableModel(expanded.id, cfg),
      noop: false,
    };
  }

  // ---- named custom provider --------------------------------------------
  if (parsed.id) {
    let id: string;
    try {
      id = assertValidProviderId(parsed.id);
    } catch (err) {
      return { lines: [(err as Error).message], noop: true };
    }
    if (isBuiltinCompatProvider(id)) {
      return {
        lines: [
          `'${id}' is already a built-in provider — it does not need registering.`,
          `Set its key with ${id.toUpperCase().replace(/[.\-]/g, "_")}_API_KEY, or pick a different --id.`,
        ],
        noop: true,
      };
    }
    if (!parsed.baseUrl) {
      return { lines: [`--base-url is required when adding provider '${id}'.`, ...USAGE], noop: true };
    }
    let baseUrl: string;
    try {
      baseUrl = normalizeCustomBaseUrl(parsed.baseUrl);
    } catch (err) {
      return { lines: [(err as Error).message], noop: true };
    }
    let protocol: ProviderCompatibility = "openai";
    if (parsed.compat) {
      try {
        protocol = parseProviderCompatibility(parsed.compat);
      } catch (err) {
        return { lines: [(err as Error).message], noop: true };
      }
    }
    const collision = checkCollision(id, existing, parsed.force);
    if (collision) return { lines: collision, noop: true };
    const models = parseModelList(parsed.models);
    const cfg: CustomProviderConfig = {
      label: parsed.label?.trim() || undefined,
      baseUrl,
      protocol,
      apiKeyEnv: parsed.apiKeyEnv?.trim() || undefined,
      apiKey: parsed.apiKey?.trim() || undefined,
      models: models.length ? models : undefined,
      defaultModel: parsed.defaultModel?.trim() || models[0],
    };
    return {
      lines: describeRegistration(id, cfg, "custom"),
      id,
      config: cfg,
      selectModel: selectableModel(id, cfg),
      noop: false,
    };
  }

  // ---- legacy: `/provider add --base-url <url>` (no id) -------------------
  if (parsed.baseUrl) {
    if (parsed.compat && parsed.compat !== "openai") {
      return {
        lines: [
          `--compat ${parsed.compat} needs a named provider: add --id <id> so it gets its own routing prefix.`,
          ...USAGE,
        ],
        noop: true,
      };
    }
    let url: string;
    try {
      url = normalizeCustomBaseUrl(parsed.baseUrl);
    } catch (err) {
      return { lines: [(err as Error).message], noop: true };
    }
    const lines = [
      `OpenAI-compatible endpoint set: ${url} — saved to ~/.jeo/config.json.`,
      `Tip: '/provider add --id <name> --base-url ${url}' registers it as its own provider (own prefix + models) instead of rebinding openai/.`,
    ];
    return {
      lines,
      legacyOpenaiBaseUrl: url,
      selectModel: parsed.defaultModel ? qualify("openai", parsed.defaultModel) : undefined,
      noop: false,
    };
  }

  // ---- bare `/provider add` ---------------------------------------------
  const current = config.openaiBaseUrl;
  return {
    lines: [
      current ? `OpenAI-compatible base URL: ${current}` : "No OpenAI-compatible base URL set.",
      ...USAGE,
    ],
    noop: true,
  };
}

function checkCollision(id: string, existing: Record<string, CustomProviderConfig>, force: boolean): string[] | undefined {
  if (!existing[id] || force) return undefined;
  return [
    `Provider '${id}' already exists (${existing[id]!.baseUrl}).`,
    `Re-run with --force to overwrite it, or remove it first: /provider remove ${id}`,
  ];
}

function qualify(id: string, model: string): string {
  const bare = model.startsWith(`${id}/`) ? model.slice(id.length + 1) : model;
  return `${id}/${bare}`;
}

function selectableModel(id: string, cfg: CustomProviderConfig): string | undefined {
  const bare = cfg.defaultModel ?? cfg.models?.[0];
  return bare ? qualify(id, bare) : undefined;
}

function describeRegistration(id: string, cfg: CustomProviderConfig, origin: string): string[] {
  const lines = [
    `Registered provider '${id}' (${origin}) — saved to ~/.jeo/config.json.`,
    `  endpoint : ${cfg.baseUrl}`,
    `  protocol : ${cfg.protocol ?? "openai"}`,
  ];
  if (cfg.apiKey) lines.push(`  key      : ${redactSecret(cfg.apiKey)} (stored in config)`);
  lines.push(`  key env  : ${cfg.apiKeyEnv ?? `${id.replace(/[.\-]/g, "_").toUpperCase()}_API_KEY`}`);
  if (cfg.models?.length) lines.push(`  models   : ${cfg.models.map(m => `${id}/${m}`).join(", ")}`);
  lines.push(`Use it with: /model ${selectableModel(id, cfg) ?? `${id}/<model>`}`);
  return lines;
}

// ---------------------------------------------------------------------------
// list / remove / presets
// ---------------------------------------------------------------------------

export interface ProviderRemoveResult {
  lines: string[];
  /** Id to delete from `config.customProviders`; absent when nothing should change. */
  removeId?: string;
}

export function planProviderRemove(
  rawId: string | undefined,
  config: Pick<Config, "customProviders">,
): ProviderRemoveResult {
  const existing = config.customProviders ?? {};
  const ids = Object.keys(existing);
  if (!rawId) {
    return {
      lines: ids.length
        ? ["Usage: /provider remove <id>", `Registered: ${ids.join(", ")}`]
        : ["No custom providers registered. Add one with /provider add --id <id> --base-url <url>."],
    };
  }
  const id = normalizeProviderId(rawId);
  if (!existing[id]) {
    if (isBuiltinCompatProvider(id)) {
      return { lines: [`'${id}' is a built-in provider and cannot be removed.`] };
    }
    return {
      lines: [
        `No custom provider '${id}'.`,
        ids.length ? `Registered: ${ids.join(", ")}` : "Nothing registered yet.",
      ],
    };
  }
  return {
    lines: [
      `Removed custom provider '${id}' (${existing[id]!.baseUrl}) — saved to ~/.jeo/config.json.`,
      `Models under '${id}/' no longer resolve; pick another with /model.`,
    ],
    removeId: id,
  };
}

/** Rendered `/provider list` for the custom set (built-ins stay in the main panel). */
export function formatCustomProviderList(
  config: Pick<Config, "customProviders">,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const entries = Object.entries(config.customProviders ?? {});
  if (!entries.length) {
    return [
      "No custom providers registered.",
      "Add one:  /provider add --id my-proxy --base-url https://api.example.com/v1",
      "Or use a preset:  /provider add --preset litellm --base-url http://localhost:4000/v1",
    ];
  }
  const lines = [`Custom providers (${entries.length}):`];
  for (const [id, cfg] of entries) {
    const envVar = cfg.apiKeyEnv || `${id.replace(/[.\-]/g, "_").toUpperCase()}_API_KEY`;
    const source = env[envVar] ? `env ${envVar}` : cfg.apiKey ? `config ${redactSecret(cfg.apiKey)}` : `MISSING (set ${envVar})`;
    const models = cfg.models?.length ? ` · ${cfg.models.length} model(s)` : "";
    const preset = cfg.preset ? ` · preset ${cfg.preset}` : "";
    lines.push(`  ${id}  [${cfg.protocol ?? "openai"}]  ${cfg.baseUrl}`);
    lines.push(`      key: ${source}${models}${preset}`);
  }
  return lines;
}

/** Rendered `/provider presets`. */
export function formatPresetsCommand(): string[] {
  return [
    "Provider presets (use with: /provider add --preset <id> [--base-url <url>]):",
    ...formatProviderPresetList(),
  ];
}

/** True when `token` names a known preset — used to accept `/provider add <preset>`. */
export function looksLikePreset(token: string | undefined): boolean {
  return !!token && !token.startsWith("--") && findProviderPreset(token) !== undefined;
}

/** Apply an add/remove decision to the `customProviders` map, returning a NEW map. */
export function applyCustomProviderPatch(
  existing: Record<string, CustomProviderConfig> | undefined,
  change: { addId?: string; addConfig?: CustomProviderConfig; removeId?: string },
): Record<string, CustomProviderConfig> | undefined {
  const next: Record<string, CustomProviderConfig> = { ...(existing ?? {}) };
  if (change.removeId) delete next[change.removeId];
  if (change.addId && change.addConfig) next[change.addId] = change.addConfig;
  return Object.keys(next).length ? next : undefined;
}
