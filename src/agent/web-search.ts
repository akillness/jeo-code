/**
 * web_search — provider-chain web search.
 *
 * Selects providers instead of hardcoding one backend:
 *
 *   1. An explicitly preferred provider (`JEO_SEARCH_PROVIDER`) that is
 *      available is primary.
 *   2. Otherwise the ACTIVE MODEL's own native search provider is primary,
 *      but only when that provider's credentials are present (active-model
 *      gating — never credential scanning). Native providers today: Anthropic's
 *      server-side `web_search_20250305` tool, OpenAI's Responses API `web_search`
 *      hosted tool, and Gemini's `googleSearch` grounding tool (also used for
 *      `antigravity` sessions when a plain `GEMINI_API_KEY` happens to be set —
 *      Google/Gemini OAuth does not serve this endpoint, so it never qualifies).
 *   3. DuckDuckGo (keyless HTML scraping, no API key, no OAuth) is ALWAYS
 *      appended as the terminal fallback, so a missing/failed primary still
 *      returns real results with zero configuration — results are always
 *      live provider data, never canned.
 *
 * Providers are tried in order; a runtime failure fails over to the next.
 * The structured text output doubles as the source for the TUI's
 * Web Search card (Query / Answer / Sources / Metadata sections — see
 * `webSearchCardLines` in tui/components/forge.ts).
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { resolveCredential, type AuthProvider, type Credential } from "../auth";
import { jeoEnv } from "../util/env";
import { getClaudeCodeVersion, parseRequiredClaudeCodeVersion, raiseClaudeCodeVersion } from "../ai/claude-code-version";
import type { ToolResult } from "./tools";

// ── Unified response shape ───────────────────────────────────────────────────

export interface WebSearchSource {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: string;
}

export interface WebSearchResponse {
  /** Display label of the provider that actually produced this response. */
  provider: string;
  answer?: string;
  sources: WebSearchSource[];
  citations: { url: string; title?: string; citedText?: string }[];
  searchQueries: string[];
  usage?: { inputTokens?: number; outputTokens?: number; searchRequests?: number };
  model?: string;
  requestId?: string;
  relatedQuestions?: string[];
}

export interface SearchRequest {
  query: string;
  recency?: "day" | "week" | "month" | "year";
  limit?: number;
  maxTokens?: number;
}

export interface SearchProviderDef {
  id: "perplexity" | "anthropic" | "openai" | "gemini" | "duckduckgo";
  label: string;
  /** Credential gate — keyless providers return true unconditionally. */
  isAvailable(): Promise<boolean> | boolean;
  /** Throws on failure; the chain runner fails over to the next provider. */
  search(req: SearchRequest): Promise<WebSearchResponse>;
}

// ── Perplexity provider (cookies / OAuth / API key / OpenRouter / anonymous) ──

const execFileAsync = promisify(execFile);

const PERPLEXITY_ASK_URL = "https://www.perplexity.ai/rest/sse/perplexity_ask";
const PERPLEXITY_CHAT_URL = "https://api.perplexity.ai/chat/completions";
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_SEARCH_MODEL_PERPLEXITY = "sonar-pro";
const PERPLEXITY_DEFAULT_MAX_TOKENS = 8192;
const PERPLEXITY_DEFAULT_TEMPERATURE = 0.2;
const PERPLEXITY_DEFAULT_NUM_SEARCH_RESULTS = 20;
const PERPLEXITY_HARD_TIMEOUT_MS = 90_000;
const PERPLEXITY_OAUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const PERPLEXITY_OAUTH_API_VERSION = "2.18";
const PERPLEXITY_OAUTH_USER_AGENT = "Perplexity/641 CFNetwork/1568 Darwin/25.2.0";
const PERPLEXITY_ANONYMOUS_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

interface PerplexityAskMarkdownBlock {
  answer?: string;
  chunks?: string[];
  chunk_starting_offset?: number;
}

interface PerplexityAskWebResult {
  name?: string;
  url?: string;
  snippet?: string;
  timestamp?: string;
}

interface PerplexityAskWebResultBlock {
  web_results?: PerplexityAskWebResult[];
}

interface PerplexityAskBlock {
  intended_usage?: string;
  markdown_block?: PerplexityAskMarkdownBlock;
  web_result_block?: PerplexityAskWebResultBlock;
}

interface PerplexityAskSource {
  title?: string;
  url?: string;
  snippet?: string;
  date?: string;
}

