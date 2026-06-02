import type { AuthProvider } from "./storage";
import { setOauthToken, clearOauthToken } from "./storage";

export interface OauthFlowDef {
  label: string;
  authorizeUrl: string;
  instructions: string[];
}

export const OAUTH_FLOWS: Record<AuthProvider, OauthFlowDef> = {
  anthropic: {
    label: "Anthropic Console (Claude)",
    authorizeUrl: "https://console.anthropic.com/oauth/authorize",
    instructions: [
      "1) Open https://console.anthropic.com/settings/keys",
      "2) Create an OAuth token (or use a Claude Code session token from",
      "   https://claude.ai/settings — Manage API Keys → 'Use with Claude Code').",
      "3) Paste the bearer token below. It will be saved to ~/.joc/config.json with chmod 600.",
      "   The loop sends it as `Authorization: Bearer <token>` with anthropic-beta: oauth-2025-04-20.",
    ],
  },
  openai: {
    label: "OpenAI Platform",
    authorizeUrl: "https://platform.openai.com/api-keys",
    instructions: [
      "1) Open https://platform.openai.com/api-keys (or https://chatgpt.com/api/auth/session for OAuth).",
      "2) Create a session/bearer token. For ChatGPT-Plus OAuth, copy the access_token from the session JSON.",
      "3) Paste the bearer token below.",
    ],
  },
  gemini: {
    label: "Google AI Studio (Gemini)",
    authorizeUrl: "https://aistudio.google.com/app/apikey",
    instructions: [
      "1) Open https://aistudio.google.com/app/apikey",
      "2) Use 'gcloud auth print-access-token' for OAuth, or create a service-account bearer.",
      "3) Paste the access token below (it will be sent as Authorization: Bearer ...).",
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
    // ignore — user can copy/paste the URL manually
  }
}

/** Non-interactive entry: stash a pre-acquired token. */
export async function loginOAuth(provider: AuthProvider, token: string): Promise<void> {
  await setOauthToken(provider, token);
}

export async function logoutOAuth(provider: AuthProvider): Promise<boolean> {
  return await clearOauthToken(provider);
}
