import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Credential } from "../../auth";
import type { CallOptions, Message, ProviderAdapter } from "../types";
import { readSse } from "../sse";
import { ProviderHttpError, parseRetryAfter, parseRetryFromBody, providerHttpError } from "./errors";
import { serializeToolCalls, serializeAccumulatedToolCalls } from "../../agent/tool-schemas";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const DEPRECATED_TEMPERATURE = "`temperature` is deprecated for this model.";
const CLAUDE_CODE_VERSION = "2.1.63";
const CLAUDE_CODE_SYSTEM_INSTRUCTION = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const CLAUDE_BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";
const ANTHROPIC_OAUTH_BETA = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
].join(",");

interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

function stripAnthropicPrefix(model: string): string {
  return model.startsWith("anthropic/") ? model.slice(10) : model;
}

function shouldUseClaudeCodeOAuthShape(model: string, credential: Credential): boolean {
  return credential.kind === "oauth" && !model.startsWith("claude-3-5-haiku");
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
): AnthropicSystemBlock[] | undefined {
  const blocks: AnthropicSystemBlock[] = [];
  if (shouldUseClaudeCodeOAuthShape(model, credential)) {
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

/** Anthropic extended-thinking budget by reasoning effort (kept under max_tokens). Off for
 *  low/minimal/unset effort so /fast and minimal thinking stay non-thinking (cheaper/faster). */
function anthropicThinkingBudget(effort: CallOptions["reasoningEffort"], maxTokens: number): number | undefined {
  let budget: number;
  switch (effort) {
    case "medium": budget = 10000; break;
    case "high": budget = 24000; break;
    default: return undefined;
  }
  return Math.min(budget, Math.max(1024, maxTokens - 1024));
}

export function anthropicPayload(
  messages: Message[],
  options: CallOptions,
  stream: boolean,
  includeTemperature: boolean,
  credential: Credential = { kind: "none", provider: "anthropic" },
): string {
  const model = stripAnthropicPrefix(options.model);
  const systemPrompt = options.systemPrompt ?? messages.find(m => m.role === "system")?.content;
  // Image attachments (clipboard paste) become Anthropic content blocks; plain
  // string content is kept for text-only messages (the overwhelmingly common case).
  type ContentBlock = Record<string, unknown>;
  const anthropicMessages: { role: string; content: string | ContentBlock[] }[] =
    messages.filter(m => m.role !== "system").map(m => ({
      role: m.role,
      content: m.images?.length
        ? [
            ...m.images.map((img): ContentBlock => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } })),
            ...(m.content ? [{ type: "text", text: m.content } as ContentBlock] : []),
          ]
        : m.content,
    }));
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
  const maxTokens = options.maxTokens ?? 4000;
  const thinkingBudget = anthropicThinkingBudget(options.reasoningEffort, maxTokens);
  const payload: Record<string, unknown> = {
    model,
    messages: anthropicMessages,
    // Extended thinking requires max_tokens strictly above the thinking budget.
    max_tokens: thinkingBudget !== undefined ? Math.max(maxTokens, thinkingBudget + 1024) : maxTokens,
  };
  if (credential.kind === "oauth") payload.metadata = { user_id: createClaudeCloakingUserId() };
  if (thinkingBudget !== undefined) {
    // Apply the thinking level: enable Claude extended thinking (the interleaved-thinking
    // beta is already in the headers). Extended thinking forbids a custom temperature, so
    // temperature is only set on the non-thinking path. Previously the thinking level only
    // changed max_tokens and never reached Claude as actual reasoning depth.
    payload.thinking = { type: "enabled", budget_tokens: thinkingBudget };
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
  const system = anthropicSystemBlocks(systemPrompt, model, credential, payload);
  if (system) payload.system = system;
  return JSON.stringify(payload);
}

export function anthropicRequest(
  messages: Message[],
  options: CallOptions,
  credential: Credential,
  stream: boolean,
  includeTemperature: boolean,
): { url: string; headers: Record<string, string>; body: string } {
  return {
    url: ANTHROPIC_URL,
    headers: headersFor(credential, stream),
    body: anthropicPayload(messages, options, stream, includeTemperature, credential),
  };
}

function isDeprecatedTemperatureError(status: number, detail: string): boolean {
  return status === 400 && detail.includes(DEPRECATED_TEMPERATURE);
}

