import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Credential } from "../../auth";
import type { CallOptions, Message, ProviderAdapter } from "../types";
import { readSse } from "../sse";
import { ProviderHttpError, parseRetryAfter, parseRetryFromBody, providerHttpError } from "./errors";
import { serializeToolCalls, serializeAccumulatedToolCalls } from "../../agent/tool-schemas";
import { sanitizeJsonStrings } from "../../util/sanitize-json";
import { jeoEnv } from "../../util/env";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const DEPRECATED_TEMPERATURE = "`temperature` is deprecated for this model.";
const CLAUDE_CODE_VERSION = "2.1.63";
const CLAUDE_CODE_SYSTEM_INSTRUCTION = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const CLAUDE_BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";
/** Betas needed for API-key requests: interleaved-thinking enables thinking+tools,
 *  context-management matches gjc's default beta set (sent on ALL requests),
 *  prompt-caching-scope gives scoped cache breakpoints.
 *  ponytail: fine-grained-tool-streaming-2025-05-14 — gjc sends it and repairs truncated
 *  tool-argument JSON; jeo parses accumulated tool JSON without that repair pass, so the
 *  beta stays off until a repair step exists. */
const ANTHROPIC_API_KEY_BETA = [
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
];
const ANTHROPIC_OAUTH_BETA = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
];
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

/** The interleaved-thinking beta drives BUDGET-based thinking+tools. Adaptive-display models
 *  (Opus 4.7+) use adaptive thinking and DON'T need it — gjc drops it for these so the legacy
 *  beta doesn't shadow the adaptive transport. */
function anthropicBetaHeader(betas: string[], model: string): string {
  const filtered = supportsAdaptiveThinkingDisplay(model)
    ? betas.filter(b => b !== INTERLEAVED_THINKING_BETA)
    : betas;
  return filtered.join(",");
}

interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

function stripAnthropicPrefix(model: string): string {
  return model.startsWith("anthropic/") ? model.slice(10) : model;
}

function shouldUseClaudeCodeOAuthShape(model: string, credential: Credential, baseUrl?: string): boolean {
  // Claude-Code OAuth cloaking is for api.anthropic.com only. An OAuth credential
  // against a custom base (e.g. Kimi Code at api.kimi.com/coding) is a plain bearer.
  return credential.kind === "oauth" && !baseUrl && !model.startsWith("claude-3-5-haiku");
}

function createClaudeCloakingUserId(): string {
  return `user_${randomBytes(32).toString("hex")}_account_${randomUUID().toLowerCase()}_session_${randomUUID().toLowerCase()}`;
}

function createClaudeBillingHeader(payload: unknown): string {
  const payloadJson = JSON.stringify(payload) ?? "";
  const cch = createHash("sha256").update(payloadJson).digest("hex").slice(0, 5);
  const randomBytes = new Uint8Array(2);
  crypto.getRandomValues(randomBytes);
  const buildHash = Array.from(randomBytes, byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 3);
  return `${CLAUDE_BILLING_HEADER_PREFIX} cc_version=${CLAUDE_CODE_VERSION}.${buildHash}; cc_entrypoint=cli; cch=${cch};`;
}

function anthropicSystemBlocks(
  systemPrompt: string | undefined,
  model: string,
  credential: Credential,
  billingPayload: Record<string, unknown>,
  baseUrl?: string,
): AnthropicSystemBlock[] | undefined {
  const blocks: AnthropicSystemBlock[] = [];
  if (shouldUseClaudeCodeOAuthShape(model, credential, baseUrl)) {
    const billingSeed = systemPrompt ? { ...billingPayload, system: [systemPrompt] } : billingPayload;
    blocks.push(
      { type: "text", text: createClaudeBillingHeader(billingSeed) },
      { type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION },
    );
  }
  if (systemPrompt) {
    blocks.push({ type: "text", text: systemPrompt });
  }
  if (blocks.length === 0) return undefined;

  // Prompt caching (gjc parity): Anthropic cache breakpoints are cumulative. Put a
  // single breakpoint on the last system block so Claude Code OAuth prelude + the
  // real system prompt are cached together without burning multiple slots.
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: "ephemeral" } };
  return blocks;
}

/** Anthropic extended-thinking budget by reasoning effort (kept under max_tokens). Tiers match
 *  gjc's ANTHROPIC_THINKING table: low/medium/high ALL enable thinking with scaling
 *  depth — reasoning works at every thinking level (gajae parity).
 *  Only an UNSET effort stays non-thinking (the explicit /fast off path). The "xhigh" row is
 *  correct-by-table even though upstream currently folds xhigh→high before it arrives. */
