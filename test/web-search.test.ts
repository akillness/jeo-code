import { test, expect } from "bun:test";
import {
  resolveSearchChain,
  setWebSearchActiveModel,
  webSearchTool,
  parseAnthropicSearchResponse,
  parseOpenAISearchResponse,
  parseGeminiSearchResponse,
  parsePerplexityApiResponse,
  parsePerplexityAskEvents,
  parsePerplexityAskStream,
  jwtExpiryMs,
  formatWebSearchOutput,
  parseHtmlResults,
  parseLiteResults,
  decodeResultUrl,
} from "../src/agent/web-search";
import { webSearchCardLines } from "../src/tui/components/forge";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const SEARCH_ENV_KEYS = [
  "JEO_SEARCH_PROVIDER",
  "JEO_SEARCH_API_KEY", "JEO_SEARCH_MODEL",
  "JEO_SEARCH_API_KEY_OPENAI", "JEO_SEARCH_MODEL_OPENAI",
  "JEO_SEARCH_API_KEY_GEMINI", "JEO_SEARCH_MODEL_GEMINI",
  "PERPLEXITY_COOKIES", "PERPLEXITY_API_KEY", "PPLX_API_KEY",
  "PERPLEXITY_OAUTH_TOKEN", "JEO_SEARCH_API_KEY_PERPLEXITY",
  "JEO_SEARCH_MODEL_PERPLEXITY", "OPENROUTER_API_KEY", "JEO_AUTH_NO_BORROW",
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY",
];

function withSearchEnv(env: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map(SEARCH_ENV_KEYS.map(k => [k, process.env[k]] as const));
  const hadConfigDir = "JEO_CONFIG_DIR" in process.env;
  const savedConfigDir = process.env.JEO_CONFIG_DIR;
  for (const k of SEARCH_ENV_KEYS) delete process.env[k];
  process.env.JEO_AUTH_NO_BORROW = "1";
  if (!process.env.JEO_CONFIG_DIR) {
    process.env.JEO_CONFIG_DIR = path.join(os.tmpdir(), "jeo-web-search-empty-config");
  }
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return fn().finally(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (!hadConfigDir) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = savedConfigDir;
  });
}

// ── Provider chain resolution (never hardcoded to one backend) ──

test("resolveSearchChain: DuckDuckGo is ALWAYS the terminal fallback", async () => {
  await withSearchEnv({}, async () => {
    // Unknown model provider, no preference → keyless DuckDuckGo only.
    const chain = await resolveSearchChain({ modelProvider: "ollama" });
    expect(chain.map(p => p.id)).toEqual(["duckduckgo"]);
  });
});

test("resolveSearchChain: active anthropic model + credentials → anthropic primary, ddg fallback", async () => {
  await withSearchEnv({ JEO_SEARCH_API_KEY: "sk-test" }, async () => {
    const chain = await resolveSearchChain({ modelProvider: "anthropic" });
    expect(chain.map(p => p.id)).toEqual(["anthropic", "duckduckgo"]);
  });
});

test("resolveSearchChain: a native provider without ITS OWN credentials falls through to ddg (never borrows another provider's key)", async () => {
  await withSearchEnv({ JEO_SEARCH_API_KEY: "sk-test" }, async () => {
    // JEO_SEARCH_API_KEY is Anthropic-scoped only — a gemini-model session does
    // NOT silently borrow it (gemini has its OWN native search, but gated on
    // its OWN credential, JEO_SEARCH_API_KEY_GEMINI or a real Gemini API key).
    const chain = await resolveSearchChain({ modelProvider: "gemini" });
    expect(chain.map(p => p.id)).toEqual(["duckduckgo"]);
  });
});

test("resolveSearchChain: active openai model + ITS OWN credentials → openai primary, ddg fallback", async () => {
  await withSearchEnv({ JEO_SEARCH_API_KEY_OPENAI: "sk-test-openai" }, async () => {
    const chain = await resolveSearchChain({ modelProvider: "openai" });
    expect(chain.map(p => p.id)).toEqual(["openai", "duckduckgo"]);
  });
});

test("resolveSearchChain: active gemini model + ITS OWN credentials → gemini primary, ddg fallback", async () => {
  await withSearchEnv({ JEO_SEARCH_API_KEY_GEMINI: "sk-test-gemini" }, async () => {
    const chain = await resolveSearchChain({ modelProvider: "gemini" });
    expect(chain.map(p => p.id)).toEqual(["gemini", "duckduckgo"]);
  });
});

test("resolveSearchChain: antigravity sessions route to Gemini's native search, never to its own OAuth", async () => {
  await withSearchEnv({ JEO_SEARCH_API_KEY_GEMINI: "sk-test-gemini" }, async () => {
    const chain = await resolveSearchChain({ modelProvider: "antigravity" });
    expect(chain.map(p => p.id)).toEqual(["gemini", "duckduckgo"]);
  });
  // Without a real GEMINI_API_KEY, an antigravity session's own (OAuth) credentials
  // never qualify — antigravity has no native search of its own.
  await withSearchEnv({}, async () => {
    const chain = await resolveSearchChain({ modelProvider: "antigravity" });
    expect(chain.map(p => p.id)).toEqual(["duckduckgo"]);
  });
});

