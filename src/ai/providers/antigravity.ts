import { randomUUID } from "node:crypto";
import type { Credential } from "../../auth";
import type { CallOptions, Message, ProviderAdapter } from "../types";
import { readSse } from "../sse";
import { providerHttpError } from "./errors";
import { serializeToolCalls } from "../../agent/tool-schemas";
import { sanitizeJsonStrings } from "../../util/sanitize-json";
import { geminiThinkingConfig, getGeminiCliHeaders, type GeminiThinkingConfig } from "./gemini";

const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";


/** Anthropic-style thinking budget for Claude served via CCA. gemini's budget fn
 *  returns undefined for claude ids, which left antigravity Claude with NO thinking
 *  requested (the opus "no reasoning" gap). Mirrors anthropic's effort→budget tiers —
 *  minimal/low/medium/high ALL think (gajae parity: reasoning at every level); only an
 *  UNSET effort stays non-thinking. */
function antigravityClaudeThinkingBudget(effort: CallOptions["reasoningEffort"]): number | undefined {
  switch (effort) {
    case "minimal": return 2000;
    case "low": return 4000;
    case "medium": return 10000;
    case "high": return 24000;
    default: return undefined;
  }
}
const ENDPOINTS = [ANTIGRAVITY_DAILY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT] as const;

export function getAntigravityUserAgent(): string {
  const version = process.env.PI_AI_ANTIGRAVITY_VERSION || "1.104.0";
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch === "ia32" ? "386" : process.arch;
  return `antigravity/${version} ${os}/${arch}`;
}