export interface PerplexityAskStreamEvent {
  status?: string;
  final?: boolean;
  final_sse_message?: boolean;
  text?: string;
  blocks?: PerplexityAskBlock[];
  sources_list?: PerplexityAskSource[];
  upsell_information?: {
    name?: string;
    upsell_type?: string;
    cta?: string;
    cta_information?: { disallow_close?: boolean };
  };
  error_code?: string;
  error_message?: string;
  display_model?: string;
  uuid?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Decode a Perplexity JWT `exp` claim in ms; returns `undefined` when absent (non-expiring session). */
export function jwtExpiryMs(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const payload = parts[1];
  if (!payload) return undefined;
  try {
    const decoded = parseJsonSafe(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isRecord(decoded)) return undefined;
    const exp = decoded.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
    return exp * 1000;
  } catch {
    return undefined;
  }
}

function isPerplexityJwtValid(token: string): boolean {
  const exp = jwtExpiryMs(token);
  return exp === undefined || exp > Date.now() + PERPLEXITY_OAUTH_EXPIRY_BUFFER_MS;
}

async function readMacPerplexityAuthToken(): Promise<string | undefined> {
  if (
    process.platform !== "darwin" ||
    process.env.NODE_ENV === "test" ||
    jeoEnv("CONFIG_DIR") ||
    process.env.JEO_AUTH_NO_BORROW === "1"
  ) {
    return undefined;
  }
  try {
    const statusRes = await execFileAsync("defaults", ["read", "ai.perplexity.mac", "cachedLaunchLoginStatus"], {
      timeout: 2000,
    }).catch(() => null);
    if (statusRes) {
      const loginStatus = statusRes.stdout.trim().toLowerCase();
      if (loginStatus === "0" || loginStatus === "false") {
        return undefined;
      }
    }
    const { stdout } = await execFileAsync("defaults", ["read", "ai.perplexity.mac", "authToken"], { timeout: 2000 });
    const token = stdout.trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

type PerplexityAuthMethod =
  | { type: "cookies"; cookies: string }
  | { type: "oauth"; token: string }
  | { type: "api_key"; provider: "perplexity" | "openrouter"; apiKey: string; baseUrl: string; model: string }
  | { type: "anonymous" };

async function resolvePerplexityAuthMethods(explicit: boolean): Promise<PerplexityAuthMethod[]> {
  const methods: PerplexityAuthMethod[] = [];

  // 1. Browser cookies take top precedence
  const cookies = process.env.PERPLEXITY_COOKIES?.trim();
  if (cookies) {
    methods.push({ type: "cookies", cookies });
  }

  // 2. Perplexity OAuth (stored credential / env / macOS app token fallback)
  let oauthToken: string | undefined;
  const storedOAuth = await resolveCredential("perplexity" as AuthProvider, { preferKind: "oauth" }).catch(() => null);
  if (storedOAuth?.kind === "oauth" && storedOAuth.token.trim() && isPerplexityJwtValid(storedOAuth.token.trim())) {
    oauthToken = storedOAuth.token.trim();
  }
  if (!oauthToken) {
    const envOAuth = process.env.PERPLEXITY_OAUTH_TOKEN?.trim();
    if (envOAuth && isPerplexityJwtValid(envOAuth)) {
      oauthToken = envOAuth;
    }
  }
  if (!oauthToken) {
    const macToken = await readMacPerplexityAuthToken();
    if (macToken && isPerplexityJwtValid(macToken)) {
      oauthToken = macToken;
    }
  }
  if (oauthToken) {
    methods.push({ type: "oauth", token: oauthToken });
  }

  // 3. Direct Perplexity API key
  let directApiKey =
    jeoEnv("SEARCH_API_KEY_PERPLEXITY")?.trim() ||
    process.env.PERPLEXITY_API_KEY?.trim() ||
    process.env.PPLX_API_KEY?.trim();
  if (!directApiKey) {
    const storedKey = await resolveCredential("perplexity" as AuthProvider, { preferKind: "api_key" }).catch(() => null);
    if (storedKey?.kind === "api_key" && storedKey.token.trim()) {
      directApiKey = storedKey.token.trim();
    }
  }
  if (directApiKey) {
    methods.push({
      type: "api_key",
      provider: "perplexity",
      apiKey: directApiKey,
      baseUrl: PERPLEXITY_CHAT_URL,
      model: jeoEnv("SEARCH_MODEL_PERPLEXITY")?.trim() || DEFAULT_SEARCH_MODEL_PERPLEXITY,
    });
  }

  // 4. OpenRouter fallback ONLY when Perplexity is explicitly selected
  if (explicit) {
    let openrouterKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!openrouterKey) {
      const storedOr = await resolveCredential("openrouter", { preferKind: "api_key" }).catch(() => null);
      if (storedOr?.kind === "api_key" && storedOr.token.trim()) {
        openrouterKey = storedOr.token.trim();
      }
    }
    if (openrouterKey) {
      const modelOverride = jeoEnv("SEARCH_MODEL_PERPLEXITY")?.trim();
      const model = modelOverride
        ? (modelOverride.startsWith("perplexity/") ? modelOverride : `perplexity/${modelOverride}`)
        : "perplexity/sonar-pro";
      methods.push({
        type: "api_key",
        provider: "openrouter",
        apiKey: openrouterKey,
        baseUrl: OPENROUTER_CHAT_URL,
        model,
      });
    }
  }

  // 5. Anonymous fallback ONLY when Perplexity is explicitly selected and no auth is configured
  if (explicit && methods.length === 0) {
    methods.push({ type: "anonymous" });
  }

  return methods;
}

function mergeMarkdownBlock(
  existing: PerplexityAskMarkdownBlock | undefined,
  incoming: PerplexityAskMarkdownBlock,
): PerplexityAskMarkdownBlock {
  if (!existing) return { ...incoming };
  const result: PerplexityAskMarkdownBlock = { ...existing, ...incoming };
  if (incoming.chunks?.length) {
    const offset = incoming.chunk_starting_offset ?? 0;
    const existingChunks = existing.chunks ?? [];
    result.chunks = offset === 0 ? [...incoming.chunks] : [...existingChunks.slice(0, offset), ...incoming.chunks];
  }
  return result;
}

function mergeBlocks(existing: PerplexityAskBlock[], incoming: PerplexityAskBlock[]): PerplexityAskBlock[] {
  const blockMap = new Map<string, PerplexityAskBlock>(
    existing
      .filter(block => typeof block.intended_usage === "string" && block.intended_usage.length > 0)
      .map(block => [block.intended_usage as string, block]),
  );
  for (const block of incoming) {
    if (!block.intended_usage) continue;
    const prev = blockMap.get(block.intended_usage);
    if (block.markdown_block) {
      blockMap.set(block.intended_usage, {
        ...prev,
        ...block,
        markdown_block: mergeMarkdownBlock(prev?.markdown_block, block.markdown_block),
      });
      continue;
    }
    blockMap.set(block.intended_usage, { ...prev, ...block });
  }
  return [...blockMap.values()];
}

function mergeAskEventSnapshot(
  existing: PerplexityAskStreamEvent,
  incoming: PerplexityAskStreamEvent,
): PerplexityAskStreamEvent {
  const merged: PerplexityAskStreamEvent = { ...existing, ...incoming };
  merged.blocks = incoming.blocks?.length ? mergeBlocks(existing.blocks ?? [], incoming.blocks) : (existing.blocks ?? []);
  if (!merged.sources_list && existing.sources_list) {
    merged.sources_list = existing.sources_list;
  }
  return merged;
}

function textFromChunks(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  let text = "";
  for (const chunk of value) {
    if (typeof chunk !== "string") return null;
    text += chunk;
  }
  return text.length > 0 ? text : null;
}

function parseAskTextPayload(text: string): Record<string, unknown> | null {
  const parsed = parseJsonSafe(text);
  if (isRecord(parsed)) return parsed;
  if (!Array.isArray(parsed)) return null;
  for (const item of parsed) {
    const step = isRecord(item) ? item : null;
    const content = isRecord(step?.content) ? step.content : null;
    const answer = content?.answer;
    if (typeof answer !== "string" || answer.length === 0) continue;
    const payload = parseJsonSafe(answer);
    if (isRecord(payload)) return payload;
  }
  return null;
}

function parseAskTextAnswer(text: string): string {
  const payload = parseAskTextPayload(text);
  if (payload) {
    if (Array.isArray(payload.structured_answer)) {
      for (const item of payload.structured_answer) {
        if (!isRecord(item)) continue;
        if (typeof item.text === "string" && item.text.length > 0) return item.text;
        const structuredChunks = textFromChunks(item.chunks);
        if (structuredChunks) return structuredChunks;
      }
    }
    const chunks = textFromChunks(payload.chunks);
    if (chunks) return chunks;
    if (typeof payload.answer === "string" && payload.answer.length > 0) return payload.answer;
  }
  const parsed = parseJsonSafe(text);
  if (!Array.isArray(parsed)) return text;
  for (const item of parsed) {
    const step = isRecord(item) ? item : null;
    const content = isRecord(step?.content) ? step.content : null;
    const answer = content?.answer;
    if (typeof answer === "string" && answer.length > 0) return answer;
  }
  return text;
}

function buildAskSources(event: PerplexityAskStreamEvent): WebSearchSource[] {
  const results = event.blocks?.find(block => block.intended_usage === "web_results")?.web_result_block?.web_results ?? [];
  if (results.length > 0) {
    return results
      .filter(result => typeof result.url === "string" && result.url.length > 0)
      .map(result => ({
        title: (typeof result.name === "string" && result.name) || result.url!,
        url: result.url!,
        snippet: typeof result.snippet === "string" ? result.snippet : undefined,
        publishedDate: typeof result.timestamp === "string" ? result.timestamp : undefined,
      }));
  }

  const listSources = (event.sources_list ?? [])
    .filter(source => typeof source.url === "string" && source.url.length > 0)
    .map(source => ({
      title: (typeof source.title === "string" && source.title) || source.url!,
      url: source.url!,
      snippet: typeof source.snippet === "string" ? source.snippet : undefined,
      publishedDate: typeof source.date === "string" ? source.date : undefined,
    }));
  if (listSources.length > 0) return listSources;

  if (!event.text) return [];
  const payload = parseAskTextPayload(event.text);
  const webResults = payload?.web_results;
  if (!Array.isArray(webResults) || webResults.length === 0) return [];
  const sources: WebSearchSource[] = [];
  for (const value of webResults) {
    if (!isRecord(value)) continue;
    const url = value.url;
    if (typeof url !== "string" || url.length === 0) continue;
    const name = value.name ?? value.title;
    sources.push({
      title: typeof name === "string" && name.length > 0 ? name : url,
      url,
      snippet: typeof value.snippet === "string" ? value.snippet : undefined,
      publishedDate: typeof value.timestamp === "string" ? value.timestamp : undefined,
    });
  }
  return sources;
}

function buildAskAnswer(event: PerplexityAskStreamEvent): string {
  if (!event.blocks?.length) {
    return typeof event.text === "string" ? parseAskTextAnswer(event.text) : "";
  }
  const markdownBlock = event.blocks.find(
    block => block.intended_usage?.includes("markdown") && block.markdown_block,
  )?.markdown_block;
  if (markdownBlock) {
    if (Array.isArray(markdownBlock.chunks) && markdownBlock.chunks.length > 0) {
      return markdownBlock.chunks.join("");
    }
    if (typeof markdownBlock.answer === "string" && markdownBlock.answer.length > 0) {
      return markdownBlock.answer;
    }
  }
  const textBlock = event.blocks.find(
    block => block.intended_usage === "ask_text" && block.markdown_block,
  )?.markdown_block;
  if (textBlock) {
    if (Array.isArray(textBlock.chunks) && textBlock.chunks.length > 0) {
      return textBlock.chunks.join("");
    }
    if (typeof textBlock.answer === "string" && textBlock.answer.length > 0) {
      return textBlock.answer;
    }
  }
  if (typeof event.text === "string" && event.text.length > 0) {
    return parseAskTextAnswer(event.text);
  }
  return "";
}

const PERPLEXITY_AUTH_WALL_RE =
  /\b(?:sign up|log in|sign in)\b|가입한\s*뒤|로그인(?:한\s*뒤|하세|해\s*주)|회원가입/i;

function isAuthWallUpsell(event: PerplexityAskStreamEvent): boolean {
  const upsell = event.upsell_information;
  if (!upsell) return false;
  if (upsell.name === "fraud_authwall_upsell") return true;
  return upsell.upsell_type === "LOGIN" && upsell.cta_information?.disallow_close === true;
}

interface AskAccumulatorState {
  answer: string;
  model?: string;
  requestId?: string;
  authWall: boolean;
  sourcesByUrl: Map<string, WebSearchSource>;
  mergedEvent: PerplexityAskStreamEvent;
}

function applyAskEvent(state: AskAccumulatorState, rawEvent: unknown): boolean {
  if (!isRecord(rawEvent)) return false;
  const event = rawEvent as PerplexityAskStreamEvent;
  if (event.error_code || event.error_message) {
    const message = event.error_message ?? event.error_code ?? "unknown error";
    throw new Error(`Perplexity ask stream error: ${message}`);
  }
  if (isAuthWallUpsell(event)) {
    state.authWall = true;
  }
  state.mergedEvent = mergeAskEventSnapshot(state.mergedEvent, event);
  const eventAnswer = buildAskAnswer(state.mergedEvent);
  if (eventAnswer.length > 0) {
    state.answer = eventAnswer;
  }
  for (const source of buildAskSources(state.mergedEvent)) {
    state.sourcesByUrl.set(source.url, source);
  }
  if (typeof state.mergedEvent.display_model === "string" && state.mergedEvent.display_model) {
    state.model = state.mergedEvent.display_model;
  }
  if (typeof state.mergedEvent.uuid === "string" && state.mergedEvent.uuid) {
    state.requestId = state.mergedEvent.uuid;
  }
  if (event.final_sse_message === true || state.mergedEvent.status === "COMPLETED") {
    return true;
  }
  return Boolean(event.final === true && event.final_sse_message !== false && event.status !== "PENDING");
}

/** Parse an iterable sequence of decoded Perplexity `perplexity_ask` SSE JSON objects. */
export function parsePerplexityAskEvents(
  events: Iterable<unknown>,
  fallbackRequestId?: string,
): WebSearchResponse {
  const state: AskAccumulatorState = {
    answer: "",
    authWall: false,
    sourcesByUrl: new Map<string, WebSearchSource>(),
    mergedEvent: { blocks: [] },
  };
  for (const event of events) {
    if (applyAskEvent(state, event)) break;
  }
  return {
    provider: "Perplexity",
    answer: state.answer || undefined,
    sources: [...state.sourcesByUrl.values()],
    citations: [],
    searchQueries: [],
    model: state.model,
    requestId: state.requestId ?? fallbackRequestId,
  };
}

async function* readSseJsonEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let dataLines: string[] = [];

  const flushEvent = (): { done: boolean; payload?: unknown } => {
    if (dataLines.length === 0) return { done: false };
    const rawData = dataLines.join("\n");
    dataLines = [];
    if (rawData === "" || rawData === "[DONE]") {
      return { done: rawData === "[DONE]" };
    }
    try {
      return { done: false, payload: JSON.parse(rawData) };
    } catch {
      return { done: false };
    }
  };

  const processLine = (rawLine: string): { done: boolean; payload?: unknown } | undefined => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") return flushEvent();
    if (line.startsWith(":")) return undefined;
    if (line.startsWith("data:")) {
      let data = line.slice(5);
      if (data.startsWith(" ")) data = data.slice(1);
      dataLines.push(data);
    }
    return undefined;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nlIdx: number;
      while ((nlIdx = buffer.indexOf("\n")) !== -1) {
        const res = processLine(buffer.slice(0, nlIdx));
        buffer = buffer.slice(nlIdx + 1);
        if (res?.payload !== undefined) yield res.payload;
        if (res?.done) return;
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      for (const line of buffer.split("\n")) {
        const res = processLine(line);
        if (res?.payload !== undefined) yield res.payload;
        if (res?.done) return;
      }
    }
    const trailing = flushEvent();
    if (trailing.payload !== undefined) yield trailing.payload;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function parsePerplexityAskStreamDetailed(
  streamOrText: ReadableStream<Uint8Array> | string,
  fallbackRequestId?: string,
): Promise<{ response: WebSearchResponse; authWall: boolean }> {
  const stream =
    typeof streamOrText === "string"
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(streamOrText));
            controller.close();
          },
        })
      : streamOrText;
  const state: AskAccumulatorState = {
    answer: "",
    authWall: false,
    sourcesByUrl: new Map<string, WebSearchSource>(),
    mergedEvent: { blocks: [] },
  };
  for await (const event of readSseJsonEvents(stream)) {
    if (applyAskEvent(state, event)) break;
  }
  return {
    authWall: state.authWall,
    response: {
      provider: "Perplexity",
      answer: state.answer || undefined,
      sources: [...state.sourcesByUrl.values()],
      citations: [],
      searchQueries: [],
      model: state.model,
      requestId: state.requestId ?? fallbackRequestId,
    },
  };
}

