/**
 * Provider credential/status inventory — the shared source of truth behind
 * the TUI `/provider` command, `jeo doctor`, and setup probes. Reports, for
 * each provider, how it will authenticate (API key / OAuth / keyless / none),
 * its effective base URL, and whether it is ready to serve a request.
 */
import { readGlobalConfig, type Config, type StoredOAuth } from "../agent/state";
import { isOAuthProvider, API_KEY_ONLY_PROVIDERS, type AuthProvider, type Credential } from "../auth";
import { OAUTH_FLOW_REGISTRY } from "../auth/flows";
import type { ProviderName } from "./types";

import { OPENAI_COMPAT_NAMES, openaiCompatDef } from "./providers/openai-compatible-catalog";
import { customProviderDef, customProviderNames, credentialSourceOf, resolveCustomApiKey } from "./providers/custom-providers";

/** Compiled-in providers, in declaration order. Custom providers are NOT here — they
 *  are discovered at runtime, so use {@link allProviderNames} for anything the user sees. */
export const PROVIDER_NAMES: readonly ProviderName[] = ["anthropic", "openai", "gemini", "antigravity", "ollama", "lmstudio", "xai", "kimi", ...OPENAI_COMPAT_NAMES];

/** Built-in providers PLUS the user's registered custom providers. Every user-facing
 *  surface (pickers, `/provider`, autocomplete, doctor) should list from here so a
 *  custom endpoint is never invisible in the UI that is supposed to expose it. */
export function allProviderNames(): readonly ProviderName[] {
  const custom = customProviderNames();
  return custom.length ? [...PROVIDER_NAMES, ...custom] : PROVIDER_NAMES;
}

/** Cloud providers that authenticate via API key / OAuth. Ollama is keyless. */
export const CLOUD_PROVIDERS: readonly AuthProvider[] = ["anthropic", "openai", "gemini", "antigravity"];

export type CredentialKind = "api_key" | "oauth" | "keyless" | "none";

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
  /** True for user-registered custom providers (`config.customProviders`). */
  custom?: boolean;
}

/** The env var that supplies a provider's API key. Catalog providers carry their
 *  own (e.g. HF_TOKEN, NANO_GPT_API_KEY); built-ins use `<PROVIDER>_API_KEY`. */
export function providerEnvVar(name: ProviderName): string | undefined {
  if (name === "ollama" || name === "lmstudio" || name === "antigravity") return undefined;
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
  }
}

function oauthAccess(stored: string | StoredOAuth | undefined): string | undefined {
  if (!stored) return undefined;
  return typeof stored === "string" ? stored : stored.access;
}

/** Login metadata (account email / expiry) from a stored OAuth record, when present. */
function oauthLoginInfo(stored: string | StoredOAuth | undefined): { loggedIn: boolean; oauthEmail?: string; oauthExpires?: number } {
  if (!stored) return { loggedIn: false };
  if (typeof stored === "string") return { loggedIn: true };
  return { loggedIn: true, oauthEmail: stored.email, oauthExpires: stored.expires };
}

/** True when a stored OAuth entry is DEFINITIVELY unusable right now: its access
 *  token is past expiry AND it has no refresh token to recover with. This is the
 *  gap `ready` used to miss — checking only "is a credential object present",
 *  never whether it's actually alive — so a session could route to a provider
 *  whose OAuth died (refresh token revoked/missing) and only discover that via a
 *  raw 401 from the real API call, after routing had already committed to it.
 *  An expired token WITH a refresh token is NOT flagged dead: `resolveCredential`
 *  (the real call path) auto-refreshes those before use, so a live refresh token
 *  self-heals without ever reaching this check. Legacy string-only stored tokens
 *  (no tracked expiry) are never flagged dead either — there's nothing to check. */
function oauthEntryDead(stored: string | StoredOAuth | undefined): boolean {
  if (!stored || typeof stored === "string") return false;
  return !!stored.expires && stored.expires <= Date.now() && !stored.refresh;
}

