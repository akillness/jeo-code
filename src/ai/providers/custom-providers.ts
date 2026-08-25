/**
 * User-defined ("custom") provider registry — gjc/gajae-code parity.
 *
 * jeo ships a fixed, data-driven catalog of OpenAI/Anthropic-compatible clouds
 * (`OPENAI_COMPAT_PROVIDERS`). That table is compiled in: a user could not point jeo
 * at their own gateway (LiteLLM behind a company proxy, a self-hosted vLLM, an
 * OpenRouter-style aggregator, a corporate Anthropic proxy) without patching source.
 * The single escape hatch was `config.openaiBaseUrl`, which rebinds the ONE built-in
 * `openai` provider — so only one custom endpoint could exist at a time, it stole the
 * `openai/` routing prefix, and its models collided with real OpenAI ids.
 *
 * This module adds NAMED custom providers: each gets its own routing prefix, base URL,
 * wire protocol, credential source, and model list, persisted under
 * `config.customProviders`. They are surfaced through the SAME lookup the built-in
 * catalog uses (`openaiCompatDef`), so discovery, routing, `/model`, `/provider`,
 * status, and the adapter factories all pick them up with no per-call-site branching.
 *
 * Design constraints (kept deliberately narrow so the generic paths stay simple):
 *  - `id` is the routing prefix (`<id>/…`) AND the config/auth key — same rule as the
 *    built-in catalog, so `resolveProvider()` needs no special case.
 *  - Only the two wire protocols jeo already speaks are allowed ("openai" | "anthropic").
 *  - The credential is either a literal key stored in config, or the name of an env var.
 *    Env is the default and the recommended path (nothing secret lands on disk).
 */
import type { ProviderName } from "../types";
import type { OpenAICompatProviderDef } from "./openai-compatible-catalog";

/** Wire protocols a custom provider may speak — the two jeo already implements. */
export type ProviderCompatibility = "openai" | "anthropic";

/** Where a custom provider's API key comes from. */
export type CredentialSource = "env" | "literal" | "none";

/** One user-defined provider, as persisted under `config.customProviders[id]`. */
export interface CustomProviderConfig {
  /** Display label (defaults to the id when absent). */
  label?: string;
  /** API base URL. OpenAI protocol → `${base}/chat/completions` + `${base}/models`;
   *  Anthropic protocol → `${base}/v1/messages` + `${base}/v1/models`. */
  baseUrl: string;
  /** Wire protocol. Defaults to "openai". */
  protocol?: ProviderCompatibility;
  /** Env var holding the API key. Defaults to `<ID>_API_KEY` (id upper-cased, `-`/`.` → `_`). */
  apiKeyEnv?: string;
  /** Literal API key. Only set when the user explicitly chose the "literal" source;
   *  redacted everywhere it is displayed. `apiKeyEnv` wins when both resolve. */
  apiKey?: string;
  /** Known model ids (BARE, not prefixed) for the offline pick-list. Live `/models`
   *  discovery supersedes this once the endpoint answers. */
  models?: string[];
  /** Default model id (BARE or prefixed) used by `--provider <id>`. */
  defaultModel?: string;
  /** Native-reasoning enablement, same semantics as the built-in catalog. */
  thinkingFormat?: "openai" | "openrouter" | "qwen" | "zai";
  /** The preset this entry was created from, when applicable (informational). */
  preset?: string;
}

export type CustomProviderMap = Record<string, CustomProviderConfig>;

/** A validated custom provider, normalized into the catalog's own shape. */
export interface CustomProviderDef extends OpenAICompatProviderDef {
  /** True — distinguishes a user entry from a compiled-in catalog row. */
  readonly custom: true;
  /** Literal key when the user chose the "literal" credential source. */
  readonly literalApiKey?: string;
  /** Preset id this entry came from, when applicable. */
  readonly preset?: string;
}

/** Provider ids the user may NOT claim: every compiled-in provider plus reserved words. */
export const RESERVED_PROVIDER_IDS: readonly string[] = [
  "anthropic",
  "openai",
  "gemini",
  "antigravity",
  "ollama",
  "lmstudio",
  "xai",
  "kimi",
  // Reserved so a future built-in cannot be shadowed by a stale user entry.
  "google",
  "vertex",
  "bedrock",
  "azure",
  "copilot",
  "cursor",
  "codex",
  "auto",
  "default",
  "none",
  "all",
  "help",
  "clear",
  "list",
  "add",
  "remove",
  "rm",
];