function antigravityModelId(model: string): string {
  return model.replace(/^antigravity\//, "");
}

/** The thinkingConfig actually requested for an Antigravity turn — Claude-via-CCA uses an
 *  Anthropic-style numeric budget, native Gemini goes through geminiThinkingConfig
 *  (gemini-3.x → thinkingLevel enum, 2.5/latest → numeric budget; in-name depth markers
 *  like `-high`/`-low` honoured). Centralised so the request builder and the streaming
 *  start-signal stay in agreement. */
function antigravityThinkingConfig(options: CallOptions): GeminiThinkingConfig | undefined {
  const model = antigravityModelId(options.model);
  if (model.toLowerCase().includes("claude")) {
    const budget = antigravityClaudeThinkingBudget(options.reasoningEffort);
    return budget === undefined ? undefined : { includeThoughts: true, thinkingBudget: budget };
  }
  return geminiThinkingConfig(model, options.reasoningEffort);
}

/** True when this turn requested thinking (a thinkingLevel or a positive budget). */
function antigravityThinkingActive(options: CallOptions): boolean {
  const cfg = antigravityThinkingConfig(options);
  return cfg !== undefined && ("thinkingLevel" in cfg || cfg.thinkingBudget > 0);
}

function projectIdFor(credential: Credential): string | undefined {
  if (credential.kind === "oauth" && credential.projectId) return credential.projectId;
  return process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || undefined;
}

// In-process cache of lazily discovered project ids, keyed by access token so a
// rotated token re-discovers. Persisted to the stored gemini OAuth record too,
// so the next process start skips discovery entirely.
const discoveredProjects = new Map<string, string>();

export interface ResolveProjectOptions {
  discover?: (accessToken: string) => Promise<string>;
  persist?: (projectId: string) => Promise<void>;
  /** Turn abort — threaded into discovery fetches so a stalled loadCodeAssist
   *  can never hang the first OAuth turn forever (round-5 #2). */
  signal?: AbortSignal;
}

/**
 * Resolve the Cloud Code Assist project id for an Antigravity call:
 * stored credential → env → lazy loadCodeAssist/onboardUser discovery (gjc parity).
 * A discovered id is persisted onto the stored gemini OAuth record so users who
 * logged in before discovery existed are healed without re-login.
 */
export async function resolveAntigravityProjectId(
  credential: Credential,
  opts: ResolveProjectOptions = {},
): Promise<string> {
  if (credential.kind !== "oauth") {
    throw new Error("Antigravity provider requires Google/Gemini CLI OAuth credentials. Run `jeo auth login gemini`.");
  }
  const direct = projectIdFor(credential);
  if (direct) return direct;
  const cached = discoveredProjects.get(credential.token);
  if (cached) return cached;

  const discover = opts.discover ?? (async (token: string) => {
    const { discoverGoogleProjectId, ANTIGRAVITY_DISCOVERY_METADATA } = await import("../../auth/flows/google-project");
    // Antigravity-client tokens discover with ANTIGRAVITY metadata; gemini-cli
    // tokens use the default gemini-cli metadata shape.
    return discoverGoogleProjectId(token, credential.provider === "antigravity"
      ? { metadata: { ...ANTIGRAVITY_DISCOVERY_METADATA }, extraHeaders: { "User-Agent": getAntigravityUserAgent() }, alwaysOnboard: true, signal: opts.signal }
      : { extraHeaders: getGeminiCliHeaders(), signal: opts.signal });
  });
  let projectId: string;
  try {
    projectId = await discover(credential.token);
  } catch (err) {
    throw new Error(
      `Antigravity project auto-discovery failed: ${(err as Error)?.message ?? err}. ` +
      "Set GOOGLE_CLOUD_PROJECT(_ID) or re-run `jeo auth login gemini`.",
    );
  }
  discoveredProjects.set(credential.token, projectId);

  const persist = opts.persist ?? (async (id: string) => {
    const { getStoredOAuth, setOauthCredential } = await import("../../auth/storage");
    const owner = credential.provider === "antigravity" ? "antigravity" : "gemini";
    const stored = await getStoredOAuth(owner);
    if (stored && !stored.projectId) await setOauthCredential(owner, { ...stored, projectId: id });
  });
  try {
    await persist(projectId);
  } catch {
    // Persistence is best-effort; the in-process cache still serves this session.
  }
  return projectId;
}

type CcaPart = { text: string } | { inlineData: { mimeType: string; data: string } };

// Reasoning-artifact replay (signed thinking / thoughtSignature / encrypted reasoning) is
// deliberately OUT OF SCOPE for antigravity: it serves Gemini- and Claude-shaped models over
// the CCA wire (neither the native Anthropic messages nor the public Gemini shape), so it
// captures no artifacts and replays none — Message.toolUse/toolResults/reasoningArtifacts are
// ignored here. The provider-keyed match guard (D3) keeps "anthropic"/"gemini" artifacts from
// ever being re-injected by this adapter, so there is no cross-adapter leakage.
function antigravityContents(messages: Message[]): { role: "user" | "model"; parts: CcaPart[] }[] {
  const contents: { role: "user" | "model"; parts: CcaPart[] }[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const role = m.role === "assistant" ? "model" : "user";
    // Clipboard-pasted images become inlineData parts alongside the text part.
    const parts: CcaPart[] = [
      ...(m.images?.map(img => ({ inlineData: { mimeType: img.mediaType, data: img.data } })) ?? []),
      { text: m.content },
    ];
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role) prev.parts.push(...parts);
    else contents.push({ role, parts });
  }
  return contents;
}

function sessionId(messages: Message[]): string {
  const first = messages.find(m => m.role === "user")?.content ?? `${Date.now()}`;
  let hash = 0n;
  for (const ch of new TextEncoder().encode(first)) hash = (hash * 131n + BigInt(ch)) & ((1n << 63n) - 1n);
  return `-${hash.toString()}`;
}