/** Parse a `perplexity_ask` SSE stream (ReadableStream or raw SSE text) into the unified response. */
export async function parsePerplexityAskStream(
  streamOrText: ReadableStream<Uint8Array> | string,
  fallbackRequestId?: string,
): Promise<WebSearchResponse> {
  const { response } = await parsePerplexityAskStreamDetailed(streamOrText, fallbackRequestId);
  return response;
}

/** Parse a non-streaming Perplexity (or OpenRouter `perplexity/*`) `chat/completions` JSON response. */
export function parsePerplexityApiResponse(response: unknown): WebSearchResponse {
  const res = isRecord(response) ? response : null;
  const choices = Array.isArray(res?.choices) ? res.choices : [];
  const firstChoice = isRecord(choices[0]) ? choices[0] : null;
  const message = isRecord(firstChoice?.message) ? firstChoice.message : null;

  let answer = "";
  if (typeof message?.content === "string") {
    answer = message.content;
  } else if (Array.isArray(message?.content)) {
    answer = message.content
      .map(part => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
      .join("");
  } else if (typeof res?.output_text === "string") {
    answer = res.output_text;
  }

  interface ParsedSearchResult {
    url: string;
    title?: string;
    snippet?: string;
    date?: string;
  }
  const rawSearchResults = Array.isArray(res?.search_results)
    ? res.search_results
    : Array.isArray(res?.results)
      ? res.results
      : [];
  const searchResults: ParsedSearchResult[] = [];
  for (const item of rawSearchResults) {
    if (!isRecord(item) || typeof item.url !== "string" || item.url.length === 0) continue;
    searchResults.push({
      url: item.url,
      title: typeof item.title === "string" && item.title.length > 0 ? item.title : undefined,
      snippet: typeof item.snippet === "string" ? item.snippet : undefined,
      date: typeof item.date === "string" ? item.date : undefined,
    });
  }

  const rawCitations = Array.isArray(res?.citations) ? res.citations : [];
  const citationUrls: string[] = [];
  for (const item of rawCitations) {
    if (typeof item === "string" && item.length > 0) {
      citationUrls.push(item);
    } else if (isRecord(item) && typeof item.url === "string" && item.url.length > 0) {
      citationUrls.push(item.url);
    }
  }

  const sources: WebSearchSource[] = [];
  const citations: WebSearchResponse["citations"] = [];
  if (citationUrls.length > 0) {
    for (const url of citationUrls) {
      const sr = searchResults.find(r => r.url === url);
      const title = sr?.title ?? url;
      sources.push({ title, url, snippet: sr?.snippet, publishedDate: sr?.date });
      citations.push({ url, title });
    }
  } else if (searchResults.length > 0) {
    for (const sr of searchResults) {
      sources.push({ title: sr.title ?? sr.url, url: sr.url, snippet: sr.snippet, publishedDate: sr.date });
    }
  } else if (Array.isArray(message?.annotations)) {
    const seen = new Set<string>();
    for (const ann of message.annotations) {
      if (!isRecord(ann)) continue;
      const urlCitation = isRecord(ann.url_citation) ? ann.url_citation : ann;
      if (typeof urlCitation.url !== "string" || !urlCitation.url) continue;
      const url = urlCitation.url;
      const title = typeof urlCitation.title === "string" && urlCitation.title ? urlCitation.title : url;
      citations.push({ url, title });
      if (!seen.has(url)) {
        seen.add(url);
        sources.push({ title, url });
      }
    }
  }

  const relatedQuestions = Array.isArray(res?.related_questions)
    ? res.related_questions.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
    : [];

  const rawUsage = isRecord(res?.usage) ? res.usage : null;
  const inputTokens =
    typeof rawUsage?.prompt_tokens === "number"
      ? rawUsage.prompt_tokens
      : typeof rawUsage?.input_tokens === "number"
        ? rawUsage.input_tokens
        : undefined;
  const outputTokens =
    typeof rawUsage?.completion_tokens === "number"
      ? rawUsage.completion_tokens
      : typeof rawUsage?.output_tokens === "number"
        ? rawUsage.output_tokens
        : undefined;

  return {
    provider: "Perplexity",
    answer: answer.trim() || undefined,
    sources,
    citations,
    searchQueries: [],
    ...(relatedQuestions.length > 0 ? { relatedQuestions } : {}),
    usage: inputTokens !== undefined || outputTokens !== undefined ? { inputTokens, outputTokens } : undefined,
    model: typeof res?.model === "string" ? res.model : undefined,
    requestId: typeof res?.id === "string" ? res.id : undefined,
  };
}

async function callPerplexityApi(
  auth: Extract<PerplexityAuthMethod, { type: "api_key" }>,
  req: SearchRequest,
): Promise<WebSearchResponse> {
  const body: Record<string, unknown> = {
    model: auth.model,
    messages: [
      { role: "system", content: SEARCH_SYSTEM_PROMPT },
      { role: "user", content: req.query },
    ],
    max_tokens: typeof req.maxTokens === "number" ? req.maxTokens : PERPLEXITY_DEFAULT_MAX_TOKENS,
    temperature: PERPLEXITY_DEFAULT_TEMPERATURE,
    search_mode: "web",
    num_search_results: PERPLEXITY_DEFAULT_NUM_SEARCH_RESULTS,
    web_search_options: {
      search_type: "pro",
      search_context_size: "high",
    },
    return_related_questions: true,
    stream: false,
  };
  if (req.recency) {
    body.search_recency_filter = req.recency;
  }
  const response = await fetch(auth.baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${auth.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PERPLEXITY_HARD_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    const label = auth.provider === "openrouter" ? "OpenRouter" : "Perplexity";
    throw new Error(`${label} API error (${response.status}): ${detail}`);
  }
  const parsed = parsePerplexityApiResponse(await response.json().catch(() => null));
  if (req.limit && req.limit > 0 && parsed.sources.length > req.limit) {
    parsed.sources = parsed.sources.slice(0, req.limit);
  }
  return parsed;
}

async function callPerplexityAsk(
  auth: Extract<PerplexityAuthMethod, { type: "cookies" | "oauth" | "anonymous" }>,
  req: SearchRequest,
): Promise<WebSearchResponse> {
  const requestId = randomUUID();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Origin: "https://www.perplexity.ai",
    Referer: "https://www.perplexity.ai/",
    "User-Agent": auth.type === "anonymous" ? PERPLEXITY_ANONYMOUS_USER_AGENT : PERPLEXITY_OAUTH_USER_AGENT,
    "X-Request-ID": requestId,
  };
  if (auth.type === "oauth") {
    headers.Cookie = `__Secure-next-auth.session-token=${auth.token}`;
  } else if (auth.type === "cookies") {
    headers.Cookie = auth.cookies;
  }
  if (auth.type !== "anonymous") {
    headers["X-App-ApiClient"] = "default";
    headers["X-App-ApiVersion"] = PERPLEXITY_OAUTH_API_VERSION;
    headers["X-Perplexity-Request-Reason"] = "submit";
  }

  const requestParams: Record<string, unknown> = {
    query_str: req.query,
    search_focus: "internet",
    mode: "copilot",
    model_preference: "experimental",
    sources: ["web"],
    attachments: [],
    frontend_uuid: randomUUID(),
    frontend_context_uuid: randomUUID(),
    version: PERPLEXITY_OAUTH_API_VERSION,
    language: "en-US",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    search_recency_filter: req.recency ?? null,
    is_incognito: true,
    use_schematized_api: true,
    skip_search_enabled: false,
    always_search_override: true,
    prompt_source: "user",
    source: "default",
    local_search_enabled: false,
    should_ask_for_mcp_tool_confirmation: false,
    supports_tool_approval_modal: false,
    force_enable_browser_agent: false,
    is_local_browser_available: false,
    is_local_browser_allowed: false,
  };
  if (auth.type === "anonymous") {
    requestParams.send_back_text_in_streaming_api = true;
  }

  const response = await fetch(PERPLEXITY_ASK_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query_str: req.query,
      params: requestParams,
    }),
    signal: AbortSignal.timeout(PERPLEXITY_HARD_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`Perplexity ask API error (${response.status}): ${detail}`);
  }
  if (!response.body) {
    throw new Error("Perplexity ask API returned no response body");
  }
  const { response: parsed, authWall } = await parsePerplexityAskStreamDetailed(response.body, requestId);
  assertValidPerplexityAskResponse(parsed, authWall);
  if (req.limit && req.limit > 0 && parsed.sources.length > req.limit) {
    parsed.sources = parsed.sources.slice(0, req.limit);
  }
  return parsed;
}