function anthropicThinkingBudget(effort: CallOptions["reasoningEffort"] | "xhigh", maxTokens: number): number | undefined {
  let budget: number;
  switch (effort) {
    case "low": budget = 4096; break;
    case "medium": budget = 8192; break;
    case "high": budget = 16384; break;
    case "xhigh": budget = 32768; break;
    default: return undefined;
  }
  return Math.min(budget, Math.max(1024, maxTokens - 1024));
}

/** Parse an Anthropic model id's family + version for thinking-transport selection.
 *  Matches the modern `claude-<family>-<major>-<minor>[...]` naming (opus/sonnet/haiku 4.x+);
 *  legacy ids (claude-3-5-sonnet) and non-Anthropic-compatible names return undefined. */
function parseAnthropicVersion(model: string): { kind: "opus" | "sonnet" | "haiku" | "fable" | "mythos"; major: number; minor: number } | undefined {
  // `<major>-<minor>` (opus/sonnet/haiku 4.x) OR a single `<major>` (Sonnet 5, Fable 5,
  // Mythos 5 — the dateless 5th-gen ids), with new families fable/mythos. Legacy ids
  // (claude-3-5-sonnet: number before family) and non-Anthropic names return undefined.
  const m = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/.exec(model);
  if (!m) return undefined;
  return { kind: m[1] as "opus" | "sonnet" | "haiku" | "fable" | "mythos", major: Number(m[2]), minor: m[3] !== undefined ? Number(m[3]) : 0 };
}

/** Server-side fallback (docs.claude.com/en/docs/build-with-claude/refusals-and-fallback):
 *  name up to 3 fallback models on the request and Anthropic retries a safety-classifier
 *  DECLINE (any `stop_details.category` — reasoning_extraction, cyber, bio, frontier_llm)
 *  against the next model in the SAME request/stream, before jeo's engine ever sees an
 *  error. Field case: fable-5 turns replaying thinking-block history tripped
 *  `reasoning_extraction` and re-refused through the whole engine ladder (context reset,
 *  artifact strip, guidance strip) because every rung resent the SAME model. Scoped to
 *  `claude-fable-5` (the model this beta's docs are written against — Mythos-5's
 *  invite-only status makes its fallback support unconfirmed) on a DIRECT api.anthropic.com
 *  API-key or Claude-Code OAuth call: the beta's request/response shape is undocumented for
 *  a custom baseUrl (Anthropic-compatible third-party hosts), so those paths keep today's
 *  reactive (post-refusal) recovery unchanged.
 *  `JEO_ANTHROPIC_FALLBACK=0` opts out entirely. */
const FALLBACK_BETA = "server-side-fallback-2026-06-01";
function anthropicFallbackModels(model: string, credential: Credential, baseUrl: string | undefined): string[] {
  if (jeoEnv("ANTHROPIC_FALLBACK") === "0") return [];
  if (baseUrl) return [];
  const v = parseAnthropicVersion(model);
  if (!v || v.kind !== "fable") return [];
  return ["claude-opus-4-8"];
}

/** Adaptive thinking `display` is supported starting with Opus 4.7. Without it, Opus 4.7/4.8
 *  OMIT thinking content entirely (tokens billed, signature present, but zero visible thought —
 *  the "reasoning doesn't show" bug). Older adaptive models (Opus 4.6, Sonnet 4.6+) reject the
 *  field, so it is gated to Opus ≥ 4.7 and every 5th-gen+ model. (gjc: supportsAdaptiveThinkingDisplay) */
function supportsAdaptiveThinkingDisplay(model: string): boolean {
  const v = parseAnthropicVersion(model);
  if (!v) return false;
  // display:"summarized" was introduced at Opus 4.7 and carried forward, so every
  // 5th-generation+ model (Sonnet 5, Fable 5, Mythos 5, …) supports it too. Only the
  // first adaptive gen (Opus 4.6, Sonnet 4.6) rejects the field.
  if (v.major >= 5) return true;
  return v.kind === "opus" && v.major === 4 && v.minor >= 7;
}