async function postAnthropic(
  messages: Message[],
  options: CallOptions,
  credential: Credential,
  stream: boolean,
): Promise<Response> {
  const send = (includeTemperature: boolean) => {
    const { url, headers, body } = anthropicRequest(messages, options, credential, stream, includeTemperature);
    return fetch(url, { method: "POST", headers, body, signal: options.signal });
  };

  let response = await send(true);
  if (response.ok) return response;

  const detail = await response.text().catch(() => "");
  if (isDeprecatedTemperatureError(response.status, detail)) {
    response = await send(false);
    if (response.ok) return response;
    throw await providerHttpError("Anthropic", response, stream ? "(stream)" : undefined);
  }

  throw new ProviderHttpError(
    "Anthropic",
    response.status,
    detail,
    stream ? "(stream)" : undefined,
    parseRetryAfter(response.headers.get("retry-after")) ?? parseRetryFromBody(detail),
  );
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
 *  calls until the step budget dies. Mirrors gemini's blockedReason contract. */
function emptyCompletionError(stopReason: string | undefined): Error {
  const hint = stopReason === "max_tokens"
    ? " — output budget exhausted before any text; raise maxTokens or lower the thinking level"
    : "";
  return new Error(`Anthropic returned no content${stopReason ? ` (stop_reason=${stopReason})` : ""}${hint}.`);
}

export const anthropicAdapter: ProviderAdapter = {
  name: "anthropic",
  supportsNativeTools: true,
  async call(messages, options, credential) {
    const response = await postAnthropic(messages, options, credential, false);
    const result = (await response.json()) as { content: { type: string; text?: string; name?: string; input?: unknown }[]; stop_reason?: string; usage?: AnthropicUsage };
    if (result.usage) options.onUsage?.({ inputTokens: totalInputTokens(result.usage), outputTokens: result.usage.output_tokens });
    // Prefer a native tool call (re-serialized to canonical JSON) over any stray text.
    const toolCall = serializeToolCalls(
      result.content
        .filter(c => c.type === "tool_use" && typeof c.name === "string")
        .map(c => ({ tool: c.name as string, arguments: (c.input ?? {}) as Record<string, unknown> })),
    );
    if (toolCall) return toolCall;
    const text = result.content.find(c => c.type === "text")?.text ?? "";
    if (!text) throw emptyCompletionError(result.stop_reason);
    return text;
  },
  async *stream(messages, options, credential) {
    const response = await postAnthropic(messages, options, credential, true);
    if (!response.body) return;
    let cachedInput: number | undefined;
    let yieldedAny = false;
    let stopReason: string | undefined;
    // Native tool_use streams as content_block_start (name) + input_json_delta fragments,
    // never as text_delta — accumulate per block index, then re-serialize to canonical
    // JSON and yield it once at the end (concatenation still equals call()).
    const toolBlocks = new Map<number, { name: string; args: string }>();
    for await (const data of readSse(response.body)) {
      let evt: {
        type?: string;
        index?: number;
        content_block?: { type?: string; name?: string };
        delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; stop_reason?: string };
        message?: { usage?: AnthropicUsage };
        usage?: { output_tokens?: number };
      };
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use" && typeof evt.index === "number") {
        toolBlocks.set(evt.index, { name: evt.content_block.name ?? "", args: "" });
      } else if (evt.type === "content_block_delta" && evt.delta?.type === "input_json_delta" && typeof evt.index === "number") {
        const b = toolBlocks.get(evt.index);
        if (b) b.args += evt.delta.partial_json ?? "";
      } else if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
        yieldedAny = true;
        yield evt.delta.text;
      } else if (evt.type === "content_block_delta" && evt.delta?.type === "thinking_delta" && evt.delta.thinking) {
        options.onReasoning?.(evt.delta.thinking);
      } else if (evt.type === "message_start" && evt.message?.usage) {
        // Cache only — usage is reported ONCE at message_delta so an accumulating
        // sink can't double-count input (and a pre-first-chunk retry that replays
        // message_start is harmless).
        cachedInput = totalInputTokens(evt.message.usage);
      } else if (evt.type === "message_delta") {
        if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
        if (evt.usage) options.onUsage?.({ inputTokens: cachedInput, outputTokens: evt.usage.output_tokens });
      }
    }
    const envelope = serializeAccumulatedToolCalls(toolBlocks);
    if (envelope) { yieldedAny = true; yield envelope; }
    if (!yieldedAny) throw emptyCompletionError(stopReason);
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

function claudeCodeOAuthHeaders(stream: boolean): Record<string, string> {
  return {
    accept: stream ? "text/event-stream" : "application/json",
    "anthropic-beta": ANTHROPIC_OAUTH_BETA,
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

function headersFor(credential: Credential, stream: boolean): Record<string, string> {
  if (credential.kind === "oauth") {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${credential.token}`,
      "anthropic-version": "2023-06-01",
      ...claudeCodeOAuthHeaders(stream),
    };
  }
  if (credential.kind === "api_key") {
    return {
      accept: stream ? "text/event-stream" : "application/json",
      "content-type": "application/json",
      "x-api-key": credential.token,
      "anthropic-version": "2023-06-01",
    };
  }
  throw new Error("anthropic adapter requires a credential");
}