function assertValidPerplexityAskResponse(parsed: WebSearchResponse, authWall: boolean): void {
  if (
    parsed.sources.length === 0 &&
    (authWall || !parsed.answer?.trim() || PERPLEXITY_AUTH_WALL_RE.test(parsed.answer))
  ) {
    throw new Error(
      `Perplexity ask returned no search results${parsed.answer ? `: ${parsed.answer.trim().slice(0, 120)}` : ""}`,
    );
  }
}

const PERPLEXITY_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PERPLEXITY_BROWSER_IDLE_MS = 60_000;

interface PerplexityBrowserHandle {
  browser: { isConnected(): boolean; close(): Promise<void> };
  context: { cookies(): Promise<Array<{ name: string }>>; close(): Promise<void> };
  page: {
    isClosed(): boolean;
    goto(url: string, opts: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
    waitForTimeout(ms: number): Promise<void>;
    evaluate<T, A>(fn: (arg: A) => Promise<T>, arg: A): Promise<T>;
  };
}

let perplexityBrowserHandle: PerplexityBrowserHandle | null = null;
let perplexityBrowserInitPromise: Promise<PerplexityBrowserHandle> | null = null;
let perplexityBrowserIdleTimer: ReturnType<typeof setTimeout> | null = null;
let perplexityExitHookRegistered = false;
let perplexityBrowserRunnerOverride: ((req: SearchRequest) => Promise<WebSearchResponse>) | null = null;

/** Test hook: inject a fake browser search runner without launching Chromium. */
export function setPerplexityBrowserRunnerForTest(
  runner: ((req: SearchRequest) => Promise<WebSearchResponse>) | null,
): void {
  perplexityBrowserRunnerOverride = runner;
}

function clearPerplexityBrowserIdleTimer(): void {
  if (perplexityBrowserIdleTimer) {
    clearTimeout(perplexityBrowserIdleTimer);
    perplexityBrowserIdleTimer = null;
  }
}

function schedulePerplexityBrowserClose(): void {
  clearPerplexityBrowserIdleTimer();
  perplexityBrowserIdleTimer = setTimeout(() => {
    void closePerplexityBrowser();
  }, PERPLEXITY_BROWSER_IDLE_MS);
  perplexityBrowserIdleTimer.unref?.();
}

/** Close the cached headless Chromium instance used for Perplexity browser search. */
export async function closePerplexityBrowser(): Promise<void> {
  clearPerplexityBrowserIdleTimer();
  const handle = perplexityBrowserHandle;
  perplexityBrowserHandle = null;
  if (handle) {
    await handle.context.close().catch(() => {});
    await handle.browser.close().catch(() => {});
  }
}

async function ensurePerplexityBrowserPage(): Promise<PerplexityBrowserHandle> {
  clearPerplexityBrowserIdleTimer();
  if (
    perplexityBrowserHandle &&
    perplexityBrowserHandle.browser.isConnected() &&
    !perplexityBrowserHandle.page.isClosed()
  ) {
    return perplexityBrowserHandle;
  }
  if (perplexityBrowserInitPromise) return perplexityBrowserInitPromise;

  perplexityBrowserInitPromise = (async () => {
    await closePerplexityBrowser();
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const resolved = Intl.DateTimeFormat().resolvedOptions();
      const locale = resolved.locale || "ko-KR";
      const timezoneId = resolved.timeZone || "Asia/Seoul";
      const context = await browser.newContext({
        userAgent: PERPLEXITY_BROWSER_USER_AGENT,
        locale,
        timezoneId,
      });
      const page = await context.newPage();
      await page.goto("https://www.perplexity.ai/", { waitUntil: "domcontentloaded", timeout: 30_000 });
      for (let i = 0; i < 40; i++) {
        const names = new Set((await context.cookies()).map(c => c.name));
        if (names.has("pplx.visitor-id") && names.has("pplx.edge-sid") && names.has("cf_clearance")) {
          break;
        }
        await page.waitForTimeout(200);
      }
      if (!perplexityExitHookRegistered) {
        perplexityExitHookRegistered = true;
        process.once("exit", () => {
          void closePerplexityBrowser();
        });
      }
      const handle: PerplexityBrowserHandle = { browser, context, page };
      perplexityBrowserHandle = handle;
      return handle;
    } catch (error) {
      await browser.close().catch(() => {});
      throw error;
    }
  })().finally(() => {
    perplexityBrowserInitPromise = null;
  });

