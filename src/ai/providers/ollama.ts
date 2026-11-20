import type { CallOptions, Message, ProviderAdapter } from "../types";
import { readLines } from "../sse";
import { providerHttpError } from "./errors";
import { createThinkSplitter } from "../think-tags";
import { sanitizeJsonStrings } from "../../util/sanitize-json";
import { serializeToolCalls } from "../../agent/tool-schemas";
import {
  buildToolCallJsonSchema,
  demoteToolTier,
  endpointTierKey,
  getEffectiveToolTier,
  type ToolCallingTier,
} from "./local-capabilities";

/**
 * Resolve the Ollama base URL. `OLLAMA_HOST` is documented as a bare host:port
 * (e.g. `127.0.0.1:11434`), but `fetch` needs a scheme — prepend `http://` when
 * missing, else `fetch("127.0.0.1:11434/api/chat")` throws "Failed to parse URL".
 */
export function normalizeOllamaBaseUrl(baseUrl?: string): string {
  const v = (baseUrl ?? process.env.OLLAMA_HOST ?? "http://localhost:11434").trim();
  return (/^https?:\/\//i.test(v) ? v : `http://${v}`).replace(/\/$/, "");
}

export const DEFAULT_OLLAMA_NUM_CTX = 16384;

export function resolveOllamaNumCtx(explicit?: number): number {
  if (typeof explicit === "number" && explicit > 0) return Math.floor(explicit);
  const env = process.env.OLLAMA_NUM_CTX ?? process.env.OLLAMA_CONTEXT_LENGTH;
  const parsed = env ? Number.parseInt(env, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OLLAMA_NUM_CTX;
}

interface OllamaToolCall {
  function?: {
    name?: string;
    arguments?: Record<string, unknown> | string;
  };
}

function parseOllamaToolCalls(
  toolCalls: OllamaToolCall[] | undefined,
): { tool: string; arguments: Record<string, unknown> }[] {
  if (!toolCalls?.length) return [];
  const out: { tool: string; arguments: Record<string, unknown> }[] = [];
  for (const tc of toolCalls) {
    const name = tc.function?.name;
    if (!name) continue;
    let args: Record<string, unknown> = {};
    const rawArgs = tc.function?.arguments;
    if (typeof rawArgs === "string") {
      try {
        args = JSON.parse(rawArgs) as Record<string, unknown>;
      } catch {
        args = {};
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs;
    }
    out.push({ tool: name, arguments: args });
  }
  return out;
}

export function ollamaRequest(
  messages: Message[],
  options: CallOptions,
  stream: boolean,
): { url: string; body: string } {
  const model = options.model.startsWith("ollama/") ? options.model.slice(7) : options.model;
  const systemPrompt = options.systemPrompt ?? messages.find(m => m.role === "system")?.content;
  const chatMessages: { role: string; content: string; images?: string[] }[] = [];
  if (systemPrompt) chatMessages.push({ role: "system", content: systemPrompt });
  for (const msg of messages) {
    if (msg.role === "system") continue;
    if (msg.images?.length) chatMessages.push({ role: msg.role, content: msg.content, images: msg.images.map(i => i.data) });
    else chatMessages.push({ role: msg.role, content: msg.content });
  }
  const payload: Record<string, unknown> = {
    model,
    messages: chatMessages,
    stream,
    options: {
      temperature: options.temperature ?? 0.2,
      num_predict: options.maxTokens ?? 4000,
      num_ctx: resolveOllamaNumCtx(options.numCtx),
    },
  };

  const tier = options.toolCallingTier;
  if (tier === "native" && options.tools?.length) {
    payload.tools = options.tools.map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  } else if (options.jsonSchema || (tier === "structured" && options.tools?.length)) {
    payload.format = options.jsonSchema ?? buildToolCallJsonSchema(options.tools);
  } else if (options.jsonMode && tier !== "prose") {
    payload.format = "json";
  }

  const base = normalizeOllamaBaseUrl(options.baseUrl);
  return { url: `${base}/api/chat`, body: JSON.stringify(sanitizeJsonStrings(payload)) };
}

function emptyCompletionError(doneReason: string | undefined): Error {
  const hint = doneReason === "length"
    ? " — output budget exhausted before any text; raise maxTokens"
    : "";
  return new Error(`Ollama returned no content${doneReason ? ` (done_reason=${doneReason})` : ""}${hint}.`);
}

function assertNormalDone(doneReason: string | undefined): void {
  if (doneReason && doneReason !== "stop") {
    const hint = doneReason === "length" ? " — output budget exhausted; raise maxTokens" : "";
    throw new Error(`Ollama response incomplete (done_reason=${doneReason})${hint}.`);
  }
}

function isOllamaTier400(status: number, errBody: string): boolean {
  if (status !== 400) return false;
  return /does not support tools|tool|format|schema|invalid json|template/i.test(errBody);
}

export const ollamaAdapter: ProviderAdapter = {
  name: "ollama",
  async call(messages, options) {
    const base = normalizeOllamaBaseUrl(options.baseUrl);
    const bareModel = options.model.startsWith("ollama/") ? options.model.slice(7) : options.model;
    const tierKey = endpointTierKey("ollama", base, bareModel);
    let activeTier: ToolCallingTier | undefined = options.toolCallingTier
      ? getEffectiveToolTier(tierKey, options.toolCallingTier)
      : undefined;

    while (true) {
      const reqOpts = activeTier ? { ...options, toolCallingTier: activeTier } : options;
      const { url, body } = ollamaRequest(messages, reqOpts, false);
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: options.signal,
      });
      if (!response.ok) {
        if (activeTier && activeTier !== "prose" && response.status === 400) {
          const errText = await response.clone().text().catch(() => "");
          if (isOllamaTier400(response.status, errText)) {
            await response.body?.cancel().catch(() => {});
            activeTier = demoteToolTier(tierKey, activeTier, errText);
            continue;
          }
        }
        throw await providerHttpError("Ollama", response, `at ${url}`);
      }
      const result = (await response.json()) as {
        message?: { content?: string; tool_calls?: OllamaToolCall[] };
        done_reason?: string;
        prompt_eval_count?: number;
        eval_count?: number;
        total_duration?: number;
      };
      options.onUsage?.({
        inputTokens: result.prompt_eval_count,
        outputTokens: result.eval_count,
        durationMs: result.total_duration ? Math.round(result.total_duration / 1e6) : undefined,
      });
      assertNormalDone(result.done_reason);
      const toolEnvelope = serializeToolCalls(parseOllamaToolCalls(result.message?.tool_calls));
      if (toolEnvelope) return toolEnvelope;
      const text = result.message?.content ?? "";
      if (!text) throw emptyCompletionError(result.done_reason);
      return text;
    }
  },
  async *stream(messages, options) {
    const base = normalizeOllamaBaseUrl(options.baseUrl);
    const bareModel = options.model.startsWith("ollama/") ? options.model.slice(7) : options.model;
    const tierKey = endpointTierKey("ollama", base, bareModel);
    let activeTier: ToolCallingTier | undefined = options.toolCallingTier
      ? getEffectiveToolTier(tierKey, options.toolCallingTier)
      : undefined;

    let response: Response;
    let url = "";
    while (true) {
      const reqOpts = activeTier ? { ...options, toolCallingTier: activeTier } : options;
      const built = ollamaRequest(messages, reqOpts, true);
      url = built.url;
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: built.body,
        signal: options.signal,
      });
      if (!response.ok) {
        if (activeTier && activeTier !== "prose" && response.status === 400) {
          const errText = await response.clone().text().catch(() => "");
          if (isOllamaTier400(response.status, errText)) {
            await response.body?.cancel().catch(() => {});
            activeTier = demoteToolTier(tierKey, activeTier, errText);
            continue;
          }
        }
        throw await providerHttpError("Ollama", response, `(stream) at ${url}`);
      }
      break;
    }

    if (!response.body) return;
    let yieldedAny = false;
    let doneReason: string | undefined;
    let terminal = false;
    let receivedContent = false;
    const collectedToolCalls: OllamaToolCall[] = [];
    const think = createThinkSplitter(options.onReasoning);
    for await (const line of readLines(response.body, options.onStreamActivity)) {
      let chunk: {
        message?: { content?: string; thinking?: string; tool_calls?: OllamaToolCall[] };
        done?: boolean;
        done_reason?: string;
        prompt_eval_count?: number;
        eval_count?: number;
        total_duration?: number;
      };
      try {
        chunk = JSON.parse(line);
      } catch {
        continue;
      }
      if (chunk.message?.tool_calls?.length) {
        collectedToolCalls.push(...chunk.message.tool_calls);
      }
      const raw = chunk.message?.content;
      if (raw) {
        receivedContent = true;
        const visible = think.push(raw);
        if (visible) {
          yieldedAny = true;
          yield visible;
        }
      }
      const reason = chunk.message?.thinking;
      if (reason) options.onReasoning?.(reason);
      if (chunk.done) {
        terminal = true;
        if (chunk.done_reason) doneReason = chunk.done_reason;
        options.onUsage?.({
          inputTokens: chunk.prompt_eval_count,
          outputTokens: chunk.eval_count,
          durationMs: chunk.total_duration ? Math.round(chunk.total_duration / 1e6) : undefined,
        });
        break;
      }
    }
    if (!terminal && (receivedContent || collectedToolCalls.length > 0)) {
      throw new Error("Ollama response incomplete (missing done event).");
    }
    assertNormalDone(doneReason);
    const trailing = think.flush();
    if (trailing) {
      yieldedAny = true;
      yield trailing;
    }
    const toolEnvelope = serializeToolCalls(parseOllamaToolCalls(collectedToolCalls));
    if (toolEnvelope) {
      yieldedAny = true;
      yield toolEnvelope;
    }
    if (!yieldedAny) throw emptyCompletionError(doneReason);
  },
};
