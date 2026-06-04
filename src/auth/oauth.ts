import type { AuthProvider } from "./storage";
import { setOauthToken, clearOauthToken, setOauthCredential } from "./storage";
import { OAUTH_FLOW_REGISTRY } from "./flows";
import type { OAuthController } from "./types";

export interface OauthFlowDef {
  label: string;
  authorizeUrl: string;
  instructions: string[];
}

/** Metadata kept for help text / manual-paste fallback. */
export const OAUTH_FLOWS: Record<AuthProvider, OauthFlowDef> = {
  anthropic: {
    label: "Anthropic Console (Claude)",
    authorizeUrl: "https://claude.ai/oauth/authorize",
    instructions: [
      "Real PKCE OAuth: a browser tab opens at claude.ai and a local callback",
      "server on http://localhost:54545/callback receives the code automatically.",
      "If the browser cannot reach this machine, paste the redirect URL / code when prompted.",
    ],
  },
  openai: {
    label: "OpenAI (ChatGPT/Codex)",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    instructions: [
      "Real PKCE OAuth via auth.openai.com with a fixed callback on localhost:1455.",
      "Note: the minted token targets the ChatGPT/Codex backend, not the Chat Completions API.",
    ],
  },
  gemini: {
    label: "Google (Gemini CLI)",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    instructions: [
      "Real Google OAuth (authorization-code) with a callback on localhost:8085.",
      "Note: the minted token targets Cloud Code Assist; the public Gemini API prefers an API key.",
    ],
  },
};

export async function openInBrowser(url: string): Promise<void> {
  try {
    const cmd =
      process.platform === "darwin" ? ["open", url] :
      process.platform === "win32" ? ["cmd", "/c", "start", "", url] :
      ["xdg-open", url];
    const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
  } catch {
    // ignore — the URL is printed for manual opening
  }
}

/**
 * Run the real interactive OAuth flow for a provider: open the browser, spin up
 * the local callback server, wait for the code (or manual paste), exchange it,
 * and persist the full credential set (access + refresh + expiry).
 */
export async function interactiveLogin(provider: AuthProvider, ctrl: OAuthController): Promise<{ email?: string }> {
  const flow = OAUTH_FLOW_REGISTRY[provider];
  const creds = await flow.login(ctrl);
  await setOauthCredential(provider, {
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
    accountId: creds.accountId,
    email: creds.email,
    projectId: creds.projectId,
  });
  return { email: creds.email };
}

/** Non-interactive entry: stash a pre-acquired bearer (no refresh metadata). */
export async function loginOAuth(provider: AuthProvider, token: string): Promise<void> {
  await setOauthToken(provider, token);
}

export async function logoutOAuth(provider: AuthProvider): Promise<boolean> {
  return clearOauthToken(provider);
}