  return perplexityBrowserInitPromise;
}

async function executePerplexityBrowserAsk(
  handle: PerplexityBrowserHandle,
  req: SearchRequest,
): Promise<WebSearchResponse> {
  const requestId = randomUUID();
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  const body = {
    query_str: req.query,
    params: {
      attachments: [],
      language: /[가-힣]/.test(req.query) ? "ko-KR" : (resolved.locale || "en-US"),
      timezone: resolved.timeZone || "UTC",
      search_focus: "internet",
      sources: ["web"],
      frontend_uuid: requestId,
      mode: "copilot",
      model_preference: "turbo",
      is_related_query: false,
      is_sponsored: false,
      frontend_context_uuid: randomUUID(),
      prompt_source: "user",
      query_source: "home",
      is_incognito: false,
      local_search_enabled: false,
      use_schematized_api: true,
      send_back_text_in_streaming_api: false,
      skip_search_enabled: false,
      always_search_override: true,
      search_recency_filter: req.recency ?? null,
      supported_block_use_cases: [
        "answer_modes",
        "markdown_block",
        "web_results",
        "ask_text",
        "search_result_widgets",
      ],
      version: PERPLEXITY_OAUTH_API_VERSION,
    },
  };

  const res = await handle.page.evaluate(
    async ({ bodyObj, timeoutMs }: { bodyObj: typeof body; timeoutMs: number }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch("https://www.perplexity.ai/rest/sse/perplexity_ask", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "X-Request-ID": bodyObj.params.frontend_uuid,
            "X-Perplexity-Request-Endpoint": "https://www.perplexity.ai/rest/sse/perplexity_ask",
            "X-Perplexity-Request-Reason": "ask-query-state-provider",
          },
          body: JSON.stringify(bodyObj),
          signal: controller.signal,
        });
        return { ok: response.ok, status: response.status, text: await response.text() };
      } finally {
        clearTimeout(timer);
      }
    },
    { bodyObj: body, timeoutMs: PERPLEXITY_HARD_TIMEOUT_MS },
  );

  if (!res.ok) {
    throw new Error(`Perplexity browser ask error (${res.status}): ${res.text.slice(0, 300)}`);
  }
  const { response: parsed, authWall } = await parsePerplexityAskStreamDetailed(res.text, requestId);
  assertValidPerplexityAskResponse(parsed, authWall);
  if (req.limit && req.limit > 0 && parsed.sources.length > req.limit) {
    parsed.sources = parsed.sources.slice(0, req.limit);
  }
  return parsed;
}

/** Execute a Perplexity search through a headless Playwright browser session. */
export async function searchPerplexityViaBrowser(req: SearchRequest): Promise<WebSearchResponse> {
  if (perplexityBrowserRunnerOverride) {
    return perplexityBrowserRunnerOverride(req);
  }
  const hadWarmHandle = Boolean(perplexityBrowserHandle);
  try {
    const handle = await ensurePerplexityBrowserPage();
    const res = await executePerplexityBrowserAsk(handle, req);
    schedulePerplexityBrowserClose();
    return res;
  } catch (err) {
    if (hadWarmHandle) {
      await closePerplexityBrowser();
      const freshHandle = await ensurePerplexityBrowserPage();
      try {
        const res = await executePerplexityBrowserAsk(freshHandle, req);
        schedulePerplexityBrowserClose();
        return res;
      } catch (retryErr) {
        await closePerplexityBrowser();
        throw retryErr;
      }
    }
    await closePerplexityBrowser();
    throw err;
  }
}

function shouldTryPerplexityBrowserFallback(explicit: boolean, methods: PerplexityAuthMethod[]): boolean {
  if (jeoEnv("PERPLEXITY_BROWSER") === "0") return false;
  const inTest = process.env.NODE_ENV === "test";
  if (inTest && jeoEnv("PERPLEXITY_BROWSER") !== "1" && !perplexityBrowserRunnerOverride) {
    return false;
  }
  return explicit || methods.some(m => m.type === "cookies" || m.type === "oauth");
}

async function searchPerplexity(req: SearchRequest, opts: { explicit?: boolean } = {}): Promise<WebSearchResponse> {
  const explicit = opts.explicit ?? jeoEnv("SEARCH_PROVIDER")?.toLowerCase() === "perplexity";
  const methods = await resolvePerplexityAuthMethods(explicit);
  if (methods.length === 0 && !shouldTryPerplexityBrowserFallback(explicit, methods)) {
    throw new Error(
      "Perplexity: no direct credentials (set PERPLEXITY_COOKIES, PERPLEXITY_API_KEY, or run 'jeo auth login perplexity')",
    );
  }
  let lastError: unknown;
  for (const auth of methods) {
    try {
      if (auth.type === "api_key") {
        return await callPerplexityApi(auth, req);
      }
      return await callPerplexityAsk(auth, req);
    } catch (error) {
      lastError = error;
    }
  }
  if (shouldTryPerplexityBrowserFallback(explicit, methods)) {
    try {
      return await searchPerplexityViaBrowser(req);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ── Anthropic provider (server-side web_search tool) ─────────────────────────

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";
const DEFAULT_SEARCH_MODEL = "claude-sonnet-4-6"; // haiku-4-5 dropped from jeo's exposed model list (>=4.6 only); sonnet-4-6 is the cheapest surviving Anthropic model
const DEFAULT_MAX_TOKENS = 4096;
const HARD_TIMEOUT_MS = 90_000;
const SEARCH_SYSTEM_PROMPT =
  "You are a research assistant with web search. Answer the query using web search, be concise, and ground every claim in the searched sources.";

// Claude Code OAuth request shape (mirrors src/ai/providers/anthropic.ts —
// Anthropic OAuth tokens are scoped to Claude Code-shaped requests).
const CLAUDE_CODE_SYSTEM_INSTRUCTION = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const ANTHROPIC_OAUTH_BETA = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
].join(",");

function anthropicSearchHeaders(credential: Credential): Record<string, string> {
  if (credential.kind === "oauth") {
    return {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${credential.token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": ANTHROPIC_OAUTH_BETA,
      "anthropic-dangerous-direct-browser-access": "true",
      "user-agent": `claude-cli/${getClaudeCodeVersion()} (external, cli)`,
      "x-app": "cli",
    };
  }
  return {
    "content-type": "application/json",
    accept: "application/json",
    "x-api-key": credential.kind === "api_key" ? credential.token : "",
    "anthropic-version": "2023-06-01",
  };
}

function billingHeaderBlock(systemPrompt: string): string {
  const cch = createHash("sha256").update(JSON.stringify({ system: [systemPrompt] })).digest("hex").slice(0, 5);
  const buildHash = randomBytes(2).toString("hex").slice(0, 3);
  return `x-anthropic-billing-header: cc_version=${getClaudeCodeVersion()}.${buildHash}; cc_entrypoint=cli; cch=${cch};`;
}

function anthropicSystemBlocks(credential: Credential): { type: "text"; text: string }[] {
  const blocks: { type: "text"; text: string }[] = [];
  if (credential.kind === "oauth") {
    blocks.push(
      { type: "text", text: billingHeaderBlock(SEARCH_SYSTEM_PROMPT) },
      { type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION },
    );
  }
  blocks.push({ type: "text", text: SEARCH_SYSTEM_PROMPT });
  return blocks;
}

async function resolveAnthropicSearchCredential(): Promise<Credential> {
  const dedicated = jeoEnv("SEARCH_API_KEY");
  if (dedicated) return { kind: "api_key", provider: "anthropic", token: dedicated };
  return resolveCredential("anthropic");
}

/** Parse the Anthropic Messages response (content blocks) into the unified shape. */
export function parseAnthropicSearchResponse(response: any): WebSearchResponse {
  const answerParts: string[] = [];
  const searchQueries: string[] = [];
  const sources: WebSearchSource[] = [];
  const citations: WebSearchResponse["citations"] = [];

  for (const block of response?.content ?? []) {
    if (block?.type === "server_tool_use" && typeof block.input?.query === "string") {
      searchQueries.push(block.input.query);
    } else if (block?.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const result of block.content) {
        if (result?.type === "web_search_result" && typeof result.url === "string") {
          sources.push({
            title: typeof result.title === "string" && result.title.trim() ? result.title : result.url,
            url: result.url,
            publishedDate: typeof result.page_age === "string" ? result.page_age : undefined,
          });
        }
      }
    } else if (block?.type === "text" && typeof block.text === "string") {
      answerParts.push(block.text);
      for (const c of block.citations ?? []) {
        if (typeof c?.url === "string") {
          citations.push({ url: c.url, title: c.title, citedText: c.cited_text });
        }
      }
    }
  }

  return {
    provider: "Anthropic",
    answer: answerParts.join("\n\n") || undefined,
    sources,
    citations,
    searchQueries,
    usage: response?.usage
      ? {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          searchRequests: response.usage.server_tool_use?.web_search_requests,
        }
      : undefined,
    model: typeof response?.model === "string" ? response.model : undefined,
    requestId: typeof response?.id === "string" ? response.id : undefined,
  };
}

async function searchAnthropic(req: SearchRequest): Promise<WebSearchResponse> {
  const credential = await resolveAnthropicSearchCredential();
  if (credential.kind !== "oauth" && credential.kind !== "api_key") {
    throw new Error("Anthropic: no credentials (run 'jeo auth login anthropic' or set ANTHROPIC_API_KEY / JEO_SEARCH_API_KEY)");
  }
  const effectiveQuery = req.recency ? `${req.query} (results from the last ${req.recency})` : req.query;
  const body = {
    model: jeoEnv("SEARCH_MODEL") || DEFAULT_SEARCH_MODEL,
    max_tokens: typeof req.maxTokens === "number" ? req.maxTokens : DEFAULT_MAX_TOKENS,
    system: anthropicSystemBlocks(credential),
    messages: [{ role: "user", content: effectiveQuery }],
    tools: [{ type: WEB_SEARCH_TOOL_TYPE, name: "web_search" }],
  };
  let bumpedVersion = false;
  for (;;) {
    const response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: anthropicSearchHeaders(credential),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HARD_TIMEOUT_MS),
    });
    if (response.ok) {
      const parsed = parseAnthropicSearchResponse(await response.json().catch(() => null));
      if (req.limit && req.limit > 0 && parsed.sources.length > req.limit) {
        parsed.sources = parsed.sources.slice(0, req.limit);
      }
      return parsed;
    }
    const detail = await response.text().catch(() => "");
    // Self-heal `claude_code_version_too_old`: raise the advertised Claude Code version to the
    // server's stated minimum and re-send once (mirrors postAnthropic in providers/anthropic.ts).
    const requiredVersion = parseRequiredClaudeCodeVersion(detail);
    if (!bumpedVersion && requiredVersion && raiseClaudeCodeVersion(requiredVersion)) {
      bumpedVersion = true;
      continue;
    }
    throw new Error(`Anthropic API error (${response.status}): ${detail.slice(0, 300)}`);
  }
}

