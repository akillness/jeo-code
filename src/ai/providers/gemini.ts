import type { Credential } from "../../auth";
import type { CallOptions, Message, ProviderAdapter } from "../types";
import { readSse } from "../sse";
import { providerHttpError, fetchWithArtifactFailSafe } from "./errors";
import { jeoEnv } from "../../util/env";
import { serializeToolCalls } from "../../agent/tool-schemas";

/** Gemini 2.5+/latest models think by default and BILL thought tokens against
 *  `maxOutputTokens` — a small-budget call can burn its entire budget on thoughts
 *  and return MAX_TOKENS with zero text (observed live on `gemini-flash-latest`).
 *  Pin an explicit budget: off unless reasoning was requested. Pro-class models
 *  cannot disable thinking (API minimum 128), so they keep a floor instead of 0.
 *  Older models (1.5/2.0) reject `thinkingConfig` entirely → undefined (omit). */
export function geminiThinkingBudget(model: string, effort?: CallOptions["reasoningEffort"], maxTokens?: number): number | undefined {
  const m = model.toLowerCase();
  // Reasoning-capable when Gemini >= 2.5 (any 2.5+ minor) or major >= 3 (digit-count
  // agnostic so gemini-10+ never silently loses thinking the way opus-4-8 did), plus
  // the rolling *-latest aliases. Mirrors `inferCatalogMetadata` in model-catalog.ts.
  const ver = m.match(/gemini-(\d+)(?:\.(\d+))?/);
  const major = ver ? Number(ver[1]) : 0;
  const minor = ver ? Number(ver[2] ?? 0) : 0;
  const thinkingCapable = (major >= 3 || (major === 2 && minor >= 5)) || /flash-latest|pro-latest/.test(m);
  if (!thinkingCapable) return undefined;
  const floor = m.includes("pro") ? 128 : 0; // pro-class cannot fully disable thinking
  // An UNSET effort normally falls to the floor (off for flash-class). But when the model
  // VARIANT name itself encodes a thinking depth — `-high`/`-low` (e.g. gemini-3-pro-high)
  // or an explicit `-thinking` suffix (gemini-2.5-flash-thinking) — that selection IS the
  // user's thinking opt-in, so it overrides the silent floor and maps to a real budget.
  // Unmarked ids (gemini-3-flash, gemini-2.5-flash) keep the off-by-default floor (parity
  // with the other providers + the documented thought-token burn protection).
  const named: CallOptions["reasoningEffort"] | undefined =
    m.includes("-high") ? "high"
    : m.includes("-low") ? "low"
    : m.includes("thinking") ? "medium"
    : undefined;
  const effectiveEffort = effort ?? named;
  let budget: number;
  switch (effectiveEffort) {
    // minimal/low/medium/high ALL enable thinking with scaling depth — reasoning works at
    // every thinking level (gajae parity: Minimal is a real effort). Only an UNSET effort
    // (and no in-name depth marker) falls through to the floor.
    case "minimal": budget = Math.max(floor, 2000); break;
    case "low": budget = 4000; break;
    case "medium": budget = 10000; break;
    case "high": budget = 24000; break;
    default: budget = floor;
  }
  if (typeof maxTokens === "number") budget = Math.min(budget, Math.max(floor, maxTokens - 1024));
  return budget;
}

/** True when this turn was asked to think (a positive budget) — lets the streaming paths
 *  fire onReasoningStart so the UI shows the thinking phase even before/without any `thought`
 *  parts arrive (the Gemini/CCA analog of Anthropic's content_block_start thinking signal,
 *  which is why reasoning otherwise appeared "not to run" on gemini/antigravity). */