/** Thinking transport for a model (gjc parity — inferThinkingControlMode):
 *  - Anthropic ≥ 4.6 → "adaptive" (model decides depth; effort rides output_config, NO budget)
 *  - Anthropic 4.5 sonnet/opus → "budget-effort" (budget_tokens + output_config effort)
 *  - otherwise (incl. Haiku 4.5) → "budget" (budget_tokens only).
 *  The adaptive shift is the core opus-4.7/4.8 reasoning fix: those models reject the legacy
 *  budget transport's visible-thought contract and require type:"adaptive" + display:summarized.
 *  Haiku 4.5 supports budget_tokens thinking but REJECTS output_config.effort ("This model does
 *  not support the effort parameter"), so it stays on the plain budget transport unlike its
 *  sonnet/opus 4.5 siblings. */
type AnthropicThinkingMode = "adaptive" | "budget-effort" | "budget";
function anthropicThinkingMode(model: string): AnthropicThinkingMode {
  const v = parseAnthropicVersion(model);
  if (!v) return "budget";
  if (v.major > 4 || (v.major === 4 && v.minor >= 6)) return "adaptive";
  if (v.major === 4 && v.minor === 5 && v.kind !== "haiku") return "budget-effort";
  return "budget";
}

/** Map jeo's reasoning effort to Anthropic's adaptive/output_config effort literal. jeo folds
 *  xhigh→high upstream, so only low/medium/high arrive here. (gjc: mapEffortToAnthropicAdaptiveEffort) */
function anthropicAdaptiveEffort(effort: NonNullable<CallOptions["reasoningEffort"]>): "low" | "medium" | "high" {
  switch (effort) {
    case "low": return "low";
    case "medium": return "medium";
    case "high": return "high";
  }
}

type AnthropicContentBlock = Record<string, unknown>;
type AnthropicMessage = { role: string; content: string | AnthropicContentBlock[] };

/** True when an assistant turn can be replayed as native tool_use + thinking blocks: it has
 *  structured toolUse AND a same-model Anthropic reasoning artifact that yields at least one
 *  valid thinking/redacted block, AND thinking is enabled this call. Native tool_use →
 *  tool_result is what makes Claude KEEP the prior thinking blocks (plain-text tool feedback
 *  gets them stripped on most models), so this is the core of cross-step reasoning continuity. */
export function anthropicNativizable(m: Message, model: string, thinkingEnabled: boolean): boolean {
  return thinkingEnabled
    && !!m.toolUse?.length
    && !!m.reasoningArtifacts?.some(a => a.provider === "anthropic" && a.model === model && (!!a.signature || !!a.redacted));
}

/** Build Anthropic wire messages, reconstructing native tool_use / tool_result / thinking
 *  blocks for matching turns. `thinkingEnabled` is false (or stripped on a fail-safe retry)
 *  ⇒ everything falls back to the plain string/image content (current, always-valid shape). */
export function buildAnthropicMessages(messages: Message[], model: string, thinkingEnabled: boolean): AnthropicMessage[] {
  const nonSystem = messages.filter(m => m.role !== "system");
  const plain = (m: Message): AnthropicMessage => ({
    role: m.role,
    content: m.images?.length
      ? [
          ...m.images.map((img): AnthropicContentBlock => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } })),
          ...(m.content ? [{ type: "text", text: m.content } as AnthropicContentBlock] : []),
        ]
      : m.content,
  });
  return nonSystem.map((m, i) => {
    if (m.role === "assistant" && anthropicNativizable(m, model, thinkingEnabled)) {
      const blocks: AnthropicContentBlock[] = [];
      for (const a of m.reasoningArtifacts!) {
        if (a.provider !== "anthropic" || a.model !== model) continue;
        if (a.signature) blocks.push({ type: "thinking", thinking: a.text ?? "", signature: a.signature });
        else if (a.redacted) blocks.push({ type: "redacted_thinking", data: a.redacted });
      }
      for (const tu of m.toolUse!) blocks.push({ type: "tool_use", id: tu.id, name: tu.tool, input: tu.arguments });
      return { role: "assistant", content: blocks };
    }
    // A tool-result user turn is nativized iff its preceding assistant was — so a native
    // tool_use always has its matching native tool_result (Anthropic errors on a mismatch).
    if (m.role === "user" && m.toolResults?.length && i > 0
        && nonSystem[i - 1].role === "assistant"
        && anthropicNativizable(nonSystem[i - 1], model, thinkingEnabled)) {
      const blocks: AnthropicContentBlock[] = m.toolResults.map(tr => ({
        type: "tool_result", tool_use_id: tr.id, content: tr.output, is_error: tr.isError,
      }));
      if (m.toolResultExtra) blocks.push({ type: "text", text: m.toolResultExtra });
      return { role: "user", content: blocks };
    }
    return plain(m);
  });
}