// ── OpenAI provider (Responses API `web_search` hosted tool) ─────────────────

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
// Cheapest current tool-calling-capable model — the hosted `web_search` tool works
// across the whole Responses API model line (per platform.openai.com/docs/guides/
// tools-web-search), not just the now-deprecated `*-search-preview` variants.
const DEFAULT_SEARCH_MODEL_OPENAI = "gpt-4o-mini";
const OPENAI_HARD_TIMEOUT_MS = 90_000;

/** Only a real API key is trusted for the hosted `web_search` tool. The ChatGPT/Codex
 *  OAuth backend (`chatgpt.com/backend-api/codex/responses`, see openai-responses.ts) is
 *  a SEPARATE, undocumented surface never verified to support hosted Responses tools —
 *  `api.openai.com/v1/responses` with a plain Bearer API key is the documented, stable
 *  path this provider uses exclusively. */
async function resolveOpenAISearchCredential(): Promise<Credential> {
  const dedicated = jeoEnv("SEARCH_API_KEY_OPENAI");
  if (dedicated) return { kind: "api_key", provider: "openai", token: dedicated };
  const cred = await resolveCredential("openai");
  return cred.kind === "api_key" ? cred : { kind: "none", provider: "openai" };
}

/** Parse a non-streaming Responses API `web_search` result into the unified shape.
 *  Per platform.openai.com/docs/guides/tools-web-search: `output` items of type
 *  `web_search_call` carry the executed queries (`action.query`), `message` items
 *  carry `content[].text` + `annotations[]` of type `url_citation` (url/title/
 *  start_index/end_index) for inline-cited sources. */
export function parseOpenAISearchResponse(response: any): WebSearchResponse {
  const answerParts: string[] = [];
  const searchQueries: string[] = [];
  const citations: WebSearchResponse["citations"] = [];
  const sourcesByUrl = new Map<string, WebSearchSource>();

  for (const item of response?.output ?? []) {
    if (item?.type === "web_search_call" && item.action?.type === "search" && typeof item.action.query === "string") {
      searchQueries.push(item.action.query);
    } else if (item?.type === "message" && Array.isArray(item.content)) {
      for (const block of item.content) {
        if ((block?.type === "output_text" || block?.type === "text") && typeof block.text === "string") {
          const text = block.text as string;
          answerParts.push(text);
          for (const a of block.annotations ?? []) {
            if (a?.type === "url_citation" && typeof a.url === "string") {
              const citedText = typeof a.start_index === "number" && typeof a.end_index === "number"
                ? text.slice(a.start_index, a.end_index)
                : undefined;
              citations.push({ url: a.url, title: typeof a.title === "string" ? a.title : undefined, citedText });
              if (!sourcesByUrl.has(a.url)) sourcesByUrl.set(a.url, { title: (typeof a.title === "string" && a.title) || a.url, url: a.url });
            }
          }
        }
      }
    }
  }

  return {
    provider: "OpenAI",
    answer: answerParts.join("\n\n") || undefined,
    sources: [...sourcesByUrl.values()],
    citations,
    searchQueries,
    usage: response?.usage
      ? {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          searchRequests: searchQueries.length || undefined,
        }
      : undefined,
    model: typeof response?.model === "string" ? response.model : undefined,
    requestId: typeof response?.id === "string" ? response.id : undefined,
  };
}

async function searchOpenAI(req: SearchRequest): Promise<WebSearchResponse> {
  const credential = await resolveOpenAISearchCredential();
  if (credential.kind !== "api_key") {
    throw new Error("OpenAI: no API key credentials (set OPENAI_API_KEY or JEO_SEARCH_API_KEY_OPENAI — the ChatGPT/Codex subscription login does not serve the hosted web_search tool)");
  }
  const effectiveQuery = req.recency ? `${req.query} (results from the last ${req.recency})` : req.query;
  const body = {
    model: jeoEnv("SEARCH_MODEL_OPENAI") || DEFAULT_SEARCH_MODEL_OPENAI,
    tools: [{ type: "web_search" }],
    input: effectiveQuery,
  };
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential.token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(OPENAI_HARD_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`OpenAI API error (${response.status}): ${detail}`);
  }
  const parsed = parseOpenAISearchResponse(await response.json().catch(() => null));
  if (req.limit && req.limit > 0 && parsed.sources.length > req.limit) {
    parsed.sources = parsed.sources.slice(0, req.limit);
  }
  return parsed;
}

// ── Gemini provider (Grounding with Google Search, generateContent tool) ─────

const GEMINI_GENERATE_URL_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_SEARCH_MODEL_GEMINI = "gemini-2.5-flash";
const GEMINI_HARD_TIMEOUT_MS = 90_000;

/** Only a real API key is trusted. The plain `generativelanguage.googleapis.com`
 *  endpoint this hits does NOT serve Gemini/Google OAuth credentials — those are
 *  scoped to the separate Cloud Code Assist / antigravity backend (see
 *  model-manager.ts's `oauthServesModel`: a Gemini OAuth token never serves
 *  `google/gemini-*` models on its own). */
