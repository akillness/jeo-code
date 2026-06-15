import { randomUUID } from "node:crypto";
import type { Credential } from "../../auth";
import type { CallOptions, Message, ProviderAdapter } from "../types";
import { readSse } from "../sse";
import { providerHttpError } from "./errors";
import { serializeToolCalls } from "../../agent/tool-schemas";

const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
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
      ? { metadata: { ...ANTIGRAVITY_DISCOVERY_METADATA }, extraHeaders: { "User-Agent": getAntigravityUserAgent() }, signal: opts.signal }
      : { signal: opts.signal });
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
  // Upstream Antigravity strips maxOutputTokens for non-Claude models; do the same.
  if (model.toLowerCase().includes("claude")) generationConfig.maxOutputTokens = options.maxTokens ?? 4000;

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

  const body = JSON.stringify({
    project,
    model,
    request,
    requestType: "agent",
    userAgent: "antigravity",
    requestId: `agent-${randomUUID()}`,
  });
  return {
    url: `${endpoint}/v1internal:streamGenerateContent?alt=sse`,
    headers: {
      authorization: `Bearer ${credential.token}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      "User-Agent": getAntigravityUserAgent(),
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
    const fnCalls: { tool: string; arguments: Record<string, unknown> }[] = [];
    for await (const data of readSse(response.body)) {
      let chunk: CcaChunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      const thought = thoughtOf(chunk);
      if (thought) options.onReasoning?.(thought);
      out += textOf(chunk);
      fnCalls.push(...functionCallsOf(chunk));
      if (chunk.response?.usageMetadata) usage = chunk.response.usageMetadata;
    }
    if (usage) options.onUsage?.({ inputTokens: usage.promptTokenCount, outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0) });
    // Prefer a native tool call (re-serialized to canonical JSON) over any stray text.
    const envelope = serializeToolCalls(fnCalls);
    if (envelope) return envelope;
    if (!out) throw new Error("Antigravity Cloud Code Assist returned an empty response.");
    return out;
  },
  async *stream(messages, options, credential) {
    const response = await fetchAntigravity(messages, options, credential);
    if (!response.body) return;
    let yielded = false;
    let usage: CcaUsage | undefined;
    const fnCalls: { tool: string; arguments: Record<string, unknown> }[] = [];
    for await (const data of readSse(response.body)) {
      let chunk: CcaChunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      const thought = thoughtOf(chunk);
      if (thought) options.onReasoning?.(thought);
      const delta = textOf(chunk);
      if (delta) { yielded = true; yield delta; }
      fnCalls.push(...functionCallsOf(chunk));
      if (chunk.response?.usageMetadata) usage = chunk.response.usageMetadata;
    }
    if (usage) options.onUsage?.({ inputTokens: usage.promptTokenCount, outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0) });
    // Native tool calls have no text deltas — yield the re-serialized envelope once at end.
    const envelope = serializeToolCalls(fnCalls);
    if (envelope) { yielded = true; yield envelope; }
    if (!yielded) throw new Error("Antigravity Cloud Code Assist returned an empty response.");
  },
};