export function anthropicPayload(
  messages: Message[],
  options: CallOptions,
  stream: boolean,
  includeTemperature: boolean,
  credential: Credential = { kind: "none", provider: "anthropic" },
  stripArtifacts = false,
  disableFallback = false,
): string {
  const model = stripAnthropicPrefix(options.model);
  const systemPrompt = options.systemPrompt ?? messages.find(m => m.role === "system")?.content;
  // Image attachments + native tool/thinking-block reconstruction live in buildAnthropicMessages.
  // Non-streaming requests must finish inside Anthropic's ~10-minute HTTP window; a
  // 64k+ budget can exceed it on a slow generation. 32k (the proven xhigh ceiling)
  // stays safe; the stream path carries the full catalog-derived budget.
  const NON_STREAM_MAX_TOKENS = 32_000;
  const requestedMax = options.maxTokens ?? 4000;
  const maxTokens = stream ? requestedMax : Math.min(requestedMax, NON_STREAM_MAX_TOKENS);
  const effort = options.reasoningEffort;
  const thinkingEnabled = effort !== undefined;
  // gjc parity: pick the thinking transport per model. Adaptive (Opus/Sonnet 4.6+) carries NO
  // budget_tokens — depth rides output_config.effort. budget/budget-effort still use a budget.
  const thinkingMode = thinkingEnabled ? anthropicThinkingMode(model) : "budget";
  const thinkingBudget = thinkingEnabled && thinkingMode !== "adaptive"
    ? anthropicThinkingBudget(effort, maxTokens)
    : undefined;
  // Reconstruct native tool_use / tool_result / thinking blocks for same-model turns when
  // thinking is enabled (and not stripped by a fail-safe retry); else plain string/image.
  const anthropicMessages = buildAnthropicMessages(messages, options.model, thinkingEnabled && !stripArtifacts);
  // Conversation prompt caching (gjc parity — the main same-model latency gap):
  // one breakpoint on the LAST message caches the entire conversation prefix, so
  // each agent-loop step only pays input processing for the new tail instead of
  // re-ingesting the whole growing history. Combined with the system-block
  // breakpoint this uses 2 of Anthropic's 4 slots. Sub-minimum prompts (<1024
  // tokens) ignore the marker harmlessly.
  const last = anthropicMessages[anthropicMessages.length - 1];
  if (last) {
    if (typeof last.content === "string") {
      if (last.content) last.content = [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }];
    } else if (last.content.length > 0) {
      const tail = last.content[last.content.length - 1]!;
      last.content[last.content.length - 1] = { ...tail, cache_control: { type: "ephemeral" } };
    }
  }

  const payload: Record<string, unknown> = {
    model,
    messages: anthropicMessages,
    // Extended thinking requires max_tokens strictly above the thinking budget.
    max_tokens: thinkingBudget !== undefined ? Math.max(maxTokens, thinkingBudget + 1024) : maxTokens,
  };
  if (shouldUseClaudeCodeOAuthShape(model, credential, options.baseUrl)) payload.metadata = { user_id: createClaudeCloakingUserId() };
  if (effort !== undefined) {
    // Enable Claude extended thinking. Extended thinking forbids a custom temperature, so
    // temperature is only set on the non-thinking path.
    if (thinkingMode === "adaptive") {
      // Opus/Sonnet 4.6+: the model decides how much to think. `display: "summarized"` is
      // REQUIRED on Opus 4.7+ or thinking content is omitted from the response (the empty-thought
      // bug); older adaptive models (4.6) reject the field, so it is gated. Effort rides
      // output_config — there is no budget_tokens on this transport.
      payload.thinking = supportsAdaptiveThinkingDisplay(model)
        ? { type: "adaptive", display: "summarized" }
        : { type: "adaptive" };
      payload.output_config = { effort: anthropicAdaptiveEffort(effort) };
    } else {
      // Budget-based extended thinking. `display: "summarized"` keeps human-readable thought
      // streaming. The 4.5 (budget-effort) transport also carries an output_config effort.
      payload.thinking = { type: "enabled", budget_tokens: thinkingBudget, display: "summarized" };
      if (thinkingMode === "budget-effort") payload.output_config = { effort: anthropicAdaptiveEffort(effort) };
    }
  } else if (includeTemperature && options.temperature !== undefined) {
    payload.temperature = options.temperature;
  }
  if (options.tools?.length) {
    // NATIVE tool-calling: declare jeo's tools as Anthropic functions. tool_choice
    // "auto" keeps prose-salvage reachable and lets the model call `done` (declared as
    // a tool) — never "required", which would kill the plain-text final-answer path.
    payload.tools = options.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    payload.tool_choice = { type: "auto" };
  }
  if (stream) payload.stream = true;
  if (!disableFallback) {
    const fallbacks = anthropicFallbackModels(model, credential, options.baseUrl);
    if (fallbacks.length) payload.fallbacks = fallbacks.map(m => ({ model: m }));
  }
  const system = anthropicSystemBlocks(systemPrompt, model, credential, payload, options.baseUrl);
  if (system) payload.system = system;
  return JSON.stringify(sanitizeJsonStrings(payload));
}

