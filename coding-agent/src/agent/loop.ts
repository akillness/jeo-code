import { readGlobalConfig } from "./state";

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

  // 1. Determine provider from model name
  let provider: "anthropic" | "openai" | "gemini" = "anthropic";
  if (model.includes("gpt") || model.includes("o1") || model.startsWith("openai/")) {
    provider = "openai";
  } else if (model.includes("gemini") || model.startsWith("google/")) {
    provider = "gemini";
  }

  // 2. Fetch appropriate key
  const apiKey = config.providers[provider];
  if (!apiKey) {
    throw new Error(
      `API Key for provider '${provider}' is not set. Run 'joc setup' or set the appropriate environment variable (${provider.toUpperCase()}_API_KEY).`
    );
  }

  // 3. Make API call based on provider
  if (provider === "anthropic") {
    return await callAnthropic(apiKey, model, messages, options, temperature, maxTokens);
  } else if (provider === "openai") {
    return await callOpenAi(apiKey, model, messages, options, temperature, maxTokens);
  } else {
    return await callGemini(apiKey, model, messages, options, temperature, maxTokens);
  }
}

async function callAnthropic(
  apiKey: string,
  model: string,
  messages: Message[],
  options: ChatOptions,
  temperature: number,
  maxTokens: number
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
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
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
  apiKey: string,
  model: string,
  messages: Message[],
  options: ChatOptions,
  temperature: number,
  maxTokens: number
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

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${apiKey}`,
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
  apiKey: string,
  model: string,
  messages: Message[],
  options: ChatOptions,
  temperature: number,
  maxTokens: number
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModelName}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
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