function configuredCredential(provider: AuthProvider, cfg: Config): Credential {
  const stored = cfg.oauth?.[provider];
  const oauth = oauthAccess(stored);
  if (oauth) return { kind: "oauth", provider, token: oauth, projectId: typeof stored === "object" ? stored.projectId : undefined };
  const key = cfg.providers?.[provider];
  if (key) return { kind: "api_key", provider, token: key };
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
  // Custom providers resolve their credential from their OWN env var / stored literal,
  // not from the fixed `providers` union — report that source verbatim so a user who
  // set the wrong env var sees WHICH variable jeo is looking at.
  const custom = customProviderDef(name);
  if (custom) {
    const source = credentialSourceOf(custom);
    const ready = source !== "none";
    return {
      name,
      kind: ready ? "api_key" : "none",
      label: ready
        ? `API key (${source === "env" ? custom.apiKeyEnv : "stored in config"}) · custom${custom.preset ? ` · preset ${custom.preset}` : ""}`
        : `none (set ${custom.apiKeyEnv}, or 'jeo provider key ${name} <key>')`,
      baseUrl: custom.baseUrl,
      envVar: custom.apiKeyEnv,
      ready,
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
    const key = cfg.providers?.[name as AuthProvider];
    const envVar = providerEnvVar(name);
    return {
      name,
      kind: key ? "api_key" : "none",
      label: key ? credentialLabel("api_key") : `none (set ${envVar})`,
      envVar,
      ready: !!key,
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
  let ready = kind === "api_key" || (kind === "oauth" && !oauthEntryDead(cfg.oauth?.[credentialProvider])) || (name === "openai" && !!cfg.openaiBaseUrl);
  let label = ready && kind === "none" ? "keyless (local base URL)" : credentialLabel(kind);
  if (name === "antigravity") {
    const hasOwnOAuth = ownCred.kind === "oauth" && !oauthEntryDead(cfg.oauth?.antigravity);
    const hasGeminiFallback = !hasOwnOAuth && configuredCredential("gemini", cfg).kind === "oauth" && !oauthEntryDead(cfg.oauth?.gemini);
    const ownDead = ownCred.kind === "oauth" && !hasOwnOAuth;
    ready = hasOwnOAuth || hasGeminiFallback;
    label = hasOwnOAuth
      ? "OAuth (Antigravity Cloud Code Assist)"
      : hasGeminiFallback
        ? "OAuth (Cloud Code Assist via gemini login fallback)"
        : ownDead
          ? "OAuth expired, no refresh token — run 'jeo auth login antigravity' to re-authenticate"
          : "none (run 'jeo auth login antigravity')";
  } else if (name === "gemini" && kind === "oauth") {
    // OAuth alone no longer serves google/gemini-* (the gemini-cli/Cloud Code Assist
    // masquerade was removed) — GEMINI_API_KEY is required. The SAME models remain
    // OAuth-only reachable via antigravity/*.
    ready = false;
    label = "OAuth catalog only; set GEMINI_API_KEY, or use antigravity/* models (Cloud Code Assist)";
  } else if (kind === "oauth" && isOAuthProvider(credentialProvider) && OAUTH_FLOW_REGISTRY[credentialProvider].verifiedEndToEnd === false) {
    ready = false;
    label = "OAuth (API key needed)";
  } else if (kind === "oauth" && oauthEntryDead(cfg.oauth?.[credentialProvider])) {
    label = `OAuth expired, no refresh token — run 'jeo auth login ${credentialProvider}' to re-authenticate`;
  }
  // Login status reflects the provider's OWN stored OAuth (e.g. "logged in to antigravity"),
  // independent of any cross-provider credential fallback used for readiness.
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
  };
}

/** Resolve the status of every provider (single config read), custom providers included. */
export async function describeAllProviders(config?: Config): Promise<ProviderStatus[]> {
  const cfg = config ?? (await readGlobalConfig());
  return Promise.all(allProviderNames().map(name => describeProvider(name, cfg)));
}
