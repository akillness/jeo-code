/**
 * Provider credential/status inventory — the shared source of truth behind
 * the TUI `/provider` command, `jeo doctor`, and setup probes. Reports, for
 * each provider, how it will authenticate (API key / OAuth / keyless / none),
 * its effective base URL, and whether it is ready to serve a request.
 */
import { readGlobalConfig, type Config, type OAuthEntry, type OAuthPoolEntry } from "../agent/state";
import {
  isOAuthProvider,
  API_KEY_ONLY_PROVIDERS,
  normalizeOAuthPool,
  oauthEntryAccess,
  oauthEntryDead as isEntryDead,
  apiKeyPoolFor,
  type AuthProvider,
  type Credential,
} from "../auth";
import { OAUTH_FLOW_REGISTRY } from "../auth/flows";
import type { ProviderName } from "./types";

import { OPENAI_COMPAT_NAMES, openaiCompatDef } from "./providers/openai-compatible-catalog";
import { customProviderDef, customProviderNames, credentialSourceOf, resolveCustomApiKey } from "./providers/custom-providers";

/** Compiled-in providers, in declaration order. Custom providers are NOT here — they
 *  are discovered at runtime, so use {@link allProviderNames} for anything the user sees. */
export const PROVIDER_NAMES: readonly ProviderName[] = ["anthropic", "openai", "gemini", "antigravity", "agy", "ollama", "lmstudio", "xai", "kimi", ...OPENAI_COMPAT_NAMES];

/** Built-in providers PLUS the user's registered custom providers. Every user-facing
 *  surface (pickers, `/provider`, autocomplete, doctor) should list from here so a
 *  custom endpoint is never invisible in the UI that is supposed to expose it. */
export function allProviderNames(): readonly ProviderName[] {
  const custom = customProviderNames();
  return custom.length ? [...PROVIDER_NAMES, ...custom] : PROVIDER_NAMES;
}

/** Cloud providers that authenticate via API key / OAuth. Ollama is keyless. */
export const CLOUD_PROVIDERS: readonly AuthProvider[] = ["anthropic", "openai", "gemini", "antigravity"];

export type CredentialKind = "api_key" | "oauth" | "keyless" | "cli_session" | "none";

export interface ProviderStatus {
  name: ProviderName;
  kind: CredentialKind;
  /** Display label, e.g. "API key", "OAuth", "keyless (local)", "none (run 'jeo setup')". */
  label: string;
  /** Effective base URL when relevant (ollama / openai-compatible). */
  baseUrl?: string;
  /** Environment variable that would supply an API key, when applicable. */
  envVar?: string;
  /** True when the provider can serve a request right now. */
  ready: boolean;
  /** True when an OAuth credential is stored for this provider (logged in via OAuth). */
  loggedIn?: boolean;
  /** Account email from the stored OAuth credential, when known. */
  oauthEmail?: string;
  /** Epoch ms expiry of the stored OAuth access token, when known. */
  oauthExpires?: number;
  /** Number of OAuth accounts in the provider's login pool (when > 0). */
  poolSize?: number;
  /** Number of API keys in the provider's key pool (when > 0). */
  apiKeyPoolSize?: number;
  /** True for user-registered custom providers (`config.customProviders`). */
  custom?: boolean;
}

/** The env var that supplies a provider's API key. Catalog providers carry their
 *  own (e.g. HF_TOKEN, NANO_GPT_API_KEY); built-ins use `<PROVIDER>_API_KEY`. */
export function providerEnvVar(name: ProviderName): string | undefined {
  if (name === "ollama" || name === "lmstudio" || name === "antigravity") return undefined;
  if (name === "agy") return undefined;
  const def = openaiCompatDef(name);
  if (def) return def.apiKeyEnv;
  return `${name.toUpperCase()}_API_KEY`;
}

/** The API key a custom provider will actually use, or undefined. Exported so setup /
 *  doctor can probe a custom endpoint without re-deriving the env-vs-literal rule. */
export function customProviderApiKey(name: ProviderName): string | undefined {
  const def = customProviderDef(name);
  return def ? resolveCustomApiKey(def) : undefined;
}

/** Human label for a credential kind. */
export function credentialLabel(kind: CredentialKind): string {
  switch (kind) {
    case "api_key":
      return "API key";
    case "oauth":
      return "OAuth";
    case "keyless":
      return "keyless (local)";
    case "none":
      return "none (run 'jeo setup' or 'jeo auth login')";
    case "cli_session":
      return "external CLI session (agy; auth and permissions managed by the CLI)";
  }
}