export function anthropicRequest(
  messages: Message[],
  options: CallOptions,
  credential: Credential,
  stream: boolean,
  includeTemperature: boolean,
  stripArtifacts = false,
  disableFallback = false,
): { url: string; headers: Record<string, string>; body: string } {
  return {
    // Anthropic-compatible providers (z.ai, MiniMax, …) accept the Messages wire
    // format at their own host; an explicit baseUrl pins `${base}/v1/messages`.
    url: options.baseUrl ? `${options.baseUrl.replace(/\/$/, "")}/v1/messages` : ANTHROPIC_URL,
    headers: { ...headersFor(credential, stream, stripAnthropicPrefix(options.model), options.baseUrl, disableFallback), ...options.extraHeaders },
    body: anthropicPayload(messages, options, stream, includeTemperature, credential, stripArtifacts, disableFallback),
  };
}

function isDeprecatedTemperatureError(status: number, detail: string): boolean {
  return status === 400 && detail.includes(DEPRECATED_TEMPERATURE);
}

/** A 400 that names thinking/signature/redacted means a replayed reasoning artifact was
 *  rejected (expired signature, edited history, thinking toggled). The fail-safe retries
 *  once with artifacts stripped (plain string history) so the turn survives. */
function isReasoningArtifactError(status: number, detail: string): boolean {
  return status === 400 && /thinking|signature|redacted_thinking/i.test(detail);
}

/** A 400 naming "fallback" means the account/endpoint rejected the `fallbacks`
 *  param or its beta header — not GA yet, a non-Claude-API Anthropic-compatible
 *  host, OR (per the docs) the named fallback model can't satisfy a feature THIS
 *  request uses ("rejects the request up front"). Retry once with fallback
 *  disabled entirely so the turn survives on today's reactive-recovery path
 *  instead of dying on an unrelated 400. */
function isFallbackUnsupportedError(status: number, detail: string): boolean {
  return status === 400 && /fallback/i.test(detail);
}

/** gjc parity (getSafeAnthropicHeaderEvidence): fold Anthropic's rate-limit response
 *  headers into a 429's error detail so the retry classifier can see them. The decisive
 *  usage-exhaustion signal (`anthropic-ratelimit-unified-overage-disabled-reason:
 *  out_of_credits`) often arrives ONLY as a header — without this, an out-of-credits 429
 *  reads like a generic per-minute rate limit and is retried pointlessly. */
function anthropicRateLimitEvidence(headers: Headers): string {
  const evidence: string[] = [];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (lower === "retry-after" || lower === "retry-after-ms" || lower.startsWith("anthropic-ratelimit-")) {
      evidence.push(`${lower}=${value}`);
    }
  }
  return evidence.length > 0 ? ` Anthropic rate-limit evidence: ${evidence.sort().join(", ")}` : "";
}

