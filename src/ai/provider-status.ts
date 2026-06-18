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

export const PROVIDER_NAMES: readonly ProviderName[] = ["anthropic", "openai", "gemini", "antigravity", "ollama", "lmstudio", "xai", "kimi", ...OPENAI_COMPAT_NAMES];

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
}

/** The env var that supplies a provider's API key. Catalog providers carry their
 *  own (e.g. HF_TOKEN, NANO_GPT_API_KEY); built-ins use `<PROVIDER>_API_KEY`. */
export function providerEnvVar(name: ProviderName): string | undefined {
  if (name === "ollama" || name === "lmstudio" || name === "antigravity") return undefined;
  const def = openaiCompatDef(name);
  if (def) return def.apiKeyEnv;
  return `${name.toUpperCase()}_API_KEY`;
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

function configuredCredential(provider: AuthProvider, cfg: Config): Credential {
  const stored = cfg.oauth?.[provider];
  const oauth = oauthAccess(stored);
  if (oauth) return { kind: "oauth", provider, token: oauth, projectId: typeof stored === "object" ? stored.projectId : undefined };
  const key = cfg.providers?.[provider];
  if (key) return { kind: "api_key", provider, token: key };
  return { kind: "none", provider };
}

/** Match the real call path: API keys are broader and win whenever both key + OAuth exist. */
function effectiveCredential(provider: AuthProvider, cred: Credential, cfg: Config): Credential {
  const key = cfg.providers?.[provider];
  if (cred.kind === "oauth" && key) return { kind: "api_key", provider, token: key };
  return cred;
}


/** Resolve the status of a single provider. */
export async function describeProvider(name: ProviderName, config?: Config): Promise<ProviderStatus> {
  const cfg = config ?? (await readGlobalConfig());
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
  // Antigravity prefers its own login but accepts a gemini-cli OAuth fallback.
  const cred = name === "antigravity" && ownCred.kind === "none" ? configuredCredential("gemini", cfg) : ownCred;
  const credentialProvider: AuthProvider = name === "antigravity" && ownCred.kind === "none" ? "gemini" : ownProvider;
  const effective = name === "antigravity" ? cred : effectiveCredential(credentialProvider, cred, cfg);
  const kind: CredentialKind = effective.kind === "api_key" ? "api_key" : effective.kind === "oauth" ? "oauth" : "none";
  const baseUrl = name === "openai" && kind !== "oauth" ? cfg.openaiBaseUrl : undefined;
  let ready = kind !== "none" || (name === "openai" && !!cfg.openaiBaseUrl);
  let label = ready && kind === "none" ? "keyless (local base URL)" : credentialLabel(kind);
  if (name === "antigravity") {
    const hasOwnOAuth = ownCred.kind === "oauth";
    const hasGeminiFallback = !hasOwnOAuth && configuredCredential("gemini", cfg).kind === "oauth";
    ready = hasOwnOAuth;
    label = hasOwnOAuth
      ? "OAuth (Antigravity Cloud Code Assist)"
      : hasGeminiFallback
        ? "OAuth catalog via Gemini CLI; calls need 'jeo auth login antigravity'"
        : "none (run 'jeo auth login antigravity')";
  } else if (kind === "oauth" && isOAuthProvider(credentialProvider) && OAUTH_FLOW_REGISTRY[credentialProvider].verifiedEndToEnd === false) {
    ready = false;
    label = "OAuth (API key needed)";
  } else if (name === "gemini" && kind === "oauth") {
    // gemini-cli OAuth is served end-to-end via Cloud Code Assist — no API key.
    label = "OAuth (Gemini CLI / Cloud Code Assist)";
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

/** Resolve the status of every provider (single config read). */
export async function describeAllProviders(config?: Config): Promise<ProviderStatus[]> {
  const cfg = config ?? (await readGlobalConfig());
  return Promise.all(PROVIDER_NAMES.map(name => describeProvider(name, cfg)));
}
