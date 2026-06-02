import { readGlobalConfig } from "./state";
import { resolveCredential, type AuthProvider } from "../auth";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

export async function callLlm(
  messages: Message[],
  options: ChatOptions = {}
): Promise<string> {
  const config = await readGlobalConfig();
  const model = options.model || config.defaultModel;
  const temperature = options.temperature ?? 0.2;
  const maxTokens = options.maxTokens ?? 4000;

  // 1. Determine provider from model name (ollama = local, keyless)
  let provider: "anthropic" | "openai" | "gemini" | "ollama" = "anthropic";
  if (model.startsWith("ollama/")) {
    provider = "ollama";
  } else if (model.includes("gpt") || model.includes("o1") || model.startsWith("openai/")) {
    provider = "openai";
  } else if (model.includes("gemini") || model.startsWith("google/")) {
    provider = "gemini";
  }

  // 2. Local provider needs no credentials.
  if (provider === "ollama") {
    return await callOllama(config.ollamaBaseUrl || "http://localhost:11434", model, messages, options, temperature, maxTokens);
  }

  // 3. Resolve credential via the auth subsystem (OAuth bearer > API key).
  const credential = await resolveCredential(provider as AuthProvider);
  const oauthToken = credential.kind === "oauth" ? credential.token : undefined;
  const apiKey = credential.kind === "api_key" ? credential.token : undefined;
  // OpenAI-compatible local servers may be keyless when openaiBaseUrl is set.
  const isLocalOpenAi = provider === "openai" && !!config.openaiBaseUrl;
  if (credential.kind === "none" && !isLocalOpenAi) {
    throw new Error(
      `No credential for provider '${provider}'. Run 'joc setup', 'joc auth login', or set ${provider.toUpperCase()}_API_KEY / ${provider.toUpperCase()}_OAUTH_TOKEN.`
    );
  }

  // 4. Make API call based on provider
  if (provider === "anthropic") {
    return await callAnthropic(apiKey, model, messages, options, temperature, maxTokens, oauthToken);
  } else if (provider === "openai") {
    return await callOpenAi(apiKey, model, messages, options, temperature, maxTokens, oauthToken);
  } else {
    return await callGemini(apiKey, model, messages, options, temperature, maxTokens, oauthToken);
  }
}

async function callAnthropic(
  apiKey: string | undefined,
  model: string,
  messages: Message[],
  options: ChatOptions,
  temperature: number,
  maxTokens: number,
  oauthToken?: string
): Promise<string> {
  const resolvedModel = model.startsWith("anthropic/") ? model.slice(10) : model;
  const systemPrompt = options.systemPrompt || messages.find(m => m.role === "system")?.content;
  const anthropicMessages = messages.filter(m => m.role !== "system").map(m => ({
    role: m.role,
    content: m.content,
  }));

  const payload: Record<string, unknown> = {
    model: resolvedModel.includes("sonnet") ? "claude-3-5-sonnet-20241022" : resolvedModel,
    messages: anthropicMessages,
    max_tokens: maxTokens,
    temperature,
  };

  if (systemPrompt) {
    payload.system = systemPrompt;
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: oauthToken
      ? {
          "content-type": "application/json",
          authorization: `Bearer ${oauthToken}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
        }
      : {
          "content-type": "application/json",
          "x-api-key": apiKey as string,
          "anthropic-version": "2023-06-01",
        },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API request failed (HTTP ${response.status}): ${errorText}`);
  }

  const result = (await response.json()) as { content: { type: string; text: string }[] };
  return result.content.find(c => c.type === "text")?.text || "";
}

async function callOpenAi(
  apiKey: string | undefined,
  model: string,
  messages: Message[],
  options: ChatOptions,
  temperature: number,
  maxTokens: number,
  oauthToken?: string
): Promise<string> {
  const resolvedModel = model.startsWith("openai/") ? model.slice(7) : model;
  const systemPrompt = options.systemPrompt || messages.find(m => m.role === "system")?.content;
  
  const openaiMessages: { role: string; content: string }[] = [];
  if (systemPrompt) {
    openaiMessages.push({ role: "system", content: systemPrompt });
  }
  for (const msg of messages) {
    if (msg.role !== "system") {
      openaiMessages.push({ role: msg.role, content: msg.content });
    }
  }

  const payload: Record<string, unknown> = {
    model: resolvedModel.includes("gpt-4o") ? "gpt-4o" : resolvedModel,
    messages: openaiMessages,
    temperature,
    max_tokens: maxTokens,
  };

  if (options.jsonMode) {
    payload.response_format = { type: "json_object" };
  }

  const base =
    (await readGlobalConfig()).openaiBaseUrl ||
    process.env.OPENAI_BASE_URL ||
    "https://api.openai.com/v1";
  const response = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${oauthToken ?? apiKey ?? "no-key"}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API request failed (HTTP ${response.status}): ${errorText}`);
  }

  const result = (await response.json()) as {
    choices: { message: { content: string } }[];
  };
  return result.choices[0]?.message?.content || "";
}

async function callGemini(
  apiKey: string | undefined,
  model: string,
  messages: Message[],
  options: ChatOptions,
  temperature: number,
  maxTokens: number,
  oauthToken?: string
): Promise<string> {
  const resolvedModel = model.startsWith("google/") ? model.slice(7) : model;
  const systemPrompt = options.systemPrompt || messages.find(m => m.role === "system")?.content;

  // Standardize model name for API route
  let geminiModelName = resolvedModel;
  if (!geminiModelName || geminiModelName === "claude-3-5-sonnet") {
    geminiModelName = "gemini-2.0-flash";
  }

  const geminiContents = messages.filter(m => m.role !== "system").map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const payload: Record<string, unknown> = {
    contents: geminiContents,
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
    },
  };

  if (systemPrompt) {
    payload.systemInstruction = {
      parts: [{ text: systemPrompt }],
    };
  }

  if (options.jsonMode) {
    payload.generationConfig = {
      ...(payload.generationConfig as object),
      responseMimeType: "application/json",
    };
  }

  const base = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModelName}:generateContent`;
  const url = oauthToken ? base : `${base}?key=${apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: oauthToken
      ? { "content-type": "application/json", authorization: `Bearer ${oauthToken}` }
      : { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API request failed (HTTP ${response.status}): ${errorText}`);
  }

  const result = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return result.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function callOllama(
  baseUrl: string,
  model: string,
  messages: Message[],
  options: ChatOptions,
  temperature: number,
  maxTokens: number
): Promise<string> {
  const resolvedModel = model.startsWith("ollama/") ? model.slice(7) : model;
  const systemPrompt = options.systemPrompt || messages.find(m => m.role === "system")?.content;
  const chatMessages: { role: string; content: string }[] = [];
  if (systemPrompt) chatMessages.push({ role: "system", content: systemPrompt });
  for (const msg of messages) {
    if (msg.role !== "system") chatMessages.push({ role: msg.role, content: msg.content });
  }

  const payload: Record<string, unknown> = {
    model: resolvedModel,
    messages: chatMessages,
    stream: false,
    options: { temperature, num_predict: maxTokens },
  };
  if (options.jsonMode) payload.format = "json";

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama request failed (HTTP ${response.status}) at ${baseUrl}: ${errorText}`);
  }

  const result = (await response.json()) as { message?: { content?: string } };
  return result.message?.content || "";
}
