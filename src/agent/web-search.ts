/**
 * web_search — provider-chain web search (gjc parity).
 *
 * Mirrors gjc's `web/search` design instead of hardcoding one backend:
 *
 *   1. An explicitly preferred provider (`JEO_SEARCH_PROVIDER`) that is
 *      available is primary.
 *   2. Otherwise the ACTIVE MODEL's own native search provider is primary,
 *      but only when that provider's credentials are present (active-model
 *      gating — never credential scanning). Today that maps Anthropic models
 *      to Anthropic's server-side `web_search_20250305` tool.
 *   3. DuckDuckGo (keyless HTML scraping, no API key, no OAuth) is ALWAYS
 *      appended as the terminal fallback, so a missing/failed primary still
 *      returns real results with zero configuration — results are always
 *      live provider data, never canned.
 *
 * Providers are tried in order; a runtime failure fails over to the next.
 * The structured text output doubles as the source for the TUI's gjc-style
 * Web Search card (Query / Answer / Sources / Metadata sections — see
 * `webSearchCardLines` in tui/components/forge.ts).
 */
import { createHash, randomBytes } from "node:crypto";
import { resolveCredential, type Credential } from "../auth";
import { jeoEnv } from "../util/env";
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
}

export interface SearchRequest {
  query: string;
  recency?: "day" | "week" | "month" | "year";
  limit?: number;
  maxTokens?: number;
}

export interface SearchProviderDef {
  id: "anthropic" | "duckduckgo";
  label: string;
  /** Credential gate — keyless providers return true unconditionally. */
  isAvailable(): Promise<boolean> | boolean;
  /** Throws on failure; the chain runner fails over to the next provider. */
  search(req: SearchRequest): Promise<WebSearchResponse>;
}

// ── Anthropic provider (server-side web_search tool) ─────────────────────────

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";
const DEFAULT_SEARCH_MODEL = "claude-haiku-4-5";
const DEFAULT_MAX_TOKENS = 4096;
const HARD_TIMEOUT_MS = 90_000;
const SEARCH_SYSTEM_PROMPT =
  "You are a research assistant with web search. Answer the query using web search, be concise, and ground every claim in the searched sources.";

// Claude Code OAuth request shape (mirrors src/ai/providers/anthropic.ts —
// Anthropic OAuth tokens are scoped to Claude Code-shaped requests).
const CLAUDE_CODE_VERSION = "2.1.63";
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
      "user-agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
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
  return `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${buildHash}; cc_entrypoint=cli; cch=${cch};`;
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
  const response = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: anthropicSearchHeaders(credential),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HARD_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`Anthropic API error (${response.status}): ${detail}`);
  }
  const parsed = parseAnthropicSearchResponse(await response.json().catch(() => null));
  if (req.limit && req.limit > 0 && parsed.sources.length > req.limit) {
    parsed.sources = parsed.sources.slice(0, req.limit);
  }
  return parsed;
}

// ── DuckDuckGo provider (keyless terminal fallback; gjc port) ────────────────

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

/** Keyless DuckDuckGo search with endpoint rotation + backoff (gjc port). It
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

// ── Provider chain (gjc resolveProviderChain semantics) ──────────────────────

const PROVIDERS: Record<SearchProviderDef["id"], SearchProviderDef> = {
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
  duckduckgo: {
    id: "duckduckgo",
    label: "DuckDuckGo",
    isAvailable: () => true,
    search: searchDuckDuckGo,
  },
};

/** Active model provider → its native search provider (gjc MODEL_PROVIDER_TO_SEARCH).
 *  Providers without a jeo-native search implementation fall through to DuckDuckGo. */
const MODEL_PROVIDER_TO_SEARCH: Record<string, SearchProviderDef["id"]> = {
  anthropic: "anthropic",
};

let activeModelHint: string | undefined;

/** Called by the agent loop with the session's active model id, so the chain is
 *  active-model-gated like gjc (never credential-scanning across providers). */
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
 * Resolve the ordered provider chain for a search request (gjc semantics):
 * explicit preferred provider (when available) → active model's native search
 * (when ITS credentials exist) → DuckDuckGo as the always-on terminal fallback.
 */
export async function resolveSearchChain(opts: { preferred?: string; modelProvider?: string } = {}): Promise<SearchProviderDef[]> {
  const chain: SearchProviderDef[] = [];
  const preferred = (opts.preferred ?? jeoEnv("SEARCH_PROVIDER"))?.toLowerCase();

  if (preferred && preferred !== "auto") {
    const provider = PROVIDERS[preferred as SearchProviderDef["id"]];
    if (provider && (await provider.isAvailable())) chain.push(provider);
  } else {
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
 * the TUI card renderer, which splits it back into the gjc-style
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
