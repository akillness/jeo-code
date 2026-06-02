import { readGlobalConfig, saveGlobalConfig, type Config } from "../agent/state";

export type AuthProvider = "anthropic" | "openai" | "gemini";

export type Credential =
  | { kind: "oauth"; provider: AuthProvider; token: string }
  | { kind: "api_key"; provider: AuthProvider; token: string }
  | { kind: "none"; provider: AuthProvider };

export interface AuthSnapshot {
  apiKey: string | undefined;
  oauth: string | undefined;
}

/** Single point of resolution: OAuth bearer beats API key when both exist. */
export async function resolveCredential(provider: AuthProvider): Promise<Credential> {
  const cfg = await readGlobalConfig();
  const oauth = cfg.oauth?.[provider];
  if (oauth) return { kind: "oauth", provider, token: oauth };
  const apiKey = cfg.providers[provider];
  if (apiKey) return { kind: "api_key", provider, token: apiKey };
  return { kind: "none", provider };
}

export async function snapshotProvider(provider: AuthProvider): Promise<AuthSnapshot> {
  const cfg = await readGlobalConfig();
  return { apiKey: cfg.providers[provider], oauth: cfg.oauth?.[provider] };
}

export async function setOauthToken(provider: AuthProvider, token: string): Promise<void> {
  const cfg = await readGlobalConfig();
  const next: Config = JSON.parse(JSON.stringify(cfg));
  next.oauth = next.oauth ?? {};
  next.oauth[provider] = token;
  await saveGlobalConfig(next);
}

export async function clearOauthToken(provider: AuthProvider): Promise<boolean> {
  const cfg = await readGlobalConfig();
  if (!cfg.oauth?.[provider]) return false;
  delete cfg.oauth[provider];
  await saveGlobalConfig(cfg);
  return true;
}

export async function setApiKey(provider: AuthProvider, key: string): Promise<void> {
  const cfg = await readGlobalConfig();
  const next: Config = JSON.parse(JSON.stringify(cfg));
  next.providers[provider] = key;
  await saveGlobalConfig(next);
}
