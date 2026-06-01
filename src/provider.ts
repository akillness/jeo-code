/**
 * jeoc provider layer — unified chat+tool-calling across providers, mirroring
 * gjc's @gajae-code/ai provider boundary. Real HTTP via global `fetch`
 * (Gemini, Anthropic, OpenAI) + a deterministic `mock` provider for tests.
 *
 * Zero external dependencies.
 */
import type { ResolvedConfig } from "./config.ts";

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema (object)
}
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[]; // assistant
  toolCallId?: string; // tool
  toolName?: string; // tool
}
export interface ProviderResponse {
  text: string;
  toolCalls: ToolCall[];
}

export interface ProviderRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolDef[];
}

let mockCounter = 0;

/** Deterministic mock. Scripted via env JEOC_MOCK_SCRIPT (JSON array of
 *  { text?, toolCalls?: [{name,args}] }); each call consumes the next entry. */
function mockProvider(req: ProviderRequest): ProviderResponse {
  const script = process.env.JEOC_MOCK_SCRIPT;
  if (script) {
    let steps: Array<{ text?: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> }>;
    try {
      steps = JSON.parse(script);
    } catch {
      throw new Error("mock: JEOC_MOCK_SCRIPT is not valid JSON");
    }
    const step = steps[Math.min(mockCounter, steps.length - 1)];
    mockCounter++;
    return {
      text: step.text ?? "",
      toolCalls: (step.toolCalls ?? []).map((t, i) => ({ id: `mock-${mockCounter}-${i}`, name: t.name, args: t.args })),
    };
  }
  // Unscripted default: echo the last user message, no tools.
  const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
  return { text: `mock: ${lastUser?.content ?? ""}`, toolCalls: [] };
}

export function __resetMock(): void {
  mockCounter = 0;
}

async function httpJson(url: string, init: RequestInit, provider: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new Error(`${provider}: network error — ${(e as Error).message}`);
  }
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`${provider}: HTTP ${res.status} — ${body.slice(0, 500)}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${provider}: non-JSON response — ${body.slice(0, 200)}`);
  }
}

// ── Google Gemini (generativelanguage v1beta) ───────────────────────────────
async function gemini(cfg: ResolvedConfig, req: ProviderRequest): Promise<ProviderResponse> {
  if (!cfg.apiKey && !cfg.oauthToken) throw new Error("gemini: no credential (set GEMINI_API_KEY, jeoc auth login, or jeoc config set apiKey)");
  const base = cfg.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  const url = cfg.oauthToken
    ? `${base}/models/${cfg.model}:generateContent`
    : `${base}/models/${cfg.model}:generateContent?key=${encodeURIComponent(cfg.apiKey as string)}`;
  const authHeaders: Record<string, string> = { "content-type": "application/json" };
  if (cfg.oauthToken) authHeaders.authorization = `Bearer ${cfg.oauthToken}`;
  const contents: unknown[] = [];
  for (let i = 0; i < req.messages.length; i++) {
    const m = req.messages[i];
    if (m.role === "tool") {
      const parts: unknown[] = [];
      while (i < req.messages.length && req.messages[i].role === "tool") {
        const tool = req.messages[i];
        parts.push({ functionResponse: { name: tool.toolName ?? "tool", response: { result: tool.content } } });
        i++;
      }
      i--;
      contents.push({ role: "user", parts });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      contents.push({ role: "model", parts: m.toolCalls.map((tc) => ({ functionCall: { name: tc.name, args: tc.args } })) });
      continue;
    }
    contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] });
  }
  const body: Record<string, unknown> = {
    system_instruction: { parts: [{ text: req.system }] },
    contents,
  };
  if (req.tools.length) {
    body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
  }
  const data = (await httpJson(url, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(body),
  }, "gemini")) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> } }> } }>;
  };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  let text = "";
  const toolCalls: ToolCall[] = [];
  parts.forEach((p, i) => {
    if (p.text) text += p.text;
    if (p.functionCall) toolCalls.push({ id: `gemini-${i}`, name: p.functionCall.name, args: p.functionCall.args ?? {} });
  });
  return { text, toolCalls };
}