function pickLiveOAuthEntry(raw: OAuthPoolEntry | undefined): OAuthEntry | undefined {
  const pool = normalizeOAuthPool(raw);
  return pool.find(entry => !isEntryDead(entry)) ?? pool[0];
}

/** Login metadata (account email / expiry) from a stored OAuth pool, when present. */
function oauthLoginInfo(raw: OAuthPoolEntry | undefined): { loggedIn: boolean; oauthEmail?: string; oauthExpires?: number; poolSize: number } {
  const pool = normalizeOAuthPool(raw);
  if (pool.length === 0) return { loggedIn: false, poolSize: 0 };
  const active = pickLiveOAuthEntry(raw) ?? pool[0]!;
  if (typeof active === "string") return { loggedIn: true, poolSize: pool.length };
  return { loggedIn: true, oauthEmail: active.email, oauthExpires: active.expires, poolSize: pool.length };
}

function oauthPoolDead(raw: OAuthPoolEntry | undefined): boolean {
  const pool = normalizeOAuthPool(raw);
  return pool.length > 0 && pool.every(entry => isEntryDead(entry));
}

function configuredCredential(provider: AuthProvider, cfg: Config): Credential {
  const stored = pickLiveOAuthEntry(cfg.oauth?.[provider]);
  const oauth = oauthEntryAccess(stored);
  if (oauth) return { kind: "oauth", provider, token: oauth, projectId: typeof stored === "object" ? stored.projectId : undefined };
  const keys = apiKeyPoolFor(provider, cfg);
  if (keys[0]) return { kind: "api_key", provider, token: keys[0] };
  return { kind: "none", provider };
}

/** Mirror the real call path: OAuth (the user's explicit login) wins whenever the
 * bundled adapter serves it end-to-end. OpenAI OAuth only serves Codex models, and an
 * OAuth backend not verified end-to-end can't serve calls, so an API key stays the
 * working path in those cases — otherwise the stored OAuth credential is preferred. */
function effectiveCredential(provider: AuthProvider, cred: Credential, cfg: Config): Credential {
  const key = cfg.providers?.[provider];
  if (cred.kind !== "oauth" || !key) return cred;
  const oauthGeneral =
    provider !== "openai" &&
    !(isOAuthProvider(provider) && OAUTH_FLOW_REGISTRY[provider].verifiedEndToEnd === false);
  return oauthGeneral ? cred : { kind: "api_key", provider, token: key };
}