export function geminiThinkingActive(options: CallOptions): boolean {
  const model = options.model.replace(/^(google|gemini)\//, "");
  const tb = geminiThinkingBudget(model, options.reasoningEffort, options.maxTokens);
  return tb !== undefined && tb > 0;
}


/** True when an assistant turn can replay native functionCall + thoughtSignature: it has
 *  structured toolUse AND a same-model Gemini thoughtSignature artifact, AND thinking is on. */
export function geminiNativizable(m: Message, modelKey: string, thinkingEnabled: boolean): boolean {
  return thinkingEnabled
    && !!m.toolUse?.length
    && !!m.reasoningArtifacts?.some(a => a.provider === "gemini" && a.model === modelKey && !!a.thoughtSignature);
}
/** Shared Gemini request payload (contents + generationConfig + systemInstruction)
 *  used by BOTH the public generativelanguage path (API key) and the Cloud Code
 *  Assist path (OAuth) — only the envelope/endpoint differs. */
export function buildGeminiPayload(messages: Message[], options: CallOptions, stripArtifacts = false): { geminiModel: string; payload: Record<string, unknown> } {
  const resolvedModel = options.model.replace(/^(google|gemini)\//, "");
  let geminiModel = resolvedModel;
  if (!geminiModel || geminiModel.startsWith("claude-")) geminiModel = "gemini-2.0-flash";

  const systemPrompt = options.systemPrompt ?? messages.find(m => m.role === "system")?.content;
  const thinkingBudget = geminiThinkingBudget(geminiModel, options.reasoningEffort, options.maxTokens);
  const thinkingEnabled = thinkingBudget !== undefined && !stripArtifacts;
  // Gemini requires strictly ALTERNATING user/model turns. jeo histories can carry
  // consecutive same-role messages (a compaction summary prepended before a tool-result,
  // back-to-back tool results, etc.), so coalesce adjacent same-role turns into one
  // content block — otherwise the API rejects the request mid-session. Native
  // functionCall/functionResponse parts (with thoughtSignature) are reconstructed for
  // same-model turns to preserve cross-step thought context; else plain text.
  type GeminiPart = Record<string, unknown>;
  const nonSystem = messages.filter(m => m.role !== "system");
  const contents: { role: string; parts: GeminiPart[] }[] = [];
  nonSystem.forEach((m, i) => {
    const role = m.role === "assistant" ? "model" : "user";
    let parts: GeminiPart[];
    if (m.role === "assistant" && geminiNativizable(m, options.model, thinkingEnabled)) {
      const sig = m.reasoningArtifacts!.find(a => a.provider === "gemini" && a.model === options.model && a.thoughtSignature)?.thoughtSignature;
      parts = m.toolUse!.map((tu, idx) => {
        const p: GeminiPart = { functionCall: { name: tu.tool, args: tu.arguments } };
        if (idx === 0 && sig) p.thoughtSignature = sig; // bind the turn signature to the first call
        return p;
      });
    } else if (m.role === "user" && m.toolResults?.length && i > 0
        && nonSystem[i - 1].role === "assistant"
        && geminiNativizable(nonSystem[i - 1], options.model, thinkingEnabled)) {
      const prevToolUse = nonSystem[i - 1].toolUse ?? [];
      parts = m.toolResults.map(tr => ({
        functionResponse: { name: prevToolUse.find(tu => tu.id === tr.id)?.tool ?? "tool", response: { output: tr.output } },
      }));
      if (m.toolResultExtra) parts.push({ text: m.toolResultExtra });
    } else {
      parts = [
        ...(m.images?.map(img => ({ inlineData: { mimeType: img.mediaType, data: img.data } })) ?? []),
        { text: m.content },
      ];
    }
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role) prev.parts.push(...parts);
    else contents.push({ role, parts });
  });

  const generationConfig: Record<string, unknown> = {
    temperature: options.temperature ?? 0.2,
    maxOutputTokens: options.maxTokens ?? 4000,
  };
  // Function-calling and responseMimeType:json are mutually exclusive in the Gemini
  // API — when native tools are declared, the functionCall parts replace JSON-in-prose.
  if (options.jsonMode && !options.tools?.length) generationConfig.responseMimeType = "application/json";

  // includeThoughts: required for Gemini to STREAM thought summaries (the `thought:true`
  // parts thoughtOf() routes to onReasoning) — without it the model thinks silently.
  if (thinkingBudget !== undefined) generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget };

  const payload: Record<string, unknown> = { contents, generationConfig };
  if (systemPrompt) payload.systemInstruction = { parts: [{ text: systemPrompt }] };
  if (options.tools?.length) {
    // NATIVE function-calling (gjc/antigravity parity): declare the toolset so the
    // model emits functionCall parts instead of hand-formatting the JSON tool protocol
    // (which weaker models mangle — wasted steps + apology prose leaking into replies).
    payload.tools = [{ functionDeclarations: options.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
    payload.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  }
  return { geminiModel, payload };
}

export function geminiRequest(messages: Message[], options: CallOptions, credential: Credential, action: "generateContent" | "streamGenerateContent", stripArtifacts = false): { url: string; headers: Record<string, string>; body: string } {
  const { geminiModel, payload } = buildGeminiPayload(messages, options, stripArtifacts);
  const oauth = credential.kind === "oauth" ? credential.token : undefined;
  const apiKey = credential.kind === "api_key" ? credential.token : undefined;
  let url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:${action}`;
  const query = action === "streamGenerateContent" ? "alt=sse" : "";
  if (!oauth) url += `?${query ? query + "&" : ""}key=${encodeURIComponent(apiKey ?? "")}`;
  else if (query) url += `?${query}`;
  const headers: Record<string, string> = oauth
    ? { "content-type": "application/json", authorization: `Bearer ${oauth}` }
    : { "content-type": "application/json" };
  return { url, headers, body: JSON.stringify(payload) };
}

const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";

/** gemini-cli identification headers Cloud Code Assist expects (gjc parity). */
export function getGeminiCliHeaders(modelId?: string): Record<string, string> {
  const version = jeoEnv("GEMINI_CLI_VERSION") || "0.45.2";
  return {
    "User-Agent": `GeminiCLI/${version}/${modelId ?? "gemini-2.5-flash"} (${process.platform}; ${process.arch}; terminal)`,
    "Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
  };
}

/**
 * Cloud Code Assist request for a Google OAuth (gemini-cli) credential — the
 * gemini-cli/gjc call path. OAuth tokens carry cloud-platform scope and target
 * cloudcode-pa.googleapis.com, NOT the public generativelanguage API, so a
 * plain `jeo auth login gemini` works without any GEMINI_API_KEY. The body
 * wraps the standard payload as `{ project, model, request }`.
 */
export function geminiCliRequest(messages: Message[], options: CallOptions, accessToken: string, projectId: string, stripArtifacts = false): { url: string; headers: Record<string, string>; body: string } {
  const { geminiModel, payload } = buildGeminiPayload(messages, options, stripArtifacts);
  return {
    url: `${CODE_ASSIST_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      ...getGeminiCliHeaders(geminiModel),
    },
    body: JSON.stringify({ project: projectId, model: geminiModel, request: payload }),
  };
}

/** POST a Gemini request with a reasoning-artifact fail-safe (see fetchWithArtifactFailSafe). */
function geminiFetchFailSafe(
  make: (stripArtifacts: boolean) => { url: string; headers: Record<string, string>; body: string },
  signal?: AbortSignal,
): Promise<Response> {
  return fetchWithArtifactFailSafe(
    strip => {
      const r = make(strip);
      return fetch(r.url, { method: "POST", headers: r.headers, body: r.body, signal });
    },
    (status, body) => status === 400 && /thoughtsignature|thought_signature|functioncall|function_call|signature/i.test(body),
  );
}

interface GeminiChunk {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { name?: string; args?: Record<string, unknown> } }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

/** Cloud Code Assist wraps each standard chunk under `response`. */
interface CcaChunk {
  response?: GeminiChunk;
}

function textOf(chunk: GeminiChunk): string {
  return chunk.candidates?.[0]?.content?.parts?.filter(p => !p.thought).map(p => p.text ?? "").join("") ?? "";
}

/** Native thinking text (`thought` parts), present only when the model emits thought
 *  summaries. Kept SEPARATE from textOf so thoughts never pollute the JSON tool call. */
function thoughtOf(chunk: GeminiChunk): string {
  return chunk.candidates?.[0]?.content?.parts?.filter(p => p.thought).map(p => p.text ?? "").join("") ?? "";
}

/** Emit each NEW thoughtSignature seen on this chunk's parts as a replay artifact (Gemini
 *  binds it to the functionCall part — replayed to keep cross-step thought context). `seen`
 *  dedups across the streamed chunks of one turn. */
function captureGeminiSignatures(chunk: GeminiChunk, options: CallOptions, seen: Set<string>): void {
  for (const p of chunk.candidates?.[0]?.content?.parts ?? []) {
    const sig = p.thoughtSignature;
    if (sig && !seen.has(sig)) {
      seen.add(sig);
      options.onReasoningArtifact?.({ provider: "gemini", model: options.model, thoughtSignature: sig });
    }
  }
}
/** Native Gemini functionCall parts → {tool, arguments} (gjc/antigravity parity). Kept
 *  separate from textOf so the re-serialized canonical JSON envelope drives the loop. */
function geminiFunctionCallsOf(chunk: GeminiChunk): { tool: string; arguments: Record<string, unknown> }[] {
  const parts = chunk.candidates?.[0]?.content?.parts ?? [];
  const out: { tool: string; arguments: Record<string, unknown> }[] = [];
  for (const p of parts) {
    if (p.functionCall && typeof p.functionCall.name === "string") {
      out.push({ tool: p.functionCall.name, arguments: (p.functionCall.args ?? {}) as Record<string, unknown> });
    }
  }
  return out;
}

/** When Gemini returns HTTP 200 with no text, surface the real cause (safety block /
 *  RECITATION / MAX_TOKENS) instead of a silent empty string that downstream JSON
 *  parsing would misreport as "couldn't parse tool call". */
function blockedReason(chunk: GeminiChunk): string | undefined {
  const block = chunk.promptFeedback?.blockReason;
  if (block) return `blockReason=${block}`;
  const finish = chunk.candidates?.[0]?.finishReason;
  if (finish === "MAX_TOKENS") {
    // Only reached when NO text was produced at all (both call/stream paths guard
    // on emptiness): the output budget was consumed before any visible text —
    // typically thinking tokens on a 2.5+/latest model.
    return "finishReason=MAX_TOKENS — output budget exhausted before any text; raise maxTokens or lower the thinking level";
  }
  if (finish && finish !== "STOP") return `finishReason=${finish}`;
  return undefined;
}

/**
 * Cloud Code Assist SSE turn for a Google OAuth credential: resolves the
 * projectId (stored → env → lazy loadCodeAssist/onboardUser discovery), POSTs
 * the gemini-cli request, and yields text deltas. Usage is reported ONCE after
 * the stream (thought tokens count as output, gjc parity). Shared by both
 * `call` (concatenates) and `stream` (yields through).
 */
async function* ccaTurn(messages: Message[], options: CallOptions, credential: Credential & { kind: "oauth" }): AsyncGenerator<string> {
  const { resolveAntigravityProjectId } = await import("./antigravity");
  const projectId = await resolveAntigravityProjectId(credential, { signal: options.signal });
  const response = await geminiFetchFailSafe(strip => geminiCliRequest(messages, options, credential.token, projectId, strip), options.signal);
  if (!response.ok) throw await providerHttpError("Gemini (Cloud Code Assist)", response);
  if (!response.body) return;
  if (geminiThinkingActive(options)) options.onReasoningStart?.();
  let lastUsage: GeminiChunk["usageMetadata"];
  let yieldedAny = false;
  let lastEmptyReason: string | undefined;
  const fnCalls: { tool: string; arguments: Record<string, unknown> }[] = [];
  const seenSigs = new Set<string>();
  for await (const data of readSse(response.body, options.onStreamActivity)) {
    let chunk: CcaChunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    const inner = chunk.response;
    if (!inner) continue;
    const thought = thoughtOf(inner);
    if (thought) options.onReasoning?.(thought);
    captureGeminiSignatures(inner, options, seenSigs);
    const delta = textOf(inner);
    if (delta) {
      yieldedAny = true;
      yield delta;
    } else {
      lastEmptyReason = blockedReason(inner) ?? lastEmptyReason;
    }
    if (inner.usageMetadata) lastUsage = inner.usageMetadata;
    fnCalls.push(...geminiFunctionCallsOf(inner));
  }
  const envelope = serializeToolCalls(fnCalls);
  if (envelope) { yieldedAny = true; yield envelope; }
  if (!yieldedAny) {
    throw new Error(`Gemini (Cloud Code Assist) returned no content${lastEmptyReason ? ` (${lastEmptyReason})` : ""}.`);
  }
  if (lastUsage) {
    options.onUsage?.({
      inputTokens: lastUsage.promptTokenCount,
      outputTokens: (lastUsage.candidatesTokenCount ?? 0) + (lastUsage.thoughtsTokenCount ?? 0),
    });
  }
}

export const geminiAdapter: ProviderAdapter = {
  name: "gemini",
  supportsNativeTools: true,
  async call(messages, options, credential) {
    // OAuth (gemini-cli login) → Cloud Code Assist; no GEMINI_API_KEY required.
    if (credential.kind === "oauth") {
      let out = "";
      for await (const delta of ccaTurn(messages, options, credential)) out += delta;
      return out;
    }
    const response = await geminiFetchFailSafe(strip => geminiRequest(messages, options, credential, "generateContent", strip), options.signal);
    if (!response.ok) throw await providerHttpError("Gemini", response);
    const result = (await response.json()) as GeminiChunk;
    captureGeminiSignatures(result, options, new Set());
    if (result.usageMetadata) {
      options.onUsage?.({ inputTokens: result.usageMetadata.promptTokenCount, outputTokens: result.usageMetadata.candidatesTokenCount });
    }
    const envelope = serializeToolCalls(geminiFunctionCallsOf(result));
    if (envelope) return envelope;
    const text = textOf(result);
    if (!text) {
      const reason = blockedReason(result);
      if (reason) throw new Error(`Gemini returned no content (${reason}).`);
    }
    return text;
  },
  async *stream(messages, options, credential) {
    // OAuth (gemini-cli login) → Cloud Code Assist; no GEMINI_API_KEY required.
    if (credential.kind === "oauth") {
      yield* ccaTurn(messages, options, credential);
      return;
    }
    const response = await geminiFetchFailSafe(strip => geminiRequest(messages, options, credential, "streamGenerateContent", strip), options.signal);
    if (!response.ok) throw await providerHttpError("Gemini", response, "(stream)");
    if (!response.body) return;
    if (geminiThinkingActive(options)) options.onReasoningStart?.();
    let lastUsage: GeminiChunk["usageMetadata"];
    let yieldedAny = false;
    let lastEmptyReason: string | undefined;
    const fnCalls: { tool: string; arguments: Record<string, unknown> }[] = [];
    const seenSigs = new Set<string>();
    for await (const data of readSse(response.body, options.onStreamActivity)) {
      let chunk: GeminiChunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const thought = thoughtOf(chunk);
      if (thought) options.onReasoning?.(thought);
      captureGeminiSignatures(chunk, options, seenSigs);
      const delta = textOf(chunk);
      if (delta) {
        yieldedAny = true;
        yield delta;
      } else {
        lastEmptyReason = blockedReason(chunk) ?? lastEmptyReason;
      }
      // Gemini emits cumulative usageMetadata on most chunks; capture the last and
      // report ONCE after the stream so an accumulating sink can't over-count.
      if (chunk.usageMetadata) lastUsage = chunk.usageMetadata;
      fnCalls.push(...geminiFunctionCallsOf(chunk));
    }
    const envelope = serializeToolCalls(fnCalls);
    if (envelope) { yieldedAny = true; yield envelope; }
    if (!yieldedAny && lastEmptyReason) {
      throw new Error(`Gemini returned no content (${lastEmptyReason}).`);
    }
    if (lastUsage) {
      options.onUsage?.({ inputTokens: lastUsage.promptTokenCount, outputTokens: lastUsage.candidatesTokenCount });
    }
  },
};