async function resolveGeminiSearchCredential(): Promise<Credential> {
  const dedicated = jeoEnv("SEARCH_API_KEY_GEMINI");
  if (dedicated) return { kind: "api_key", provider: "gemini", token: dedicated };
  const cred = await resolveCredential("gemini");
  return cred.kind === "api_key" ? cred : { kind: "none", provider: "gemini" };
}

interface GeminiGroundingChunk { web?: { uri?: string; title?: string } }
interface GeminiGroundingSupport { segment?: { startIndex?: number; endIndex?: number; text?: string }; groundingChunkIndices?: number[] }

/** Parse a `generateContent` response carrying `groundingMetadata` (Grounding with
 *  Google Search) into the unified shape. Per ai.google.dev/gemini-api/docs/google-search
 *  and the current google-genai SDK's GroundingMetadata/GroundingChunk/GroundingSupport
 *  schema (Python SDK's snake_case maps to camelCase on the classic REST wire:
 *  groundingChunks, groundingSupports, webSearchQueries, groundingChunkIndices). */
export function parseGeminiSearchResponse(response: any): WebSearchResponse {
  const candidate = response?.candidates?.[0];
  const parts: any[] = candidate?.content?.parts ?? [];
  const answer = parts.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("");
  const grounding = candidate?.groundingMetadata;
  const chunks: GeminiGroundingChunk[] = grounding?.groundingChunks ?? [];
  const sources: WebSearchSource[] = chunks
    .filter(c => !!c.web?.uri)
    .map(c => ({ title: c.web!.title || c.web!.uri!, url: c.web!.uri! }));
  const citations: WebSearchResponse["citations"] = (grounding?.groundingSupports as GeminiGroundingSupport[] | undefined ?? []).flatMap(s => {
    const text = s.segment?.text
      ?? (typeof s.segment?.startIndex === "number" && typeof s.segment?.endIndex === "number" ? answer.slice(s.segment.startIndex, s.segment.endIndex) : undefined);
    return (s.groundingChunkIndices ?? [])
      .map(i => chunks[i])
      .filter((chunk): chunk is GeminiGroundingChunk & { web: { uri: string } } => !!chunk?.web?.uri)
      .map(chunk => ({ url: chunk.web.uri, title: chunk.web.title, citedText: text }));
  });

  return {
    provider: "Gemini",
    answer: answer.trim() || undefined,
    sources,
    citations,
    searchQueries: grounding?.webSearchQueries ?? [],
    usage: response?.usageMetadata
      ? {
          inputTokens: response.usageMetadata.promptTokenCount,
          outputTokens: response.usageMetadata.candidatesTokenCount,
          searchRequests: (grounding?.webSearchQueries ?? []).length || undefined,
        }
      : undefined,
    model: typeof response?.modelVersion === "string" ? response.modelVersion : undefined,
    requestId: typeof response?.responseId === "string" ? response.responseId : undefined,
  };
}

