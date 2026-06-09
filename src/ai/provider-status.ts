/**
 * Provider credential/status inventory — the shared source of truth behind
 * `joc models`, the TUI `/provider` command, and `joc doctor`. Reports, for each
 * provider, how it will authenticate (API key / OAuth / keyless / none), its
 * effective base URL, and whether it is ready to serve a request.
 */
import { readGlobalConfig, type Config } from "../agent/state";
import { resolveCredential, type AuthProvider } from "../auth";
import { OAUTH_FLOW_REGISTRY } from "../auth/flows";
import type { ProviderName } from "./types";

export const PROVIDER_NAMES: readonly ProviderName[] = ["anthropic", "openai", "gemini", "ollama"];

/** Cloud providers that authenticate via API key / OAuth. Ollama is keyless. */
export const CLOUD_PROVIDERS: readonly AuthProvider[] = ["anthropic", "openai", "gemini"];

export type CredentialKind = "api_key" | "oauth" | "keyless" | "none";

export interface ProviderStatus {
  name: ProviderName;
  kind: CredentialKind;
  /** Display label, e.g. "API key", "OAuth", "keyless (local)", "none (run 'joc setup')". */
  label: string;
  /** Effective base URL when relevant (ollama / openai-compatible). */
  baseUrl?: string;
  /** Environment variable that would supply an API key, when applicable. */
  envVar?: string;
  /** True when the provider can serve a request right now. */
  ready: boolean;
}

/** The uppercase `<PROVIDER>_API_KEY` env var name for a cloud provider. */
export function providerEnvVar(name: ProviderName): string | undefined {
  if (name === "ollama") return undefined;
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
      return "none (run 'joc setup' or 'joc auth login')";
  }
}

/** Resolve the status of a single provider. */
export async function describeProvider(name: ProviderName, config?: Config): Promise<ProviderStatus> {
  const cfg = config ?? (await readGlobalConfig());
  if (name === "ollama") {
    const baseUrl = cfg.ollamaBaseUrl ?? "http://localhost:11434";
    return { name, kind: "keyless", label: credentialLabel("keyless"), baseUrl, ready: true };
  }
  const cred = await resolveCredential(name as AuthProvider);
  const kind: CredentialKind = cred.kind === "api_key" ? "api_key" : cred.kind === "oauth" ? "oauth" : "none";
  const baseUrl = name === "openai" ? cfg.openaiBaseUrl : undefined;
  let ready = kind !== "none" || (name === "openai" && !!baseUrl);
  let label = ready && kind === "none" ? "keyless (local base URL)" : credentialLabel(kind);
  if (kind === "oauth") {
    const prov = name as AuthProvider;
    if (OAUTH_FLOW_REGISTRY[prov]?.verifiedEndToEnd === false && !cfg.providers?.[prov]) {
      ready = false;
      label = name === "gemini"
        ? "OAuth — Gemini needs an API key (Cloud Code Assist not served)"
        : "OAuth (API key needed)";
    }
  }
  return {
    name,
    kind,
    label,
    baseUrl,
    envVar: providerEnvVar(name),
    ready,
  };
}

/** Resolve the status of every provider (single config read). */
export async function describeAllProviders(config?: Config): Promise<ProviderStatus[]> {
  const cfg = config ?? (await readGlobalConfig());
  return Promise.all(PROVIDER_NAMES.map(name => describeProvider(name, cfg)));
}
