import { test, expect } from "bun:test";
import {
  resolveSearchChain,
  setWebSearchActiveModel,
  webSearchTool,
  parseAnthropicSearchResponse,
  formatWebSearchOutput,
  parseHtmlResults,
  parseLiteResults,
  decodeResultUrl,
} from "../src/agent/web-search";
import { webSearchCardLines } from "../src/tui/components/forge";

const SEARCH_ENV_KEYS = [
  "JEO_SEARCH_PROVIDER", "JEO_SEARCH_PROVIDER",
  "JEO_SEARCH_API_KEY", "JEO_SEARCH_API_KEY",
  "JEO_SEARCH_MODEL", "JEO_SEARCH_MODEL",
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

test("resolveSearchChain: model providers without a native search fall through to ddg", async () => {
  await withSearchEnv({ JEO_SEARCH_API_KEY: "sk-test" }, async () => {
    // Credentials exist, but the chain is active-model-GATED (gjc), never
    // credential-scanning: a gemini-model session does not silently use Anthropic.
    const chain = await resolveSearchChain({ modelProvider: "gemini" });
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