test("resolveSearchChain: explicit JEO_SEARCH_PROVIDER override wins over the model gate", async () => {
  await withSearchEnv({ JEO_SEARCH_PROVIDER: "anthropic", JEO_SEARCH_API_KEY: "sk-test" }, async () => {
    const chain = await resolveSearchChain({ modelProvider: "gemini" });
    expect(chain.map(p => p.id)).toEqual(["anthropic", "duckduckgo"]);
  });
});

test("resolveSearchChain: preferred provider without credentials is skipped (no dead primary)", async () => {
  await withSearchEnv({ JEO_SEARCH_PROVIDER: "duckduckgo" }, async () => {
    const chain = await resolveSearchChain({ modelProvider: "anthropic" });
    expect(chain.map(p => p.id)).toEqual(["duckduckgo"]);
  });
});

// ── DuckDuckGo parsers (live-HTML shape pinned by fixtures) ─────────

const DDG_HTML_FIXTURE = `
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpost&amp;rut=abc">Example <b>Title</b></a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpost">A short &amp; sweet snippet.</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="https://direct.example.org/page">Direct Link</a>
  <a class="result__snippet" href="https://direct.example.org/page">Second snippet</a>
</div>`;

const DDG_LITE_FIXTURE = `
<tr><td><a rel="nofollow" class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flite.example.com%2Fa">Lite Result</a></td></tr>
<tr><td class="result-snippet">Lite snippet text</td></tr>`;

test("parseHtmlResults: unwraps uddg redirects, decodes entities, pairs snippets", () => {
  const results = parseHtmlResults(DDG_HTML_FIXTURE);
  expect(results).toEqual([
    { title: "Example Title", url: "https://example.com/post", snippet: "A short & sweet snippet." },
    { title: "Direct Link", url: "https://direct.example.org/page", snippet: "Second snippet" },
  ]);
});

test("parseLiteResults: parses the lite endpoint markup", () => {
  const results = parseLiteResults(DDG_LITE_FIXTURE);
  expect(results).toEqual([{ title: "Lite Result", url: "https://lite.example.com/a", snippet: "Lite snippet text" }]);
});

test("decodeResultUrl: drops internal/unsafe links, unwraps redirects", () => {
  expect(decodeResultUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com%2Fx")).toBe("https://a.com/x");
  expect(decodeResultUrl("https://duckduckgo.com/about")).toBeNull();   // internal
  expect(decodeResultUrl("javascript:alert(1)")).toBeNull();            // unsafe protocol
  expect(decodeResultUrl("#")).toBeNull();
  expect(decodeResultUrl("//duckduckgo.com/l/?uddg=javascript%3Aalert(1)")).toBeNull();
});

// ── Anthropic response parsing + output formatting ────────────────────────────

const ANTHROPIC_FIXTURE = {
  id: "msg_01TEST",
  model: "claude-haiku-4-5-20251001",
  usage: { input_tokens: 2537, output_tokens: 1093, server_tool_use: { web_search_requests: 2 } },
  content: [
    { type: "server_tool_use", name: "web_search", input: { query: "hermes agent philosophy" } },
    {
      type: "web_search_tool_result",
      content: [
        { type: "web_search_result", title: "Hermes Agent | AI Native Landscape", url: "https://jimmysong.io/ai/hermes-agent/", page_age: "April 6, 2026" },
        { type: "web_search_result", title: "Hermes Agent Documentation", url: "https://hermes-agent.nousresearch.com/docs/" },
      ],
    },
    {
      type: "text",
      text: "Hermes Agent is a self-improving AI agent built by Nous Research.",
      citations: [{ url: "https://jimmysong.io/ai/hermes-agent/", title: "Hermes Agent", cited_text: "self-improving AI agent" }],
    },
  ],
};

test("parseAnthropicSearchResponse: maps content blocks into the unified shape", () => {
  const r = parseAnthropicSearchResponse(ANTHROPIC_FIXTURE);
  expect(r.provider).toBe("Anthropic");
  expect(r.answer).toContain("self-improving AI agent");
  expect(r.sources.length).toBe(2);
  expect(r.sources[0]).toEqual({
    title: "Hermes Agent | AI Native Landscape",
    url: "https://jimmysong.io/ai/hermes-agent/",
    publishedDate: "April 6, 2026",
  });
  expect(r.citations.length).toBe(1);
  expect(r.searchQueries).toEqual(["hermes agent philosophy"]);
  expect(r.usage).toEqual({ inputTokens: 2537, outputTokens: 1093, searchRequests: 2 });
  expect(r.model).toBe("claude-haiku-4-5-20251001");
  expect(r.requestId).toBe("msg_01TEST");
});

test("formatWebSearchOutput: gjc card sections with a DYNAMIC provider label", () => {
  const out = formatWebSearchOutput("hermes", parseAnthropicSearchResponse(ANTHROPIC_FIXTURE));
  expect(out.startsWith("Query: hermes")).toBe(true);
  expect(out).toContain("## Answer");
  expect(out).toContain("## Sources (2)");
  expect(out).toContain("(jimmysong.io) · April 6, 2026");
  expect(out).toContain("## Citations (1)");
  expect(out).toContain("Provider: Anthropic");
  expect(out).toContain("Usage: in 2537 · out 1093 · search 2");
  expect(out).toContain("Request: msg_01TEST");
  expect(out).toContain("Queries: hermes agent philosophy");

  // A DuckDuckGo response carries ITS label — never hardcoded to Anthropic.
  const ddg = formatWebSearchOutput("q", {
    provider: "DuckDuckGo",
    sources: [{ title: "T", url: "https://t.example/x", snippet: "snip" }],
    citations: [],
    searchQueries: [],
  });
  expect(ddg).toContain("Provider: DuckDuckGo");
  expect(ddg).toContain("No synthesized answer (see sources)");
  expect(ddg).toContain("- snip");
});
// ── OpenAI response parsing + live request shape ──────────────────────────────

const OPENAI_FIXTURE = {
  id: "resp_01TEST",
  model: "gpt-4o-mini",
  usage: { input_tokens: 14, output_tokens: 62 },
  output: [
    { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "hermes agent philosophy" } },
    {
      id: "msg_1",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "Hermes Agent is a self-improving AI agent built by Nous Research.",
          annotations: [
            { type: "url_citation", start_index: 0, end_index: 12, url: "https://jimmysong.io/ai/hermes-agent/", title: "Hermes Agent | AI Native Landscape" },
          ],
        },
      ],
    },
  ],
};