/** Resolve the status of a single provider. */
export async function describeProvider(name: ProviderName, config?: Config): Promise<ProviderStatus> {
  const cfg = config ?? (await readGlobalConfig());
  if (name === "agy") {
    let executable: string | undefined;
    try {
      executable = Bun.which("agy") ?? undefined;
    } catch {
      executable = undefined;
    }
    return {
      name,
      kind: "cli_session",
      label: executable
        ? `UNKNOWN — external CLI session (agy available at ${executable}; auth/permissions are externally managed; not probed)`
        : "external CLI session unavailable — agy CLI not found on PATH; install/login with the official agy CLI; jeo does not manage its credentials",
      ready: !!executable,
    };
  }
  // Custom providers resolve their credential from their OWN env var / stored literal,
  // not from the fixed `providers` union — report that source verbatim so a user who
  // set the wrong env var sees WHICH variable jeo is looking at.
  const custom = customProviderDef(name);
  if (custom) {
    const source = credentialSourceOf(custom);
    const missing = source === "none" && custom.requiresApiKey;
    return {
      name,
      kind: missing ? "none" : source === "none" ? "keyless" : "api_key",
      label: missing ? `missing API key (${custom.apiKeyEnv}) · custom` : source === "none"
        ? "keyless · custom"
        : `API key (${source === "env" ? custom.apiKeyEnv : "stored in config"}) · custom${custom.preset ? ` · preset ${custom.preset}` : ""}`,
      baseUrl: custom.baseUrl,
      envVar: custom.apiKeyEnv,
      ready: !missing,
      custom: true,
    };
  }
  if (name === "ollama" || name === "lmstudio") {
    const baseUrl = name === "ollama"
      ? (cfg.ollamaBaseUrl ?? "http://localhost:11434")
      : (cfg.lmstudioBaseUrl ?? "http://localhost:1234/v1");
    return { name, kind: "keyless", label: credentialLabel("keyless"), baseUrl, ready: true };
  }
  if ((API_KEY_ONLY_PROVIDERS as readonly string[]).includes(name)) {
    // API-key-only providers (xai/kimi): no OAuth flow — ready when their key is set.
    const keys = apiKeyPoolFor(name as AuthProvider, cfg);
    const envVar = providerEnvVar(name);
    const suffix = keys.length > 1 ? ` (${keys.length} keys)` : "";
    return {
      name,
      kind: keys[0] ? "api_key" : "none",
      label: keys[0] ? `${credentialLabel("api_key")}${suffix}` : `none (set ${envVar})`,
      envVar,
      ready: !!keys[0],
      apiKeyPoolSize: keys.length,
    };
  }
  const ownProvider = name as AuthProvider;
  const ownCred = configuredCredential(ownProvider, cfg);
  // Antigravity prefers its own login but accepts a gemini OAuth fallback (the
  // DEFAULT OAuth-served path for Gemini models now that plain gemini/* requires
  // an API key).
  const cred = name === "antigravity" && ownCred.kind === "none" ? configuredCredential("gemini", cfg) : ownCred;
  const credentialProvider: AuthProvider = name === "antigravity" && ownCred.kind === "none" ? "gemini" : ownProvider;
  const effective = name === "antigravity" ? cred : effectiveCredential(credentialProvider, cred, cfg);
  const kind: CredentialKind = effective.kind === "api_key" ? "api_key" : effective.kind === "oauth" ? "oauth" : "none";
  const baseUrl = name === "openai" && kind !== "oauth" ? cfg.openaiBaseUrl : undefined;
  const oauthPool = normalizeOAuthPool(cfg.oauth?.[credentialProvider]);
  const keyPool = apiKeyPoolFor(credentialProvider, cfg);
  let ready = kind === "api_key" || (kind === "oauth" && !oauthPoolDead(cfg.oauth?.[credentialProvider])) || (name === "openai" && !!cfg.openaiBaseUrl);
  let label = ready && kind === "none" ? "keyless (local base URL)" : credentialLabel(kind);
  if (name === "antigravity") {
    const ownPool = normalizeOAuthPool(cfg.oauth?.antigravity);
    const hasOwnOAuth = ownCred.kind === "oauth" && !oauthPoolDead(cfg.oauth?.antigravity);
    const geminiPool = normalizeOAuthPool(cfg.oauth?.gemini);
    const hasGeminiFallback = !hasOwnOAuth && configuredCredential("gemini", cfg).kind === "oauth" && !oauthPoolDead(cfg.oauth?.gemini);
    const ownDead = ownCred.kind === "oauth" && !hasOwnOAuth;
    ready = hasOwnOAuth || hasGeminiFallback;
    label = hasOwnOAuth
      ? `OAuth (Antigravity Cloud Code Assist${ownPool.length > 1 ? ` · ${ownPool.length} accounts` : ""})`
      : hasGeminiFallback
        ? `OAuth (Cloud Code Assist via gemini login fallback${geminiPool.length > 1 ? ` · ${geminiPool.length} accounts` : ""})`
        : ownDead
          ? "OAuth expired, no refresh token — run 'jeo auth login antigravity' to re-authenticate"
          : "none (run 'jeo auth login antigravity')";
  } else if (name === "gemini" && kind === "oauth") {
    ready = false;
    label = "OAuth catalog only; set GEMINI_API_KEY, or use antigravity/* models (Cloud Code Assist)";
  } else if (kind === "oauth" && isOAuthProvider(credentialProvider) && OAUTH_FLOW_REGISTRY[credentialProvider].verifiedEndToEnd === false) {
    ready = false;
    label = "OAuth (API key needed)";
  } else if (kind === "oauth" && oauthPoolDead(cfg.oauth?.[credentialProvider])) {
    label = `OAuth expired, no refresh token — run 'jeo auth login ${credentialProvider}' to re-authenticate`;
  } else if (kind === "oauth" && oauthPool.length > 1) {
    label = `${label} (${oauthPool.length} accounts)`;
  } else if (kind === "api_key" && keyPool.length > 1) {
    label = `${label} (${keyPool.length} keys)`;
  }
  const login = oauthLoginInfo(cfg.oauth?.[ownProvider]);
  return {
    name,
    kind,
    label,
    baseUrl,
    envVar: providerEnvVar(name),
    ready,
    loggedIn: login.loggedIn,
    oauthEmail: login.oauthEmail,
    oauthExpires: login.oauthExpires,
    poolSize: login.poolSize,
    apiKeyPoolSize: keyPool.length,
  };
}

/** Resolve the status of every provider (single config read), custom providers included. */
export async function describeAllProviders(config?: Config): Promise<ProviderStatus[]> {
  const cfg = config ?? (await readGlobalConfig());
  return Promise.all(allProviderNames().map(name => describeProvider(name, cfg)));
}