export function antigravityRequest(messages: Message[], options: CallOptions, credential: Credential, endpoint = ANTIGRAVITY_DAILY_ENDPOINT, projectId?: string): { url: string; headers: Record<string, string>; body: string } {
  if (credential.kind !== "oauth") throw new Error("Antigravity provider requires Google/Gemini CLI OAuth credentials.");
  const project = projectId ?? projectIdFor(credential);
  if (!project) {
    throw new Error(
      "Antigravity needs a Google Cloud projectId and auto-discovery has not run yet. " +
      "Set GOOGLE_CLOUD_PROJECT(_ID) or re-run `jeo auth login gemini`.",
    );
  }
  const model = antigravityModelId(options.model);
  const systemPrompt = options.systemPrompt ?? messages.find(m => m.role === "system")?.content;
  const generationConfig: Record<string, unknown> = {};
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  const isClaude = model.toLowerCase().includes("claude");
  // Upstream Antigravity strips maxOutputTokens for non-Claude models; do the same.
  if (isClaude) generationConfig.maxOutputTokens = options.maxTokens ?? 4000;
  // Apply the thinking config. CCA emits `thought` parts ONLY when thinkingConfig has
  // includeThoughts set. Gemini scales via geminiThinkingConfig (level enum on 3.x,
  // numeric budget otherwise); Claude-via-CCA needs an Anthropic-style budget (gemini's
  // fn returns undefined for claude) PLUS the interleaved-thinking beta header below —
  // without both, antigravity Claude (e.g. opus) never streamed reasoning while native
  // sonnet did.
  const agThinking = antigravityThinkingConfig(options);
  const claudeThinkingOn = isClaude && agThinking !== undefined;
  if (agThinking !== undefined) {
    generationConfig.thinkingConfig = agThinking;
    // Claude (via CCA) enforces max_tokens > thinking.budget_tokens — bump the output cap
    // above the budget (mirrors the native Anthropic provider) or CCA returns HTTP 400.
    if (claudeThinkingOn && "thinkingBudget" in agThinking) {
      generationConfig.maxOutputTokens = Math.max((options.maxTokens ?? 4000), agThinking.thinkingBudget + 1024);
    }
  }

  const request: Record<string, unknown> = {
    contents: antigravityContents(messages),
    sessionId: sessionId(messages),
  };
  if (systemPrompt) request.systemInstruction = { role: "user", parts: [{ text: systemPrompt }] };
  if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;
  if (options.tools?.length) {
    // NATIVE tool-calling: Gemini functionDeclarations through the CCA proxy. AUTO mode
    // keeps prose answers + the `done` tool both reachable.
    request.tools = [{ functionDeclarations: options.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
    request.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  }

  const body = JSON.stringify(sanitizeJsonStrings({
    project,
    model,
    request,
    requestType: "agent",
    userAgent: "antigravity",
    requestId: `agent-${randomUUID()}`,
  }));
  return {
    url: `${endpoint}/v1internal:streamGenerateContent?alt=sse`,
    headers: {
      authorization: `Bearer ${credential.token}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      "User-Agent": getAntigravityUserAgent(),
      // Claude reasoning over CCA requires the Anthropic interleaved-thinking beta (gjc parity).
      ...(claudeThinkingOn ? { "anthropic-beta": "interleaved-thinking-2025-05-14" } : {}),
    },
    body,
  };
}

type CcaUsage = { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
interface CcaChunk {
  response?: {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean; functionCall?: { name?: string; args?: Record<string, unknown> } }[] }; finishReason?: string }[];
    usageMetadata?: CcaUsage;
  };
}
/** When Antigravity (Cloud Code Assist) returns HTTP 200 with no text, surface the
 *  real cause (safety block / RECITATION / etc.) instead of a silent, reason-free
 *  empty response — mirrors gemini.ts's `blockedReason` (same message wording, so
 *  `defaultRetryable`'s "returned no content" transient-empty-200 branch and
 *  `isRefusalError`'s `finishReason=` matcher both apply consistently). */
function finishReasonOf(chunk: CcaChunk): string | undefined {
  const finish = chunk.response?.candidates?.[0]?.finishReason;
  if (finish && finish !== "STOP") return `finishReason=${finish}`;
  return undefined;
}

function textOf(chunk: CcaChunk): string {
  return chunk.response?.candidates?.[0]?.content?.parts?.filter(p => !p.thought).map(p => p.text ?? "").join("") ?? "";
}

/** Native thinking text (`thought` parts) — kept separate so it never pollutes the JSON tool call. */
function thoughtOf(chunk: CcaChunk): string {
  return chunk.response?.candidates?.[0]?.content?.parts?.filter(p => p.thought).map(p => p.text ?? "").join("") ?? "";
}

/** Native Gemini functionCall parts (Cloud Code Assist) → {tool, arguments}. */
function functionCallsOf(chunk: CcaChunk): { tool: string; arguments: Record<string, unknown> }[] {
  const parts = chunk.response?.candidates?.[0]?.content?.parts ?? [];
  const out: { tool: string; arguments: Record<string, unknown> }[] = [];
  for (const p of parts) {
    if (p.functionCall && typeof p.functionCall.name === "string") {
      out.push({ tool: p.functionCall.name, arguments: (p.functionCall.args ?? {}) as Record<string, unknown> });
    }
  }
  return out;
}

async function fetchAntigravity(messages: Message[], options: CallOptions, credential: Credential): Promise<Response> {
  // Resolve the project id up front: stored credential → env → lazy
  // loadCodeAssist/onboardUser discovery (persisted for future sessions).
  const projectId = await resolveAntigravityProjectId(credential, { signal: options.signal });
  let last: Response | undefined;
  for (const endpoint of ENDPOINTS) {
    const { url, headers, body } = antigravityRequest(messages, options, credential, endpoint, projectId);
    const res = await fetch(url, { method: "POST", headers, body, signal: options.signal });
    if (res.ok) return res;
    last = res;
    if (res.status !== 404 && res.status !== 503) break;
  }
  throw await providerHttpError("Antigravity", last!);
}

export const antigravityAdapter: ProviderAdapter = {
  name: "antigravity",
  supportsNativeTools: true,
  async call(messages, options, credential) {
    const response = await fetchAntigravity(messages, options, credential);
    if (!response.body) return "";
    let out = "";
    let usage: CcaUsage | undefined;
    let lastEmptyReason: string | undefined;
    const fnCalls: { tool: string; arguments: Record<string, unknown> }[] = [];
    for await (const data of readSse(response.body)) {
      let chunk: CcaChunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      const thought = thoughtOf(chunk);
      if (thought) options.onReasoning?.(thought);
      const delta = textOf(chunk);
      if (delta) out += delta;
      else lastEmptyReason = finishReasonOf(chunk) ?? lastEmptyReason;
      fnCalls.push(...functionCallsOf(chunk));
      if (chunk.response?.usageMetadata) usage = chunk.response.usageMetadata;
    }
    if (usage) options.onUsage?.({ inputTokens: usage.promptTokenCount, outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0) });
    // Prefer a native tool call (re-serialized to canonical JSON) over any stray text.
    const envelope = serializeToolCalls(fnCalls);
    if (envelope) return envelope;
    if (!out) throw new Error(`Antigravity Cloud Code Assist returned no content${lastEmptyReason ? ` (${lastEmptyReason})` : ""}.`);
    return out;
  },
  async *stream(messages, options, credential) {
    const response = await fetchAntigravity(messages, options, credential);
    if (!response.body) return;
    // Signal the thinking phase up front (parity with anthropic's content_block_start) so the
    // UI shows it even before/without `thought` parts — otherwise reasoning looked dead here.
    if (antigravityThinkingActive(options)) options.onReasoningStart?.();
    let yielded = false;
    let usage: CcaUsage | undefined;
    let lastEmptyReason: string | undefined;
    const fnCalls: { tool: string; arguments: Record<string, unknown> }[] = [];
    for await (const data of readSse(response.body, options.onStreamActivity)) {
      let chunk: CcaChunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      const thought = thoughtOf(chunk);
      if (thought) options.onReasoning?.(thought);
      const delta = textOf(chunk);
      if (delta) { yielded = true; yield delta; }
      else lastEmptyReason = finishReasonOf(chunk) ?? lastEmptyReason;
      fnCalls.push(...functionCallsOf(chunk));
      if (chunk.response?.usageMetadata) usage = chunk.response.usageMetadata;
    }
    if (usage) options.onUsage?.({ inputTokens: usage.promptTokenCount, outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0) });
    // Native tool calls have no text deltas — yield the re-serialized envelope once at end.
    const envelope = serializeToolCalls(fnCalls);
    if (envelope) { yielded = true; yield envelope; }
    if (!yielded) throw new Error(`Antigravity Cloud Code Assist returned no content${lastEmptyReason ? ` (${lastEmptyReason})` : ""}.`);
  },
};