async function postAnthropic(
  messages: Message[],
  options: CallOptions,
  credential: Credential,
  stream: boolean,
): Promise<Response> {
  let includeTemperature = true;
  let stripArtifacts = false;
  let disableFallback = false;

  for (let attempt = 1; attempt <= 4; attempt++) {
    const { url, headers, body } = anthropicRequest(
      messages,
      options,
      credential,
      stream,
      includeTemperature,
      stripArtifacts,
      disableFallback,
    );
    const response = await fetch(url, { method: "POST", headers, body, signal: options.signal });
    if (response.ok) return response;

    const detail = await response.text().catch(() => "");
    if (isDeprecatedTemperatureError(response.status, detail) && includeTemperature) {
      includeTemperature = false;
      continue;
    }
    if (isReasoningArtifactError(response.status, detail) && !stripArtifacts) {
      stripArtifacts = true;
      continue;
    }
    if (isFallbackUnsupportedError(response.status, detail) && !disableFallback) {
      disableFallback = true;
      continue;
    }

    // Unrecoverable error, or all retries for the active error type spent
    const enrichedDetail = response.status === 429 ? `${detail}${anthropicRateLimitEvidence(response.headers)}` : detail;
    throw new ProviderHttpError(
      "Anthropic",
      response.status,
      enrichedDetail,
      stream ? "(stream)" : undefined,
      parseRetryAfter(response.headers.get("retry-after")) ?? parseRetryFromBody(detail),
    );
  }
  throw new Error("Anthropic request failed: maximum retries reached without response");
}

