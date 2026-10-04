import { test, expect } from "bun:test";
import {
  resolveSearchChain,
  setWebSearchActiveModel,
  webSearchTool,
  parseAnthropicSearchResponse,
  parseOpenAISearchResponse,
  parseGeminiSearchResponse,
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
];

function withSearchEnv(env: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map(SEARCH_ENV_KEYS.map(k => [k, process.env[k]] as const));
  for (const k of SEARCH_ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return fn().finally(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

// ── Provider chain resolution (gjc semantics — never hardcoded to one backend) ──

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

// ── DuckDuckGo parsers (live-HTML shape pinned by fixtures; gjc port) ─────────

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

// Restore module-level model hint for other tests.
setWebSearchActiveModel(undefined);