/** Same grammar gajae-code enforces: lowercase, starts alphanumeric, `.`/`_`/`-` inside. */
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const MAX_PROVIDER_ID_LENGTH = 48;
const REDACT_PREFIX = 4;
const REDACT_SUFFIX = 4;

/** Lowercase + trim. Ids are case-insensitive so `/model MyProxy/x` still routes. */
export function normalizeProviderId(id: string): string {
  return id.trim().toLowerCase();
}

/** Derived env var for a provider id: `my-proxy` → `MY_PROXY_API_KEY`. */
export function defaultApiKeyEnv(id: string): string {
  return `${normalizeProviderId(id).replace(/[.\-]/g, "_").toUpperCase()}_API_KEY`;
}

/**
 * Validate a candidate custom-provider id. Throws with an actionable message rather
 * than returning a boolean, because every call site (CLI, slash command, config load)
 * wants the reason to show the user.
 */
export function assertValidProviderId(rawId: string, reserved: readonly string[] = RESERVED_PROVIDER_IDS): string {
  const id = normalizeProviderId(rawId);
  if (!id) throw new Error("Provider id is required (e.g. --id my-proxy).");
  if (id.length > MAX_PROVIDER_ID_LENGTH) {
    throw new Error(`Provider id '${id}' is too long (max ${MAX_PROVIDER_ID_LENGTH} characters).`);
  }
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid provider id '${id}'. Use lowercase letters, digits, '.', '_' or '-', starting with a letter or digit.`,
    );
  }
  if ((reserved as readonly string[]).includes(id)) {
    throw new Error(`Provider id '${id}' is reserved by a built-in provider — pick another id.`);
  }
  return id;
}

/** Parse a compatibility flag the way gajae-code does (accepts the common aliases). */
export function parseProviderCompatibility(value: string): ProviderCompatibility {
  const v = value.trim().toLowerCase();
  if (v === "openai" || v === "openai-compatible" || v === "oai" || v === "chat" || v === "completions") return "openai";
  if (v === "anthropic" || v === "anthropic-compatible" || v === "claude" || v === "messages") return "anthropic";
  throw new Error(`Provider compatibility must be 'openai' or 'anthropic' (got '${value}').`);
}

/**
 * Normalize + validate a base URL. Rejects anything that is not an absolute http(s)
 * URL so a typo ("localhost:1234") fails at registration time with a clear message
 * instead of at the first inference call with an opaque fetch error.
 */
export function normalizeCustomBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Base URL is required (e.g. --base-url https://api.example.com/v1).");
  // `new URL("localhost:1234/v1")` PARSES — as scheme "localhost:" — so a missing scheme
  // would otherwise surface as a confusing "must use http or https (got 'localhost')".
  // Check for the authority marker first and give the actionable hint instead.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw new Error(`Invalid base URL '${raw}' — include the scheme, e.g. https://api.example.com/v1`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid base URL '${raw}' — include the scheme, e.g. https://api.example.com/v1`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Base URL must use http or https (got '${parsed.protocol.replace(":", "")}').`);
  }
  if (!parsed.hostname) throw new Error(`Invalid base URL '${raw}' — no host.`);
  // Keep the path (gateways live under /v1, /api/v1, /openai/v1 …); drop a trailing
  // slash so `${base}/chat/completions` never produces a double slash.
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${path}${parsed.search}`;
}

/** `sk-abcd…wxyz` — never print a raw key back to the user or a log. */
export function redactSecret(secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) return "";
  if (trimmed.length <= REDACT_PREFIX + REDACT_SUFFIX) return "***";
  return `${trimmed.slice(0, REDACT_PREFIX)}…${trimmed.slice(-REDACT_SUFFIX)}`;
}

/** Split/flatten `--model a,b --model c` into a deduped, ordered id list. */
export function parseModelList(values: readonly string[]): string[] {
  const out = values
    .flatMap(v => v.split(","))
    .map(v => v.trim())
    .filter(v => v.length > 0);
  return [...new Set(out)];
}

/** Strip a `<id>/` routing prefix from a model id, if present. */
export function stripProviderPrefix(id: string, modelId: string): string {
  const prefix = `${id}/`;
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}

/**
 * Normalize one persisted entry into the catalog shape every generic path consumes.
 * Throws when the entry is unusable (bad id / base URL) so a corrupt config surfaces
 * as one clear error rather than a provider that 404s on every call.
 */
export function toCustomProviderDef(rawId: string, cfg: CustomProviderConfig): CustomProviderDef {
  const id = assertValidProviderId(rawId);
  const baseUrl = normalizeCustomBaseUrl(cfg.baseUrl);
  const protocol: ProviderCompatibility = cfg.protocol === "anthropic" ? "anthropic" : "openai";
  const apiKeyEnv = cfg.apiKeyEnv?.trim() || defaultApiKeyEnv(id);
  const models = (cfg.models ?? []).map(m => stripProviderPrefix(id, m.trim())).filter(Boolean);
  const bareDefault = cfg.defaultModel ? stripProviderPrefix(id, cfg.defaultModel.trim()) : models[0];
  return {
    custom: true,
    name: id as ProviderName,
    label: cfg.label?.trim() || id,
    baseUrl,
    apiKeyEnv,
    // `defaultModel` is provider-qualified in the catalog contract; fall back to a
    // placeholder that makes the missing-model state obvious instead of routing to "".
    defaultModel: bareDefault ? `${id}/${bareDefault}` : `${id}/`,
    knownModels: models.length ? models : undefined,
    protocol,
    thinkingFormat: cfg.thinkingFormat,
    literalApiKey: cfg.apiKey?.trim() || undefined,
    preset: cfg.preset,
  };
}

/** Which credential source a def will actually use at call time. */
export function credentialSourceOf(def: CustomProviderDef, env: NodeJS.ProcessEnv = process.env): CredentialSource {
  if (env[def.apiKeyEnv]) return "env";
  if (def.literalApiKey) return "literal";
  return "none";
}

/**
 * Resolve the API key for a custom provider. Env wins over the stored literal so a
 * rotated key in the shell takes effect without editing config.json.
 */
export function resolveCustomApiKey(def: CustomProviderDef, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[def.apiKeyEnv] || def.literalApiKey || undefined;
}

// ---------------------------------------------------------------------------
// Runtime registry
// ---------------------------------------------------------------------------

let CUSTOM_DEFS: readonly CustomProviderDef[] = [];
let CUSTOM_BY_ID = new Map<string, CustomProviderDef>();

/** Listeners fired whenever the custom set changes (registry rebuild, status refresh). */
const listeners = new Set<(defs: readonly CustomProviderDef[]) => void>();

export function onCustomProvidersChanged(fn: (defs: readonly CustomProviderDef[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Replace the active custom provider set. Invalid entries are SKIPPED (with their
 * reason returned) rather than throwing: one bad hand-edited row must never stop jeo
 * from starting with the rest of the user's providers intact.
 */
export function setCustomProviders(map: CustomProviderMap | undefined): { defs: readonly CustomProviderDef[]; errors: string[] } {
  const defs: CustomProviderDef[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [rawId, cfg] of Object.entries(map ?? {})) {
    if (!cfg || typeof cfg !== "object") {
      errors.push(`customProviders.${rawId}: not an object — skipped.`);
      continue;
    }
    try {
      const def = toCustomProviderDef(rawId, cfg);
      if (seen.has(def.name)) {
        errors.push(`customProviders.${rawId}: duplicate id '${def.name}' — skipped.`);
        continue;
      }
      seen.add(def.name);
      defs.push(def);
    } catch (err) {
      errors.push(`customProviders.${rawId}: ${(err as Error).message}`);
    }
  }
  CUSTOM_DEFS = defs;
  CUSTOM_BY_ID = new Map(defs.map(d => [d.name, d]));
  for (const fn of listeners) {
    try {
      fn(CUSTOM_DEFS);
    } catch {
      // A misbehaving listener must not break provider registration.
    }
  }
  return { defs: CUSTOM_DEFS, errors };
}

/** Every registered custom provider, in config order. */
export function customProviderDefs(): readonly CustomProviderDef[] {
  return CUSTOM_DEFS;
}

/** Lookup by id (already normalized or not). */
export function customProviderDef(name: string): CustomProviderDef | undefined {
  return CUSTOM_BY_ID.get(normalizeProviderId(name));
}

/** True when `name` is a user-registered custom provider. */
export function isCustomProvider(name: string): boolean {
  return CUSTOM_BY_ID.has(normalizeProviderId(name));
}

/** All custom provider ids. */
export function customProviderNames(): readonly ProviderName[] {
  return CUSTOM_DEFS.map(d => d.name);
}

/** Drop every registered custom provider (test isolation / `/provider add clear`). */
export function clearCustomProviders(): void {
  setCustomProviders({});
}