/** Anthropic usage: with prompt caching the input splits into uncached + cache read +
 *  cache creation. Sum them so reported input reflects the TRUE prompt size. */
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
export function totalInputTokens(u: AnthropicUsage): number {
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

/** Round-5 #1: HTTP-200-with-no-text must surface its CAUSE (stop_reason) instead
 *  of returning "" — an empty reply just bounces in the JSON loop, burning billed
 *  calls until the step budget dies. Mirrors gemini's blockedReason contract.
 *  `category` (from `stop_details.category`, e.g. "reasoning_extraction") is
 *  defensive: today's live refusal-category delivery is an HTTP-error message
 *  (see providerHttpError), but if Anthropic ever ships a category via a 200
 *  body/stream event instead, folding it in here keeps friendlyProviderError's
 *  category-aware clarifying note working instead of silently degrading to the
 *  generic refusal copy. Absent category keeps the existing plain shape unchanged. */
function emptyCompletionError(stopReason: string | undefined, category?: string): Error {
  const hint = stopReason === "max_tokens"
    ? " — output budget exhausted before any text; raise maxTokens or lower the thinking level"
    : "";
  const reason = stopReason ? (category ? `stop_reason=${stopReason}, category=${category}` : `stop_reason=${stopReason}`) : undefined;
  return new Error(`Anthropic returned no content${reason ? ` (${reason})` : ""}${hint}.`);
}

export const anthropicAdapter: ProviderAdapter = {
  name: "anthropic",
  supportsNativeTools: true,
  async call(messages, options, credential) {
    const response = await postAnthropic(messages, options, credential, false);
    const result = (await response.json()) as { model?: string; content: { type: string; text?: string; name?: string; input?: unknown; thinking?: string; signature?: string; data?: string }[]; stop_reason?: string; stop_details?: { category?: string }; usage?: AnthropicUsage };
    if (result.usage) options.onUsage?.({ inputTokens: totalInputTokens(result.usage), outputTokens: result.usage.output_tokens });
    // Tag with the model that ACTUALLY produced the content — on a server-side
    // fallback (see anthropicFallbackModels), `result.model` names the fallback
    // model, not `options.model` (the originally requested one). Stamping the
    // wrong model would make a later same-`options.model` turn wrongly nativize
    // (or wrongly SKIP nativizing) this artifact — `anthropicNativizable` gates
    // strictly on an exact model match, so an honest tag is required either way.
    const servedModel = result.model ?? options.model;
    // Capture thinking/redacted blocks as replay artifacts (parity with the stream path).
    for (const c of result.content) {
      if (c.type === "thinking" && (c.thinking || c.signature)) {
        options.onReasoningArtifact?.({ provider: "anthropic", model: servedModel, text: c.thinking || undefined, signature: c.signature });
      } else if (c.type === "redacted_thinking" && c.data) {
        options.onReasoningArtifact?.({ provider: "anthropic", model: servedModel, redacted: c.data });
      }
    }
    // Prefer a native tool call (re-serialized to canonical JSON) over any stray text.
    const toolCall = serializeToolCalls(
      result.content
        .filter(c => c.type === "tool_use" && typeof c.name === "string")
        .map(c => ({ tool: c.name as string, arguments: (c.input ?? {}) as Record<string, unknown> })),
    );
    if (toolCall) return toolCall;
    const text = result.content.find(c => c.type === "text")?.text ?? "";
    if (!text) throw emptyCompletionError(result.stop_reason, result.stop_details?.category);
    return text;
  },
  async *stream(messages, options, credential) {
    const response = await postAnthropic(messages, options, credential, true);
    if (!response.body) return;
    let cachedInput: number | undefined;
    let yieldedAny = false;
    let stopReason: string | undefined;
    let stopCategory: string | undefined;
    // The model that actually served the response — starts at the requested model,
    // updated from `message_start.message.model` and, on a mid-stream server-side
    // fallback (see anthropicFallbackModels), from the `fallback` block's `to.model`.
    // Reasoning artifacts are tagged with THIS, not `options.model` — see call()'s
    // matching comment for why an honest tag is required either way.
    let servedModel = options.model;
    // Native tool_use streams as content_block_start (name) + input_json_delta fragments,
    // never as text_delta — accumulate per block index, then re-serialize to canonical
    // JSON and yield it once at the end (concatenation still equals call()).
    const toolBlocks = new Map<number, { name: string; args: string }>();
    // Thinking blocks stream as content_block_start(type:thinking) + thinking_delta(text)
    // + signature_delta(signature). Accumulate per index and emit one ReasoningArtifact per
    // block on stream end so the signed thought can be replayed (gajae continuity).
    const thinkBlocks = new Map<number, { text: string; signature?: string }>();
    for await (const data of readSse(response.body, options.onStreamActivity)) {
      let evt: {
        type?: string;
        index?: number;
        content_block?: { type?: string; name?: string; data?: string; to?: { model?: string } };
        delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string; stop_reason?: string; stop_details?: { category?: string } };
        message?: { model?: string; usage?: AnthropicUsage; stop_reason?: string; stop_details?: { category?: string } };
        usage?: { output_tokens?: number };
      };
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use" && typeof evt.index === "number") {
        toolBlocks.set(evt.index, { name: evt.content_block.name ?? "", args: "" });
      } else if (evt.type === "content_block_start" && evt.content_block?.type === "fallback") {
        // A safety-classifier decline handed off mid-stream (docs.claude.com's "When the
        // decline happens mid-output"): an ordinary content_block_start/stop pair with no
        // deltas, marking the boundary. Everything accumulated so far was produced by the
        // DECLINING model and must be dropped on replay (thinking/redacted_thinking/
        // client-side tool_use before the boundary) — best-effort here since a
        // redacted_thinking block streams its artifact immediately (see below) and can't
        // be un-sent; the common case (decline BEFORE any output — the bug this fixes)
        // has nothing accumulated yet, so this branch is rarely reached with state to drop.
        toolBlocks.clear();
        thinkBlocks.clear();
        if (evt.content_block.to?.model) servedModel = evt.content_block.to.model;
      } else if (evt.type === "content_block_start" && evt.content_block?.type === "thinking" && typeof evt.index === "number") {
        thinkBlocks.set(evt.index, { text: "" });
        // Signal the thinking phase started so the UI shows a live "thinking" indicator
        // even for signature-only models (opus-4-7/4-8) that stream NO thinking_delta text.
        options.onReasoningStart?.();
      } else if (evt.type === "content_block_start" && evt.content_block?.type === "redacted_thinking" && evt.content_block.data) {
        // Redacted thinking carries opaque `data` directly (no deltas) — emit immediately.
        options.onReasoningStart?.();
        options.onReasoningArtifact?.({ provider: "anthropic", model: servedModel, redacted: evt.content_block.data });
      } else if (evt.type === "content_block_delta" && evt.delta?.type === "input_json_delta" && typeof evt.index === "number") {
        const b = toolBlocks.get(evt.index);
        if (b) b.args += evt.delta.partial_json ?? "";
      } else if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
        yieldedAny = true;
        yield evt.delta.text;
      } else if (evt.type === "content_block_delta" && evt.delta?.type === "thinking_delta" && evt.delta.thinking) {
        options.onReasoning?.(evt.delta.thinking);
        if (typeof evt.index === "number") {
          const tb = thinkBlocks.get(evt.index) ?? { text: "" };
          tb.text += evt.delta.thinking;
          thinkBlocks.set(evt.index, tb);
        }
      } else if (evt.type === "content_block_delta" && evt.delta?.type === "signature_delta" && evt.delta.signature && typeof evt.index === "number") {
        const tb = thinkBlocks.get(evt.index) ?? { text: "" };
        tb.signature = (tb.signature ?? "") + evt.delta.signature;
        thinkBlocks.set(evt.index, tb);
      } else if (evt.type === "message_start" && evt.message) {
        if (evt.message.model) servedModel = evt.message.model;
        if (evt.message.stop_reason) stopReason = evt.message.stop_reason;
        if (evt.message.stop_details?.category) stopCategory = evt.message.stop_details.category;
        if (evt.message.usage) {
          // Cache only — usage is reported ONCE at message_delta so an accumulating
          // sink can't double-count input (and a pre-first-chunk retry that replays
          // message_start is harmless).
          cachedInput = totalInputTokens(evt.message.usage);
        }
      } else if (evt.type === "message_delta") {
        if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
        if (evt.delta?.stop_details?.category) stopCategory = evt.delta.stop_details.category;
        if (evt.usage) options.onUsage?.({ inputTokens: cachedInput, outputTokens: evt.usage.output_tokens });
      }
    }
    // Emit captured thinking blocks as replay artifacts (signed thought + signature).
    for (const tb of thinkBlocks.values()) {
      if (tb.text || tb.signature) {
        yieldedAny = true;
        options.onReasoningArtifact?.({ provider: "anthropic", model: servedModel, text: tb.text || undefined, signature: tb.signature });
      }
    }
    const envelope = serializeAccumulatedToolCalls(toolBlocks);
    if (envelope) { yieldedAny = true; yield envelope; }
    if (!yieldedAny) throw emptyCompletionError(stopReason, stopCategory);
  },
};
function mapStainlessOs(platform: string): "MacOS" | "Windows" | "Linux" | "FreeBSD" | `Other::${string}` {
  switch (platform.toLowerCase()) {
    case "darwin":
      return "MacOS";
    case "windows":
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    case "freebsd":
      return "FreeBSD";
    default:
      return `Other::${platform.toLowerCase()}`;
  }
}