test("parseOpenAISearchResponse: maps Responses API output items into the unified shape", () => {
  const r = parseOpenAISearchResponse(OPENAI_FIXTURE);
  expect(r.provider).toBe("OpenAI");
  expect(r.answer).toContain("self-improving AI agent");
  expect(r.sources).toEqual([{ title: "Hermes Agent | AI Native Landscape", url: "https://jimmysong.io/ai/hermes-agent/" }]);
  expect(r.citations).toEqual([{ url: "https://jimmysong.io/ai/hermes-agent/", title: "Hermes Agent | AI Native Landscape", citedText: "Hermes Agent" }]);
  expect(r.searchQueries).toEqual(["hermes agent philosophy"]);
  expect(r.usage).toEqual({ inputTokens: 14, outputTokens: 62, searchRequests: 1 });
  expect(r.model).toBe("gpt-4o-mini");
  expect(r.requestId).toBe("resp_01TEST");
});

test("webSearchTool: openai provider hits the real Responses API endpoint with the web_search tool", async () => {
  await withSearchEnv({ JEO_SEARCH_PROVIDER: "openai", JEO_SEARCH_API_KEY_OPENAI: "sk-openai-test" }, async () => {
    const realFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;
    globalThis.fetch = (async (input: any, init?: any) => {
      capturedUrl = String(typeof input === "string" ? input : input?.url ?? input);
      capturedHeaders = init?.headers ?? {};
      capturedBody = JSON.parse(init?.body ?? "{}");
      return new Response(JSON.stringify(OPENAI_FIXTURE), { status: 200 });
    }) as typeof fetch;
    try {
      const res = await webSearchTool({ query: "hermes agent philosophy" });
      expect(res.success).toBe(true);
      expect(res.output).toContain("Provider: OpenAI");
      expect(capturedUrl).toBe("https://api.openai.com/v1/responses");
      expect(capturedHeaders.authorization).toBe("Bearer sk-openai-test");
      expect(capturedBody.tools).toEqual([{ type: "web_search" }]);
      expect(capturedBody.input).toBe("hermes agent philosophy");
      expect(capturedBody.model).toBe("gpt-4o-mini");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("webSearchTool: openai without a real API key skips straight to DuckDuckGo (Codex OAuth never qualifies)", async () => {
  await withSearchEnv({ JEO_SEARCH_PROVIDER: "openai" }, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      if (url.includes("duckduckgo.com")) return new Response(DDG_HTML_FIXTURE, { status: 200 });
      throw new Error(`unexpected fetch (openai should have been skipped): ${url}`);
    }) as typeof fetch;
    try {
      const res = await webSearchTool({ query: "no key set" });
      expect(res.success).toBe(true);
      expect(res.output).toContain("Provider: DuckDuckGo");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ── Gemini response parsing + live request shape ───────────────────────────────

const GEMINI_FIXTURE = {
  modelVersion: "gemini-2.5-flash-002",
  responseId: "resp_gemini_1",
  usageMetadata: { promptTokenCount: 21, candidatesTokenCount: 47 },
  candidates: [
    {
      content: { parts: [{ text: "Hermes Agent is a self-improving AI agent built by Nous Research." }] },
      groundingMetadata: {
        webSearchQueries: ["hermes agent philosophy"],
        groundingChunks: [
          { web: { uri: "https://jimmysong.io/ai/hermes-agent/", title: "Hermes Agent | AI Native Landscape" } },
        ],
        groundingSupports: [
          { segment: { startIndex: 0, endIndex: 12, text: "Hermes Agent" }, groundingChunkIndices: [0] },
        ],
      },
    },
  ],
};

test("parseGeminiSearchResponse: maps groundingMetadata into the unified shape", () => {
  const r = parseGeminiSearchResponse(GEMINI_FIXTURE);
  expect(r.provider).toBe("Gemini");
  expect(r.answer).toContain("self-improving AI agent");
  expect(r.sources).toEqual([{ title: "Hermes Agent | AI Native Landscape", url: "https://jimmysong.io/ai/hermes-agent/" }]);
  expect(r.citations).toEqual([{ url: "https://jimmysong.io/ai/hermes-agent/", title: "Hermes Agent | AI Native Landscape", citedText: "Hermes Agent" }]);
  expect(r.searchQueries).toEqual(["hermes agent philosophy"]);
  expect(r.usage).toEqual({ inputTokens: 21, outputTokens: 47, searchRequests: 1 });
  expect(r.model).toBe("gemini-2.5-flash-002");
  expect(r.requestId).toBe("resp_gemini_1");
});

test("webSearchTool: gemini provider hits generateContent with the googleSearch grounding tool", async () => {
  await withSearchEnv({ JEO_SEARCH_PROVIDER: "gemini", JEO_SEARCH_API_KEY_GEMINI: "sk-gemini-test" }, async () => {
    const realFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedBody: any = null;
    globalThis.fetch = (async (input: any, init?: any) => {
      capturedUrl = String(typeof input === "string" ? input : input?.url ?? input);
      capturedBody = JSON.parse(init?.body ?? "{}");
      return new Response(JSON.stringify(GEMINI_FIXTURE), { status: 200 });
    }) as typeof fetch;
    try {
      const res = await webSearchTool({ query: "hermes agent philosophy" });
      expect(res.success).toBe(true);
      expect(res.output).toContain("Provider: Gemini");
      expect(capturedUrl).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=sk-gemini-test");
      expect(capturedBody.tools).toEqual([{ googleSearch: {} }]);
      expect(capturedBody.contents).toEqual([{ role: "user", parts: [{ text: "hermes agent philosophy" }] }]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("webSearchTool: gemini without a real API key skips straight to DuckDuckGo (Google OAuth never qualifies)", async () => {
  await withSearchEnv({ JEO_SEARCH_PROVIDER: "gemini" }, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      if (url.includes("duckduckgo.com")) return new Response(DDG_HTML_FIXTURE, { status: 200 });
      throw new Error(`unexpected fetch (gemini should have been skipped): ${url}`);
    }) as typeof fetch;
    try {
      const res = await webSearchTool({ query: "no key set" });
      expect(res.success).toBe(true);
      expect(res.output).toContain("Provider: DuckDuckGo");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ── Anthropic OAuth identity: Claude Code minimum-version gate ────────────────
// Live OAuth probe: Opus 5.5 answered HTTP 400 `claude_code_version_too_old: version 2.1.280
// minimum` while older models were served, because the OAuth cloak advertised 2.1.63. web_search
// keeps its OWN copy of that cloak (it does not import the adapter's), so it can drift on its own.
// The floor below is the SERVER's minimum, not "whatever we ship today": the test pins >= floor and
// User-Agent/billing agreement, never the exact current version, so bumping the constant stays
// green and regressing below the floor turns it red. Hermetic: fake OAuth token in a throwaway
// config dir, stubbed fetch, no network.
const MIN_CLAUDE_CODE_VERSION = "2.1.280";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const SEARCH_OPUS_5_5_IDS = ["claude-opus-5-5", "claude-opus-5-5-20261001"];
// Env that could swap the OAuth credential for an API key or add a second OAuth source.
const OAUTH_SANDBOX_ENV = ["JEO_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

/** Numeric, component-wise compare. NEVER string-compare: "2.1.63" > "2.1.280" lexicographically. */
function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The two places the OAuth cloak states a Claude Code version: User-Agent and the billing system block. */
function advertisedVersions(headers: Record<string, string>, system: { text: string }[] | undefined): { userAgent?: string; billing?: string } {
  return {
    userAgent: /^claude-cli\/(\d+\.\d+\.\d+)(?:\s|$)/.exec(headers["user-agent"] ?? "")?.[1],
    billing: /cc_version=(\d+\.\d+\.\d+)(?:\.[0-9a-f]+)?;/.exec(system?.[0]?.text ?? "")?.[1],
  };
}

interface SearchWireCall {
  url: string;
  headers: Record<string, string>;
  body: { model?: string; system?: { text: string }[] };
}

/** Runs `run` with Anthropic OAuth as the only credential, JEO_SEARCH_MODEL=`model`, and a fetch
 *  stub that emulates the live server gate: HTTP 400 `claude_code_version_too_old` when EITHER
 *  advertised version is missing or below the floor, otherwise the search fixture echoing the
 *  requested model. Every outbound request is recorded in `calls`. */
async function withAnthropicOauthSearch(model: string, run: (calls: SearchWireCall[]) => Promise<void>): Promise<void> {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-web-search-oauth-"));
  const savedEnv = new Map(OAUTH_SANDBOX_ENV.map(k => [k, process.env[k]] as const));
  const realFetch = globalThis.fetch;
  const calls: SearchWireCall[] = [];
  try {
    for (const k of OAUTH_SANDBOX_ENV) delete process.env[k];
    await fs.writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({ providers: {}, oauth: { anthropic: { access: "test-oauth-access" } }, defaultModel: "claude-sonnet-4-6" }),
      "utf-8",
    );
    process.env.JEO_CONFIG_DIR = configDir;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const call: SearchWireCall = {
        url: String(input instanceof Request ? input.url : input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : {},
      };
      calls.push(call);
      if (call.url !== ANTHROPIC_MESSAGES_URL) return new Response("unexpected fetch", { status: 403 });
      const { userAgent, billing } = advertisedVersions(call.headers, call.body.system);
      const tooOld = [userAgent, billing].some(v => v === undefined || compareVersions(v, MIN_CLAUDE_CODE_VERSION) < 0);
      if (tooOld) {
        return new Response(
          JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `claude_code_version_too_old: version ${MIN_CLAUDE_CODE_VERSION} minimum` } }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ...ANTHROPIC_FIXTURE, model: call.body.model }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    await withSearchEnv({ JEO_SEARCH_PROVIDER: "anthropic", JEO_SEARCH_MODEL: model }, () => run(calls));
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fs.rm(configDir, { recursive: true, force: true });
  }
}

for (const model of SEARCH_OPUS_5_5_IDS) {
  test(`webSearchTool: Anthropic OAuth search with JEO_SEARCH_MODEL=${model} sends that exact model and one agreeing Claude Code version >= ${MIN_CLAUDE_CODE_VERSION} in User-Agent and billing header (one fetch, accepted)`, async () => {
    await withAnthropicOauthSearch(model, async calls => {
      const query = "hermes agent philosophy";
      const res = await webSearchTool({ query });

      // A version rejection is not recoverable by retrying: the only passing shape is ONE accepted
      // Anthropic fetch — no failover to DuckDuckGo masking a gate failure.
      expect({ success: res.success, error: res.error, urls: calls.map(c => c.url) }).toEqual({
        success: true,
        error: undefined,
        urls: [ANTHROPIC_MESSAGES_URL],
      });

      const sent = calls[0]!;
      expect(sent.body.model).toBe(model);
      expect(sent.headers.authorization).toBe("Bearer test-oauth-access");

      const { userAgent, billing } = advertisedVersions(sent.headers, sent.body.system);
      // Both must parse AND be equal; two `undefined`s must not pass vacuously.
      expect(userAgent).toBeDefined();
      expect(billing).toBe(userAgent);
      expect(compareVersions(userAgent!, MIN_CLAUDE_CODE_VERSION)).toBeGreaterThanOrEqual(0);

      // Response shape preserved end to end: the tool returns the server answer, formatted unchanged.
      expect(res.output).toBe(formatWebSearchOutput(query, parseAnthropicSearchResponse({ ...ANTHROPIC_FIXTURE, model })));
    });
  });
}

// ── Runtime failover through the chain (real fetch path, mocked transport) ────

test("webSearchTool: primary provider failure fails over to DuckDuckGo (live data, not mock)", async () => {
  await withSearchEnv({ JEO_SEARCH_PROVIDER: "anthropic", JEO_SEARCH_API_KEY: "sk-test" }, async () => {
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: any, _init?: any) => {
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      urls.push(url);
      if (url.includes("api.anthropic.com")) {
        return new Response("overloaded", { status: 529 });
      }
      if (url.includes("duckduckgo.com")) {
        return new Response(DDG_HTML_FIXTURE, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    try {
      const res = await webSearchTool({ query: "failover please" });
      expect(res.success).toBe(true);
      expect(res.output).toContain("Provider: DuckDuckGo");
      expect(res.output).toContain("https://example.com/post");
      // Both transports were actually hit in chain order.
      expect(urls.some(u => u.includes("api.anthropic.com"))).toBe(true);
      expect(urls.some(u => u.includes("duckduckgo.com"))).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("webSearchTool: every provider failing surfaces an explicit aggregated error", async () => {
  await withSearchEnv({ JEO_SEARCH_PROVIDER: "duckduckgo" }, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("blocked", { status: 403 })) as typeof fetch;
    try {
      const res = await webSearchTool({ query: "blocked everywhere" });
      expect(res.success).toBe(false);
      expect(res.error).toContain("web_search failed across all providers");
      expect(res.error).toContain("DuckDuckGo");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("webSearchTool: empty query is rejected before any network call", async () => {
  const res = await webSearchTool({ query: "  " });
  expect(res.success).toBe(false);
  expect(res.error).toContain("non-empty");
});

// ── TUI card reconstruction ───────────────────────────────────────────────────

test("webSearchCardLines: rebuilds the gjc card sections from structured output", () => {
  const out = formatWebSearchOutput("hermes", parseAnthropicSearchResponse(ANTHROPIC_FIXTURE));
  const card = webSearchCardLines(out)!;
  expect(card).not.toBeNull();
  expect(card.titleMeta).toBe("Anthropic · 2 sources");
  const flat = card.lines.join("\n");
  expect(flat).toContain("Query: hermes");
  expect(flat).toContain("Hermes Agent | AI Native Landscape");
  expect(flat).toContain("https://hermes-agent.nousresearch.com/docs/");
  expect(flat).toContain("Provider: Anthropic");
  // Non-structured output (e.g. an error string) falls back to the generic card.
  expect(webSearchCardLines("Error: nope")).toBeNull();
});

// ── Perplexity provider chain, API-key, OAuth/cookies SSE & anonymous ────────

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

test("jwtExpiryMs: decodes numeric exp in ms and treats missing exp as non-expiring", () => {
  expect(jwtExpiryMs(makeJwt({ sub: "u1" }))).toBeUndefined();
  expect(jwtExpiryMs(makeJwt({ exp: 2_000_000_000 }))).toBe(2_000_000_000_000);
  expect(jwtExpiryMs("opaque-session-token")).toBeUndefined();
});

test("resolveSearchChain: auto-chain admits direct Perplexity credentials first, never OpenRouter or anonymous", async () => {
  // Direct API key -> perplexity first, then active model's native search, then ddg.
  await withSearchEnv({ PERPLEXITY_API_KEY: "pplx-test", JEO_SEARCH_API_KEY: "sk-ant" }, async () => {
    const chain = await resolveSearchChain({ modelProvider: "anthropic" });
    expect(chain.map(p => p.id)).toEqual(["perplexity", "anthropic", "duckduckgo"]);
  });

  // Dedicated JEO_SEARCH_API_KEY_PERPLEXITY / PPLX_API_KEY / PERPLEXITY_COOKIES also qualify.
  await withSearchEnv({ JEO_SEARCH_API_KEY_PERPLEXITY: "pplx-dedicated" }, async () => {
    const chain = await resolveSearchChain({ modelProvider: "ollama" });
    expect(chain.map(p => p.id)).toEqual(["perplexity", "duckduckgo"]);
  });
  await withSearchEnv({ PPLX_API_KEY: "pplx-alias" }, async () => {
    const chain = await resolveSearchChain({ modelProvider: "ollama" });
    expect(chain.map(p => p.id)).toEqual(["perplexity", "duckduckgo"]);
  });
  await withSearchEnv({ PERPLEXITY_COOKIES: "sid=abc" }, async () => {
    const chain = await resolveSearchChain({ modelProvider: "ollama" });
    expect(chain.map(p => p.id)).toEqual(["perplexity", "duckduckgo"]);
  });

  // Non-expiring OAuth JWT (no exp) or future exp > 5m buffer qualifies; expired/near-expiry does not.
  await withSearchEnv({ PERPLEXITY_OAUTH_TOKEN: makeJwt({ sub: "u1" }) }, async () => {
    const chain = await resolveSearchChain({ modelProvider: "ollama" });
    expect(chain.map(p => p.id)).toEqual(["perplexity", "duckduckgo"]);
  });
  const expiredJwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 60 }); // inside 5-min buffer
  await withSearchEnv({ PERPLEXITY_OAUTH_TOKEN: expiredJwt }, async () => {
    const chain = await resolveSearchChain({ modelProvider: "ollama" });
    expect(chain.map(p => p.id)).toEqual(["duckduckgo"]);
  });

  // OpenRouter-only NEVER admits Perplexity into auto-chain.
  await withSearchEnv({ OPENROUTER_API_KEY: "or-test", JEO_SEARCH_API_KEY_GEMINI: "gem-test" }, async () => {
    const chain = await resolveSearchChain({ modelProvider: "gemini" });
    expect(chain.map(p => p.id)).toEqual(["gemini", "duckduckgo"]);
  });
  await withSearchEnv({ OPENROUTER_API_KEY: "or-test" }, async () => {
    const chain = await resolveSearchChain({ modelProvider: "ollama" });
    expect(chain.map(p => p.id)).toEqual(["duckduckgo"]);
  });
});

test("resolveSearchChain: explicit perplexity includes perplexity even without creds (allows OpenRouter & anonymous)", async () => {
  await withSearchEnv({ JEO_SEARCH_PROVIDER: "perplexity" }, async () => {
    const chain = await resolveSearchChain({ modelProvider: "anthropic" });
    expect(chain.map(p => p.id)).toEqual(["perplexity", "duckduckgo"]);
  });
});

test("parsePerplexityApiResponse: maps choices, citations, search_results, related_questions, and usage", () => {
  const r = parsePerplexityApiResponse({
    id: "pplx_resp_1",
    model: "sonar-pro",
    usage: { prompt_tokens: 18, completion_tokens: 94 },
    citations: ["https://b.example/doc", "https://a.example/doc"],
    search_results: [
      { title: "Doc A", url: "https://a.example/doc", snippet: "Snippet A", date: "2026-05-01" },
      { title: "Doc B", url: "https://b.example/doc", snippet: "Snippet B", date: "2026-05-02" },
    ],
    related_questions: ["Follow up 1?", "  "],
    choices: [{ index: 0, message: { role: "assistant", content: "Perplexity answer [1][2]." } }],
  });
  expect(r.provider).toBe("Perplexity");
  expect(r.answer).toBe("Perplexity answer [1][2].");
  expect(r.sources).toEqual([
    { title: "Doc B", url: "https://b.example/doc", snippet: "Snippet B", publishedDate: "2026-05-02" },
    { title: "Doc A", url: "https://a.example/doc", snippet: "Snippet A", publishedDate: "2026-05-01" },
  ]);
  expect(r.citations).toEqual([
    { url: "https://b.example/doc", title: "Doc B" },
    { url: "https://a.example/doc", title: "Doc A" },
  ]);
  expect(r.relatedQuestions).toEqual(["Follow up 1?"]);
  expect(r.usage).toEqual({ inputTokens: 18, outputTokens: 94 });
  expect(r.model).toBe("sonar-pro");
  expect(r.requestId).toBe("pplx_resp_1");
});

test("webSearchTool: Perplexity API key sends chat/completions payload with sonar-pro and search options", async () => {
  await withSearchEnv(
    { JEO_SEARCH_PROVIDER: "perplexity", PERPLEXITY_API_KEY: "pplx-key-1", JEO_SEARCH_MODEL_PERPLEXITY: "sonar-reasoning-pro" },
    async () => {
      const realFetch = globalThis.fetch;
      let capturedUrl = "";
      let capturedHeaders = new Headers();
      let capturedBody: Record<string, unknown> = {};
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input instanceof Request ? input.url : input);
        capturedHeaders = new Headers(init?.headers);
        capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: "pplx_api_1",
            model: "sonar-reasoning-pro",
            usage: { prompt_tokens: 10, completion_tokens: 20 },
            search_results: [
              { title: "First", url: "https://one.example", snippet: "s1" },
              { title: "Second", url: "https://two.example", snippet: "s2" },
            ],
            choices: [{ message: { content: "API answer" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;
      try {
        const res = await webSearchTool({ query: "quic vs tcp", recency: "week", limit: 1 });
        expect(res.success).toBe(true);
        expect(capturedUrl).toBe("https://api.perplexity.ai/chat/completions");
        expect(capturedHeaders.get("authorization")).toBe("Bearer pplx-key-1");
        expect(capturedBody.model).toBe("sonar-reasoning-pro");
        expect(capturedBody.search_mode).toBe("web");
        expect(capturedBody.num_search_results).toBe(20);
        expect(capturedBody.web_search_options).toEqual({ search_type: "pro", search_context_size: "high" });
        expect(capturedBody.search_recency_filter).toBe("week");
        expect(capturedBody.return_related_questions).toBe(true);
        expect(capturedBody.stream).toBe(false);
        expect(res.output).toContain("Provider: Perplexity");
        expect(res.output).toContain("Sources: 1");
        expect(res.output).toContain("https://one.example");
        expect(res.output).not.toContain("https://two.example");
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  );
});

test("webSearchTool: auto-chain never falls back to OpenRouter when Perplexity API key fails, whereas explicit mode uses OpenRouter", async () => {
  const urls: string[] = [];
  let openrouterBody: Record<string, unknown> = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    if (url === "https://api.perplexity.ai/chat/completions") {
      return new Response("upstream error", { status: 500 });
    }
    if (url === "https://openrouter.ai/api/v1/chat/completions") {
      openrouterBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: "or_1",
          model: "perplexity/sonar-pro",
          citations: ["https://or.example/result"],
          choices: [{ message: { content: "OpenRouter answer" } }],
        }),
        { status: 200 },
      );
    }
    if (url.includes("duckduckgo.com")) {
      return new Response(DDG_HTML_FIXTURE, { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    // Auto mode: direct Perplexity fails -> skips OpenRouter -> falls back to DuckDuckGo
    await withSearchEnv({ PERPLEXITY_API_KEY: "bad-key", OPENROUTER_API_KEY: "or-key" }, async () => {
      const res = await webSearchTool({ query: "auto skip openrouter" });
      expect(res.success).toBe(true);
      expect(res.output).toContain("Provider: DuckDuckGo");
      expect(urls).not.toContain("https://openrouter.ai/api/v1/chat/completions");
    });

    // Explicit mode with OpenRouter only -> uses OpenRouter perplexity/sonar-pro
    urls.length = 0;
    await withSearchEnv({ JEO_SEARCH_PROVIDER: "perplexity", OPENROUTER_API_KEY: "or-key" }, async () => {
      const res = await webSearchTool({ query: "explicit openrouter" });
      expect(res.success).toBe(true);
      expect(res.output).toContain("Provider: Perplexity");
      expect(res.output).toContain("OpenRouter answer");
      expect(urls).toEqual(["https://openrouter.ai/api/v1/chat/completions"]);
      expect(openrouterBody.model).toBe("perplexity/sonar-pro");
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("webSearchTool: explicit JEO_SEARCH_PROVIDER=perplexity falls back to anonymous perplexity_ask when unauthenticated", async () => {
  await withSearchEnv({ JEO_SEARCH_PROVIDER: "perplexity" }, async () => {
    const realFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedHeaders = new Headers();
    let capturedBody: Record<string, unknown> = {};
    const answerPayload = {
      answer: "Anonymous fallback answer",
      web_results: [{ name: "Anon Source", url: "https://anon.example/p", snippet: "Anon snippet" }],
      chunks: ["Anonymous ", "fallback ", "answer"],
    };
    const sseEvent = {
      final: true,
      display_model: "turbo",
      uuid: "req-anon-1",
      text: JSON.stringify([{ step_type: "FINAL", content: { answer: JSON.stringify(answerPayload) }, uuid: "" }]),
    };
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input instanceof Request ? input.url : input);
      capturedHeaders = new Headers(init?.headers);
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(`data: ${JSON.stringify(sseEvent)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    try {
      const res = await webSearchTool({ query: "anonymous search" });
      expect(res.success).toBe(true);
      expect(capturedUrl).toBe("https://www.perplexity.ai/rest/sse/perplexity_ask");
      expect(capturedHeaders.has("cookie")).toBe(false);
      expect(capturedHeaders.has("authorization")).toBe(false);
      expect(capturedHeaders.get("user-agent")).toContain("Mozilla/5.0");
      const reqParams = capturedBody.params as Record<string, unknown>;
      expect(reqParams.send_back_text_in_streaming_api).toBe(true);
      expect(reqParams.skip_search_enabled).toBe(false);
      expect(reqParams.always_search_override).toBe(true);
      expect(res.output).toContain("Provider: Perplexity");
      expect(res.output).toContain("Anonymous fallback answer");
      expect(res.output).toContain("https://anon.example/p");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("parsePerplexityAskEvents & parsePerplexityAskStream: merges SSE blocks/chunks, sources_list, and surfaces stream errors", async () => {
  const merged = parsePerplexityAskEvents([
    {
      status: "PENDING",
      blocks: [
        {
          intended_usage: "web_results",
          web_result_block: { web_results: [{ name: "R1", url: "https://r1.example", snippet: "s1" }] },
        },
        {
          intended_usage: "markdown_answer",
          markdown_block: { chunks: ["Hello ", "there"], chunk_starting_offset: 0 },
        },
      ],
    },
    {
      final: true,
      status: "COMPLETED",
      display_model: "sonar-pro",
      uuid: "sse-uuid-1",
      blocks: [
        {
          intended_usage: "markdown_answer",
          markdown_block: { chunks: ["world!"], chunk_starting_offset: 1 },
        },
      ],
    },
  ]);
  expect(merged.provider).toBe("Perplexity");
  expect(merged.answer).toBe("Hello world!");
  expect(merged.sources).toEqual([{ title: "R1", url: "https://r1.example", snippet: "s1", publishedDate: undefined }]);
  expect(merged.model).toBe("sonar-pro");
  expect(merged.requestId).toBe("sse-uuid-1");

  // Stream parsing with ask_text + sources_list
  const sseText = [
    `data: ${JSON.stringify({ blocks: [{ intended_usage: "ask_text", markdown_block: { answer: "Ask text answer" } }], sources_list: [{ title: "S1", url: "https://s1.example", date: "2026-06-01" }] })}`,
    "",
    `data: ${JSON.stringify({ final: true })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const fromStream = await parsePerplexityAskStream(sseText, "fallback-id");
  expect(fromStream.answer).toBe("Ask text answer");
  expect(fromStream.sources).toEqual([
    { title: "S1", url: "https://s1.example", snippet: undefined, publishedDate: "2026-06-01" },
  ]);
  expect(fromStream.requestId).toBe("fallback-id");

  // Error event throws
  expect(() => parsePerplexityAskEvents([{ error_code: "RATE_LIMIT", error_message: "too fast" }])).toThrow(
    /too fast/,
  );
});

test("webSearchTool: Perplexity OAuth sends session cookie & app headers, and PERPLEXITY_COOKIES takes precedence", async () => {
  const realFetch = globalThis.fetch;
  let capturedHeaders = new Headers();
  let capturedBody: Record<string, unknown> = {};
  const ssePayload = `data: ${JSON.stringify({
    final: true,
    uuid: "oauth-req-1",
    display_model: "sonar",
    blocks: [
      { intended_usage: "ask_text", markdown_block: { answer: "OAuth SSE answer" } },
      { intended_usage: "web_results", web_result_block: { web_results: [{ name: "OAuth Src", url: "https://oauth.example" }] } },
    ],
  })}\n\n`;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedHeaders = new Headers(init?.headers);
    capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(ssePayload, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  try {
    // OAuth only
    await withSearchEnv({ PERPLEXITY_OAUTH_TOKEN: "pplx-session-jwt" }, async () => {
      const res = await webSearchTool({ query: "oauth headers test" });
      expect(res.success).toBe(true);
      expect(capturedHeaders.get("cookie")).toBe("__Secure-next-auth.session-token=pplx-session-jwt");
      expect(capturedHeaders.has("authorization")).toBe(false);
      expect(capturedHeaders.get("user-agent")).toBe("Perplexity/641 CFNetwork/1568 Darwin/25.2.0");
      expect(capturedHeaders.get("x-app-apiclient")).toBe("default");
      expect(capturedHeaders.get("x-app-apiversion")).toBe("2.18");
      expect(capturedHeaders.get("x-perplexity-request-reason")).toBe("submit");
      const reqParams = capturedBody.params as Record<string, unknown>;
      expect(reqParams.skip_search_enabled).toBe(false);
      expect(reqParams.always_search_override).toBe(true);
      expect(res.output).toContain("OAuth SSE answer");
    });

    // Cookies take precedence over OAuth
    await withSearchEnv(
      { PERPLEXITY_COOKIES: "custom_cookie=xyz", PERPLEXITY_OAUTH_TOKEN: "pplx-session-jwt" },
      async () => {
        const res = await webSearchTool({ query: "cookies override test" });
        expect(res.success).toBe(true);
        expect(capturedHeaders.get("cookie")).toBe("custom_cookie=xyz");
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("webSearchTool: Perplexity ask sign-up wall with zero sources fails over to DuckDuckGo", async () => {
  await withSearchEnv({ JEO_SEARCH_PROVIDER: "perplexity" }, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("perplexity.ai")) {
        const sse = `data: ${JSON.stringify({ final: true, blocks: [{ intended_usage: "ask_text", markdown_block: { answer: "Sign up and repeat your request." } }] })}\n\n`;
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(
        `<a class="result__a" href="https://example.com/ddg">DDG Fallback</a><a class="result__snippet">Live DDG result</a>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }) as typeof fetch;
    try {
      const res = await webSearchTool({ query: "signup wall test" });
      expect(res.success).toBe(true);
      expect(res.output).toContain("Provider: DuckDuckGo");
      expect(res.output).toContain("https://example.com/ddg");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// Restore module-level model hint for other tests.
setWebSearchActiveModel(undefined);
