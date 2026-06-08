/** Per-provider OAuth login + refresh dispatch. */
import type { AuthProvider } from "../storage";
import type { OAuthController, OAuthCredentials } from "../types";
import { loginAnthropic, refreshAnthropicToken } from "./anthropic";
import { loginOpenAI, refreshOpenAIToken } from "./openai";
import { loginGoogle, refreshGoogleToken } from "./google";

export interface OAuthFlow {
  readonly provider: AuthProvider;
  readonly label: string;
  /** Run the interactive browser/PKCE login. */
  login(ctrl: OAuthController): Promise<OAuthCredentials>;
  /** Exchange a refresh token for a fresh access token. */
  refresh(refreshToken: string): Promise<OAuthCredentials>;
  /** Whether the minted token works with joc's bundled adapter end-to-end. */
  readonly verifiedEndToEnd: boolean;
  /** Human note about adapter compatibility. */
  readonly note?: string;
}

export const OAUTH_FLOW_REGISTRY: Record<AuthProvider, OAuthFlow> = {
  anthropic: {
    provider: "anthropic",
    label: "Anthropic (Claude Pro/Max)",
    login: loginAnthropic,
    refresh: refreshAnthropicToken,
    verifiedEndToEnd: true,
    note: "Works directly with the bundled Anthropic Messages adapter.",
  },
  openai: {
    provider: "openai",
    label: "OpenAI (ChatGPT/Codex)",
    login: loginOpenAI,
    refresh: refreshOpenAIToken,
    verifiedEndToEnd: true,
    note: "ChatGPT/Codex OAuth served via the Codex Responses backend (chatgpt.com/backend-api/codex/responses). An OPENAI_API_KEY, when set, takes precedence and uses api.openai.com.",
  },
  gemini: {
    provider: "gemini",
    label: "Google (Gemini CLI / Cloud Code Assist)",
    login: loginGoogle,
    refresh: refreshGoogleToken,
    verifiedEndToEnd: false,
    note: "Token targets Cloud Code Assist; the bundled generativelanguage adapter prefers GEMINI_API_KEY.",
  },
};

export { loginAnthropic, refreshAnthropicToken } from "./anthropic";
export { loginOpenAI, refreshOpenAIToken } from "./openai";
export { loginGoogle, refreshGoogleToken } from "./google";
