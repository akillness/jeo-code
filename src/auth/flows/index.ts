/** Per-provider OAuth login + refresh dispatch. */
import type { AuthProvider, OAuthProvider } from "../storage";
import type { OAuthController, OAuthCredentials } from "../types";
import { loginAnthropic, refreshAnthropicToken } from "./anthropic";
import { loginOpenAI, refreshOpenAIToken } from "./openai";
import { loginGoogle, refreshGoogleToken } from "./google";
import { loginAntigravity, refreshAntigravityToken } from "./antigravity";
import { loginKimi, refreshKimiToken } from "./kimi";

export interface OAuthFlow {
  readonly provider: OAuthProvider;
  readonly label: string;
  /** Run the interactive browser/PKCE login. */
  login(ctrl: OAuthController): Promise<OAuthCredentials>;
  /** Exchange a refresh token for a fresh access token. */
  refresh(refreshToken: string): Promise<OAuthCredentials>;
  /** Whether the minted token works with jeo's bundled adapter end-to-end. */
  readonly verifiedEndToEnd: boolean;
  /** Human note about adapter compatibility. */
  readonly note?: string;
}

export const OAUTH_FLOW_REGISTRY: Record<OAuthProvider, OAuthFlow> = {
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
    verifiedEndToEnd: true,
    note: "Served via the Cloud Code Assist backend (cloudcode-pa.googleapis.com) with an auto-discovered project — gemini-cli parity, no API key needed. A GEMINI_API_KEY, when set, takes precedence and uses the public generativelanguage API.",
  },
  antigravity: {
    provider: "antigravity",
    label: "Google Antigravity (Cloud Code Assist agent)",
    login: loginAntigravity,
    refresh: refreshAntigravityToken,
    verifiedEndToEnd: true,
    note: "Antigravity desktop-app OAuth client; serves antigravity/* models (Gemini 3, Claude, GPT-OSS via Cloud Code Assist). The Google Cloud projectId is discovered automatically at login.",
  },
  kimi: {
    provider: "kimi",
    label: "Kimi Code (Moonshot subscription)",
    login: loginKimi,
    refresh: refreshKimiToken,
    verifiedEndToEnd: true,
    note: "Device-code OAuth (auth.kimi.com); the token is served via the Anthropic-compatible endpoint at api.kimi.com/coding. A KIMI_API_KEY, when set and no OAuth is stored, uses the OpenAI-compatible api.moonshot.ai/v1.",
  },
};

export { loginAnthropic, refreshAnthropicToken } from "./anthropic";
export { loginOpenAI, refreshOpenAIToken } from "./openai";
export { loginGoogle, refreshGoogleToken } from "./google";
export { loginAntigravity, refreshAntigravityToken, discoverAntigravityProjectId, antigravityClientSecret } from "./antigravity";
export { loginKimi, refreshKimiToken, getKimiCommonHeaders } from "./kimi";