// ── Anthropic Messages ──────────────────────────────────────────────────────
async function anthropic(cfg: ResolvedConfig, req: ProviderRequest): Promise<ProviderResponse> {
  if (!cfg.apiKey && !cfg.oauthToken) throw new Error("anthropic: no credential (set ANTHROPIC_API_KEY, jeoc auth login, or jeoc config set apiKey)");
  const base = cfg.baseUrl ?? "https://api.anthropic.com";
  const messages: unknown[] = [];
  for (let i = 0; i < req.messages.length; i++) {
    const m = req.messages[i];
    if (m.role === "tool") {
      const content: unknown[] = [];
      while (i < req.messages.length && req.messages[i].role === "tool") {
        const tool = req.messages[i];
        content.push({ type: "tool_result", tool_use_id: tool.toolCallId, content: tool.content });
        i++;
      }
      i--;
      messages.push({ role: "user", content });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
      messages.push({ role: "assistant", content: blocks });
      continue;
    }
    messages.push({ role: m.role, content: m.content });
  }
  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: 4096,
    system: req.system,
    messages,
  };
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  const data = (await httpJson(`${base}/v1/messages`, {
    method: "POST",
    headers: cfg.oauthToken
      ? {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.oauthToken}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
        }
      : {
          "content-type": "application/json",
          "x-api-key": cfg.apiKey as string,
          "anthropic-version": "2023-06-01",
        },
    body: JSON.stringify(body),
  }, "anthropic")) as {
    content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
  };
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const block of data.content ?? []) {
    if (block.type === "text" && block.text) text += block.text;
    if (block.type === "tool_use") toolCalls.push({ id: block.id ?? `anthropic-${toolCalls.length}`, name: block.name ?? "", args: block.input ?? {} });
  }
  return { text, toolCalls };
}

// ── OpenAI Chat Completions ─────────────────────────────────────────────────
async function openai(cfg: ResolvedConfig, req: ProviderRequest): Promise<ProviderResponse> {
  const cred = cfg.oauthToken ?? cfg.apiKey;
  if (!cred) throw new Error("openai: no credential (set OPENAI_API_KEY, jeoc auth login, or jeoc config set apiKey)");
  const base = cfg.baseUrl ?? "https://api.openai.com";
  const messages: unknown[] = [{ role: "system", content: req.system }];
  for (const m of req.messages) {
    if (m.role === "tool") {
      messages.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      messages.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.args) } })),
      });
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }
  const body: Record<string, unknown> = { model: cfg.model, messages };
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  const data = (await httpJson(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cred}` },
    body: JSON.stringify(body),
  }, "openai")) as {
    choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
  };
  const msg = data.choices?.[0]?.message;
  const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((tc) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments || "{}");
    } catch {
      /* leave empty */
    }
    return { id: tc.id, name: tc.function.name, args };
  });
  return { text: msg?.content ?? "", toolCalls };
}

// ── Ollama (local, OpenAI-incompatible native /api/chat) ─────────────────────
async function ollama(cfg: ResolvedConfig, req: ProviderRequest): Promise<ProviderResponse> {
  const base = cfg.baseUrl ?? "http://localhost:11434";
  const messages: unknown[] = [{ role: "system", content: req.system }];
  for (const m of req.messages) {
    if (m.role === "tool") {
      messages.push({ role: "tool", content: m.content });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      messages.push({
        role: "assistant",
        content: m.content || "",
        tool_calls: m.toolCalls.map((tc) => ({ function: { name: tc.name, arguments: tc.args } })),
      });
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }
  const body: Record<string, unknown> = { model: cfg.model, messages, stream: false };
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  const data = (await httpJson(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, "ollama")) as {
    message?: { content?: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> };
  };
  const msg = data.message;
  const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((tc, i) => ({
    id: `ollama-${i}`,
    name: tc.function.name,
    args: tc.function.arguments ?? {},
  }));
  return { text: msg?.content ?? "", toolCalls };
}
export async function callProvider(cfg: ResolvedConfig, req: ProviderRequest): Promise<ProviderResponse> {
  switch (cfg.provider) {
    case "mock":
      return mockProvider(req);
    case "gemini":
      return gemini(cfg, req);
    case "anthropic":
      return anthropic(cfg, req);
    case "openai":
      return openai(cfg, req);
    case "ollama":
      return ollama(cfg, req);
    default:
      throw new Error(`unknown provider: ${cfg.provider}`);
  }
}