function mapStainlessArch(arch: string): "x64" | "arm64" | "x86" | `other::${string}` {
  switch (arch.toLowerCase()) {
    case "amd64":
    case "x64":
      return "x64";
    case "arm64":
    case "aarch64":
      return "arm64";
    case "386":
    case "x86":
    case "ia32":
      return "x86";
    default:
      return `other::${arch.toLowerCase()}`;
  }
}

function claudeCodeOAuthHeaders(stream: boolean, model: string): Record<string, string> {
  return {
    accept: stream ? "text/event-stream" : "application/json",
    "anthropic-beta": anthropicBetaHeader(ANTHROPIC_OAUTH_BETA, model),
    "anthropic-dangerous-direct-browser-access": "true",
    "user-agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
    "x-app": "cli",
    "x-stainless-arch": mapStainlessArch(process.arch),
    "x-stainless-lang": "js",
    "x-stainless-os": mapStainlessOs(process.platform),
    "x-stainless-package-version": "0.74.0",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": "v24.3.0",
    "x-stainless-timeout": "600",
  };
}

function headersFor(credential: Credential, stream: boolean, model: string, baseUrl?: string, disableFallback = false): Record<string, string> {
  if (credential.kind === "oauth") {
    // OAuth against a NON-Anthropic base (Kimi Code, …): plain bearer, no Claude-Code
    // cloaking headers/betas. gjc parity: buildAnthropicHeaders' generic-bearer branch.
    if (baseUrl) {
      return {
        accept: stream ? "text/event-stream" : "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${credential.token}`,
        "anthropic-version": "2023-06-01",
      };
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${credential.token}`,
      "anthropic-version": "2023-06-01",
      ...claudeCodeOAuthHeaders(stream, model),
    };
    if (!disableFallback && anthropicFallbackModels(model, credential, baseUrl).length) {
      const betas = headers["anthropic-beta"] ? headers["anthropic-beta"].split(",") : [];
      if (!betas.includes(FALLBACK_BETA)) {
        betas.push(FALLBACK_BETA);
        headers["anthropic-beta"] = betas.join(",");
      }
    }
    return headers;
  }
  if (credential.kind === "api_key") {
    const betas = ANTHROPIC_API_KEY_BETA.slice();
    if (!disableFallback && anthropicFallbackModels(model, credential, baseUrl).length) betas.push(FALLBACK_BETA);
    return {
      accept: stream ? "text/event-stream" : "application/json",
      "content-type": "application/json",
      "x-api-key": credential.token,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": anthropicBetaHeader(betas, model),
    };
  }
  throw new Error("anthropic adapter requires a credential");
}