async function searchGemini(req: SearchRequest): Promise<WebSearchResponse> {
  const credential = await resolveGeminiSearchCredential();
  if (credential.kind !== "api_key") {
    throw new Error("Gemini: no API key credentials (set GEMINI_API_KEY or JEO_SEARCH_API_KEY_GEMINI — Google/Gemini OAuth does not serve this endpoint)");
  }
  const effectiveQuery = req.recency ? `${req.query} (results from the last ${req.recency})` : req.query;
  const model = jeoEnv("SEARCH_MODEL_GEMINI") || DEFAULT_SEARCH_MODEL_GEMINI;
  const body = {
    contents: [{ role: "user", parts: [{ text: effectiveQuery }] }],
    tools: [{ googleSearch: {} }],
  };
  const response = await fetch(`${GEMINI_GENERATE_URL_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(credential.token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(GEMINI_HARD_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`Gemini API error (${response.status}): ${detail}`);
  }
  const parsed = parseGeminiSearchResponse(await response.json().catch(() => null));
  if (req.limit && req.limit > 0 && parsed.sources.length > req.limit) {
    parsed.sources = parsed.sources.slice(0, req.limit);
  }
  return parsed;
}

// ── DuckDuckGo provider (keyless terminal fallback) ────────────────

const DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";
const DDG_LITE_ENDPOINT = "https://lite.duckduckgo.com/lite/";
const DDG_DEFAULT_RESULTS = 10;
const DDG_MAX_RESULTS = 20;
const DDG_ATTEMPTS: Array<"html" | "lite"> = ["html", "lite", "html"];
const DDG_BACKOFF_MS = [0, 400, 800];
const DDG_USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
];
const DDG_RECENCY: Record<NonNullable<SearchRequest["recency"]>, string> = {
  day: "d",
  week: "w",
  month: "m",
  year: "y",
};
const DDG_FETCH_TIMEOUT_MS = 20_000;

function decodeEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&#x0*2f;/gi, "/")
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&nbsp;/g, " ");
}

function cleanText(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/** Resolve a DuckDuckGo result href to the real destination URL (drops ads/internal links). */
export function decodeResultUrl(href: string): string | null {
  let h = decodeEntities(href.trim());
  if (!h || h.startsWith("#")) return null;
  if (h.startsWith("//")) h = `https:${h}`;
  let parsed: URL;
  try {
    parsed = new URL(h, "https://duckduckgo.com");
  } catch {
    return null;
  }
  const uddg = parsed.searchParams.get("uddg");
  if (uddg) {
    try {
      const target = new URL(uddg);
      if (target.protocol !== "http:" && target.protocol !== "https:") return null;
      if (target.hostname.endsWith("duckduckgo.com")) return null;
      return target.toString();
    } catch {
      return null;
    }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.hostname.endsWith("duckduckgo.com")) return null;
  return parsed.toString();
}

/** Parse results from the `html.duckduckgo.com/html/` markup. */
export function parseHtmlResults(html: string): WebSearchSource[] {
  const titleRe = /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  for (const m of html.matchAll(snippetRe)) snippets.push(cleanText(m[1]!));
  const results: WebSearchSource[] = [];
  let idx = 0;
  for (const m of html.matchAll(titleRe)) {
    const url = decodeResultUrl(m[1]!);
    const title = cleanText(m[2]!);
    const snippet = snippets[idx];
    idx++;
    if (!url || !title) continue;
    results.push({ title, url, snippet: snippet || undefined });
  }
  return results;
}

/** Parse results from the `lite.duckduckgo.com/lite/` markup. */
export function parseLiteResults(html: string): WebSearchSource[] {
  const linkRe = /<a\b[^>]*class="[^"]*\bresult-link\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<td\b[^>]*class="[^"]*\bresult-snippet\b[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;
  const snippets: string[] = [];
  for (const m of html.matchAll(snippetRe)) snippets.push(cleanText(m[1]!));
  const results: WebSearchSource[] = [];
  let idx = 0;
  for (const m of html.matchAll(linkRe)) {
    const url = decodeResultUrl(m[1]!);
    const title = cleanText(m[2]!);
    const snippet = snippets[idx];
    idx++;
    if (!url || !title) continue;
    results.push({ title, url, snippet: snippet || undefined });
  }
  return results;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ddgFetchAndParse(endpoint: "html" | "lite", query: string, df: string | undefined, userAgent: string): Promise<WebSearchSource[]> {
  const url = endpoint === "html" ? DDG_HTML_ENDPOINT : DDG_LITE_ENDPOINT;
  const body = new URLSearchParams({ q: query });
  if (df) body.set("df", df);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml",
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept-Language": "en-US,en;q=0.9",
    },
    body,
    signal: AbortSignal.timeout(DDG_FETCH_TIMEOUT_MS),
  });
  // DuckDuckGo signals soft blocks with 202 (which is still response.ok).
  if (response.status === 202) throw new Error("duckduckgo: rate-limited (202)");
  if (!response.ok) throw new Error(`DuckDuckGo error (${response.status})`);
  const text = await response.text();
  const parsed = endpoint === "html" ? parseHtmlResults(text) : parseLiteResults(text);
  if (parsed.length === 0) throw new Error("duckduckgo: no parseable results (possible block)");
  return parsed;
}

/** Keyless DuckDuckGo search with endpoint rotation + backoff. It
 *  throws on total failure rather than returning an empty success — real
 *  results or an explicit error, never a fabricated response. */
async function searchDuckDuckGo(req: SearchRequest): Promise<WebSearchResponse> {
  const numResults = Math.min(DDG_MAX_RESULTS, Math.max(1, req.limit ?? DDG_DEFAULT_RESULTS));
  const df = req.recency ? DDG_RECENCY[req.recency] : undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < DDG_ATTEMPTS.length; attempt++) {
    if (DDG_BACKOFF_MS[attempt]! > 0) await delay(DDG_BACKOFF_MS[attempt]!);
    try {
      const parsed = await ddgFetchAndParse(
        DDG_ATTEMPTS[attempt]!,
        req.query,
        df,
        DDG_USER_AGENTS[attempt % DDG_USER_AGENTS.length]!,
      );
      return {
        provider: "DuckDuckGo",
        sources: parsed.slice(0, numResults),
        citations: [],
        searchQueries: [],
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `DuckDuckGo search failed after ${DDG_ATTEMPTS.length} attempts${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
  );
}

// ── Provider chain ──────────────────────

const PROVIDERS: Record<SearchProviderDef["id"], SearchProviderDef> = {
  perplexity: {
    id: "perplexity",
    label: "Perplexity",
    isAvailable: async () => (await resolvePerplexityAuthMethods(false)).length > 0,
    search: req => searchPerplexity(req),
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    isAvailable: async () => {
      if (jeoEnv("SEARCH_API_KEY")) return true;
      const cred = await resolveCredential("anthropic").catch(() => null);
      return cred?.kind === "oauth" || cred?.kind === "api_key";
    },
    search: searchAnthropic,
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    isAvailable: async () => {
      if (jeoEnv("SEARCH_API_KEY_OPENAI")) return true;
      const cred = await resolveCredential("openai").catch(() => null);
      return cred?.kind === "api_key";
    },
    search: searchOpenAI,
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    isAvailable: async () => {
      if (jeoEnv("SEARCH_API_KEY_GEMINI")) return true;
      const cred = await resolveCredential("gemini").catch(() => null);
      return cred?.kind === "api_key";
    },
    search: searchGemini,
  },
  duckduckgo: {
    id: "duckduckgo",
    label: "DuckDuckGo",
    isAvailable: () => true,
    search: searchDuckDuckGo,
  },
};

/** Maps the active model provider to its native search provider.
 *  Providers without a jeo-native search implementation fall through to DuckDuckGo. */
const MODEL_PROVIDER_TO_SEARCH: Record<string, SearchProviderDef["id"]> = {
  anthropic: "anthropic",
  openai: "openai",
  gemini: "gemini",
  // antigravity sessions route to Google's OWN native search when a plain
  // GEMINI_API_KEY also happens to be configured — the antigravity OAuth
  // credential itself never qualifies (see resolveGeminiSearchCredential),
  // so this never silently scans an unrelated provider's credentials.
  antigravity: "gemini",
};

let activeModelHint: string | undefined;

/** Called by the agent loop with the session's active model id, so the chain is
 *  active-model-gated (never credential-scanning across providers). */
export function setWebSearchActiveModel(model: string | undefined): void {
  activeModelHint = model;
}

async function activeModelProviderName(): Promise<string | undefined> {
  let model = activeModelHint;
  if (!model) {
    try {
      const { readGlobalConfig } = await import("./state");
      model = (await readGlobalConfig()).defaultModel;
    } catch {
      return undefined;
    }
  }
  if (!model) return undefined;
  try {
    const { resolveProvider } = await import("../ai/model-manager");
    return resolveProvider(model);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the ordered provider chain for a search request:
 * explicit preferred provider (when available) → active model's native search
 * (when ITS credentials exist) → DuckDuckGo as the always-on terminal fallback.
 */
export async function resolveSearchChain(opts: { preferred?: string; modelProvider?: string } = {}): Promise<SearchProviderDef[]> {
  const chain: SearchProviderDef[] = [];
  const preferred = (opts.preferred ?? jeoEnv("SEARCH_PROVIDER"))?.toLowerCase();

  if (preferred === "perplexity") {
    chain.push({
      ...PROVIDERS.perplexity,
      search: req => searchPerplexity(req, { explicit: true }),
    });
  } else if (preferred && preferred !== "auto") {
    const provider = PROVIDERS[preferred as SearchProviderDef["id"]];
    if (provider && (await provider.isAvailable())) chain.push(provider);
  } else {
    if (await PROVIDERS.perplexity.isAvailable()) {
      chain.push({
        ...PROVIDERS.perplexity,
        search: req => searchPerplexity(req, { explicit: false }),
      });
    }
    const modelProvider = (opts.modelProvider ?? (await activeModelProviderName()))?.toLowerCase();
    const nativeId = modelProvider ? MODEL_PROVIDER_TO_SEARCH[modelProvider] : undefined;
    const provider = nativeId ? PROVIDERS[nativeId] : undefined;
    if (provider && (await provider.isAvailable())) chain.push(provider);
  }
  if (!chain.some(p => p.id === "duckduckgo")) chain.push(PROVIDERS.duckduckgo);
  return chain;
}

// ── Output formatting (LLM text + TUI card source) ───────────────────────────

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Format the unified response as structured text. This single string serves
 * BOTH consumers: the LLM (sectioned answer + numbered sources/citations) and
 * the TUI card renderer, which splits it back into the
 * Query / Answer / Sources / Metadata card sections.
 */
export function formatWebSearchOutput(query: string, r: WebSearchResponse): string {
  const parts: string[] = [`Query: ${query}`];

  parts.push("", "## Answer", r.answer?.trim() || "No synthesized answer (see sources)");

  parts.push("", `## Sources (${r.sources.length})`);
  if (r.sources.length === 0) parts.push("No sources returned");
  for (const [i, src] of r.sources.entries()) {
    const domain = hostnameOf(src.url);
    const meta = [domain ? `(${domain})` : "", src.publishedDate ?? ""].filter(Boolean).join(" · ");
    parts.push(`[${i + 1}] ${src.title}${meta ? ` ${meta}` : ""}`, `    ${src.url}`);
    if (src.snippet) {
      const snippet = src.snippet.length > 240 ? `${src.snippet.slice(0, 239)}…` : src.snippet;
      parts.push(`    - ${snippet}`);
    }
  }

  if (r.citations.length > 0) {
    parts.push("", `## Citations (${r.citations.length})`);
    for (const [i, c] of r.citations.entries()) {
      parts.push(`[${i + 1}] ${c.title || c.url}`, `    ${c.url}`);
      if (c.citedText) {
        const cited = c.citedText.length > 240 ? `${c.citedText.slice(0, 239)}…` : c.citedText;
        parts.push(`    "${cited.replace(/\s+/g, " ").trim()}"`);
      }
    }
  }

  parts.push("", "## Metadata", `Provider: ${r.provider}`);
  if (r.model) parts.push(`Model: ${r.model}`);
  parts.push(`Sources: ${r.sources.length}`);
  if (r.citations.length > 0) parts.push(`Citations: ${r.citations.length}`);
  if (r.usage) {
    const usage: string[] = [];
    if (r.usage.inputTokens !== undefined) usage.push(`in ${r.usage.inputTokens}`);
    if (r.usage.outputTokens !== undefined) usage.push(`out ${r.usage.outputTokens}`);
    if (r.usage.searchRequests !== undefined) usage.push(`search ${r.usage.searchRequests}`);
    if (usage.length > 0) parts.push(`Usage: ${usage.join(" · ")}`);
  }
  if (r.requestId) parts.push(`Request: ${r.requestId}`);
  if (r.searchQueries.length > 0) parts.push(`Queries: ${r.searchQueries.slice(0, 3).join("; ")}`);

  return parts.join("\n");
}

// ── Tool entrypoint ──────────────────────────────────────────────────────────

/** Execute one web search through the provider chain. Exported for the engine toolset. */
export async function webSearchTool(args: Record<string, any>, _cwd: string = process.cwd()): Promise<ToolResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return { success: false, output: "", error: "web_search requires a non-empty {query}." };

  const req: SearchRequest = {
    query,
    recency: typeof args.recency === "string" && args.recency in DDG_RECENCY ? (args.recency as SearchRequest["recency"]) : undefined,
    limit: typeof args.limit === "number" && args.limit > 0 ? args.limit : undefined,
    maxTokens: typeof args.maxTokens === "number" ? args.maxTokens : undefined,
  };

  const chain = await resolveSearchChain();
  const failures: string[] = [];
  for (const provider of chain) {
    try {
      const response = await provider.search(req);
      return { success: true, output: formatWebSearchOutput(query, response) };
    } catch (err: any) {
      failures.push(`${provider.label}: ${err?.message || String(err)}`);
    }
  }
  return {
    success: false,
    output: "",
    error: `web_search failed across all providers — ${failures.join("; ")}`,
  };
}
