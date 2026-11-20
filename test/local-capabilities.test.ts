import { describe, test, expect, afterEach } from "bun:test";
import {
  probeLocalCapabilities,
  clearCapabilityCache,
  clearToolTierMemory,
  getEffectiveToolTier,
  demoteToolTier,
  endpointTierKey,
  onTierDemotion,
  buildToolCallJsonSchema,
  buildToolCallGbnfGrammar,
} from "../src/ai/providers/local-capabilities";
import { llamaCppAdapter, normalizeLlamaCppBaseUrl } from "../src/ai/providers/llama-cpp";
import { ollamaAdapter } from "../src/ai/providers/ollama";
import { resolveProvider, qualifyModelId } from "../src/ai/model-manager";
import { describeProvider } from "../src/ai/provider-status";
import { discoveryRequest, parseModelsBody } from "../src/ai/model-discovery";
import type { Credential } from "../src/auth";
import type { NativeToolSchema } from "../src/ai/types";

const realFetch = globalThis.fetch;
const keyless: Credential = { kind: "none", provider: "openai" };

const SAMPLE_TOOLS: NativeToolSchema[] = [
  {
    name: "read",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { filePath: { type: "string" } },
      required: ["filePath"],
    },
  },
  {
    name: "edit",
    description: "Edit a file",
    parameters: {
      type: "object",
      properties: { filePath: { type: "string" }, editBlock: { type: "string" } },
      required: ["filePath", "editBlock"],
    },
  },
];

afterEach(() => {
  globalThis.fetch = realFetch;
  clearCapabilityCache();
  clearToolTierMemory();
});

describe("Local Capabilities Probing & Tier Memory", () => {
  test("probes llama.cpp /props with 60s TTL cache and detects context + tool template", async () => {
    let calls = 0;
    const mockFetch = (async (url: string) => {
      calls++;
      expect(url).toBe("http://localhost:8080/props");
      return new Response(
        JSON.stringify({
          default_generation_settings: { n_ctx: 32768 },
          chat_template: "{% for tool in tools %}{{ tool }}{% endfor %}",
          model_path: "qwen2.5-coder-7b-q4.gguf",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const first = await probeLocalCapabilities("llama-cpp", "http://localhost:8080/v1", {
      fetchImpl: mockFetch,
    });
    expect(first.reachable).toBe(true);
    expect(first.contextWindow).toBe(32768);
    expect(first.supportsNativeTools).toBe(true);
    expect(first.supportsGrammar).toBe(true);
    expect(first.recommendedTier).toBe("native");
    expect(calls).toBe(1);

    const second = await probeLocalCapabilities("llama-cpp", "http://localhost:8080/v1", {
      fetchImpl: mockFetch,
    });
    expect(second.contextWindow).toBe(32768);
    expect(calls).toBe(1);
  });

  test("recommends structured tier when llama.cpp chat_template lacks tool support", async () => {
    const caps = await probeLocalCapabilities("llama-cpp", "http://localhost:8080/v1", {
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            default_generation_settings: { n_ctx: 8192 },
            chat_template: "{% for message in messages %}{{ message.content }}{% endfor %}",
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    expect(caps.reachable).toBe(true);
    expect(caps.supportsNativeTools).toBe(false);
    expect(caps.supportsGrammar).toBe(true);
    expect(caps.recommendedTier).toBe("structured");
  });

  test("probes Ollama /api/show and fails open cleanly when offline", async () => {
    const ollamaCaps = await probeLocalCapabilities("ollama", "http://localhost:11434", {
      modelId: "ollama/qwen2.5-coder:7b",
      fetchImpl: (async (url: string) => {
        expect(url).toBe("http://localhost:11434/api/show");
        return new Response(
          JSON.stringify({
            capabilities: ["completion", "tools"],
            model_info: { "qwen2.context_length": 65536 },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    expect(ollamaCaps.reachable).toBe(true);
    expect(ollamaCaps.supportsNativeTools).toBe(true);
    expect(ollamaCaps.contextWindow).toBe(65536);
    expect(ollamaCaps.recommendedTier).toBe("native");

    const offline = await probeLocalCapabilities("llama-cpp", "http://localhost:19999/v1", {
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(offline.reachable).toBe(false);
    expect(offline.supportsGrammar).toBe(true);
  });

  test("builds JSON Schema and GBNF grammar for active toolset", () => {
    const schema = buildToolCallJsonSchema(SAMPLE_TOOLS);
    expect(schema.type).toBe("object");
    expect(Array.isArray(schema.anyOf)).toBe(true);

    const grammar = buildToolCallGbnfGrammar(SAMPLE_TOOLS);
    expect(grammar).toContain("root ::= ws (single-call | batch-call) ws");
    expect(grammar).toContain('"\\"read\\""');
    expect(grammar).toContain('"\\"edit\\""');
    expect(grammar).toContain('"\\"done\\""');
  });

  test("demoteToolTier steps down native -> structured -> prose and notifies listeners", () => {
    const events: string[] = [];
    const unsub = onTierDemotion((ev) => events.push(`${ev.from}->${ev.to}`));
    try {
      const key = endpointTierKey("llama-cpp", "http://localhost:8080/v1", "qwen");
      expect(getEffectiveToolTier(key)).toBe("native");
      expect(demoteToolTier(key, "native")).toBe("structured");
      expect(getEffectiveToolTier(key)).toBe("structured");
      expect(demoteToolTier(key, "structured")).toBe("prose");
      expect(getEffectiveToolTier(key)).toBe("prose");
      expect(demoteToolTier(key, "prose")).toBe("prose");
      expect(events).toEqual(["native->structured", "structured->prose"]);
    } finally {
      unsub();
    }
  });
});

describe("llamaCppAdapter & ollamaAdapter 3-Tier Cascade", () => {
  test("normalizeLlamaCppBaseUrl handles bare host:port and ensures /v1 path", () => {
    expect(normalizeLlamaCppBaseUrl("localhost:8080")).toBe("http://localhost:8080/v1");
    expect(normalizeLlamaCppBaseUrl("http://localhost:8090/")).toBe("http://localhost:8090/v1");
    expect(normalizeLlamaCppBaseUrl("http://localhost:8090/v1/")).toBe("http://localhost:8090/v1");
  });

  test("llamaCppAdapter.call cascades native -> structured (GBNF) -> prose on 400 rejections and remembers tier", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      payloads.push(parsed);

      if (parsed.tools) {
        return new Response(
          JSON.stringify({ error: "Error rendering prompt with jinja template: tools not supported" }),
          { status: 400 },
        );
      }
      if (parsed.grammar) {
        return new Response(
          JSON.stringify({ error: "grammar parameter is unsupported on this endpoint" }),
          { status: 400 },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: '{"tool":"read","arguments":{"filePath":"README.md"}}' },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const reply = await llamaCppAdapter.call(
      [{ role: "user", content: "Read README" }],
      {
        model: "llama-cpp/qwen2.5-coder",
        baseUrl: "http://localhost:8080/v1",
        tools: SAMPLE_TOOLS,
        jsonMode: true,
      },
      keyless,
    );

    expect(reply).toContain('"tool":"read"');
    expect(payloads).toHaveLength(3);
    expect(payloads[0]!.tools).toBeDefined();
    expect(payloads[1]!.tools).toBeUndefined();
    expect(typeof payloads[1]!.grammar).toBe("string");
    expect(payloads[2]!.tools).toBeUndefined();
    expect(payloads[2]!.grammar).toBeUndefined();

    await llamaCppAdapter.call(
      [{ role: "user", content: "Next step" }],
      {
        model: "llama-cpp/qwen2.5-coder",
        baseUrl: "http://localhost:8080/v1",
        tools: SAMPLE_TOOLS,
        jsonMode: true,
      },
      keyless,
    );
    expect(payloads).toHaveLength(4);
    expect(payloads[3]!.tools).toBeUndefined();
    expect(payloads[3]!.grammar).toBeUndefined();
  });

  test("llamaCppAdapter.stream falls back from native 400 to structured GBNF SSE stream", async () => {
    const seenBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      seenBodies.push(parsed);
      if (parsed.tools) {
        return new Response("chat template does not support tools", { status: 400 });
      }
      const sse =
        'data: {"choices":[{"delta":{"content":"{\\"tool\\":\\"done\\",\\"arguments\\":{\\"reason\\":\\"ok\\"}}"},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n";
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    let out = "";
    for await (const chunk of llamaCppAdapter.stream!(
      [{ role: "user", content: "Finish" }],
      {
        model: "llama-cpp/deepseek-r1-7b",
        baseUrl: "http://localhost:8080/v1",
        tools: SAMPLE_TOOLS,
      },
      keyless,
    )) {
      out += chunk;
    }

    expect(out).toContain('"tool":"done"');
    expect(seenBodies).toHaveLength(2);
    expect(seenBodies[0]!.tools).toBeDefined();
    expect(typeof seenBodies[1]!.grammar).toBe("string");
  });

  test("ollamaAdapter cascades native -> structured JSON schema on 400", async () => {
    const seen: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      seen.push(parsed);
      if (parsed.tools) {
        return new Response('{"error":"model does not support tools"}', { status: 400 });
      }
      return new Response(
        JSON.stringify({
          message: { content: '{"tool":"done","arguments":{"reason":"verified"}}' },
          done: true,
          done_reason: "stop",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const out = await ollamaAdapter.call(
      [{ role: "user", content: "hi" }],
      {
        model: "ollama/qwen2.5:3b",
        baseUrl: "http://localhost:11434",
        tools: SAMPLE_TOOLS,
        toolCallingTier: "native",
      },
      keyless,
    );

    expect(out).toContain('"tool":"done"');
    expect(seen).toHaveLength(2);
    expect(seen[0]!.tools).toBeDefined();
    expect(typeof seen[1]!.format).toBe("object");
  });

  test("wires llama-cpp across provider routing, status, and model discovery", async () => {
    expect(resolveProvider("llama-cpp/qwen2.5-coder")).toBe("llama-cpp");
    expect(qualifyModelId("qwen2.5-coder", "llama-cpp")).toBe("llama-cpp/qwen2.5-coder");

    const status = await describeProvider("llama-cpp", { providers: {}, defaultModel: "fast" } as never);
    expect(status.ready).toBe(true);
    expect(status.baseUrl).toContain("8080");

    const req = discoveryRequest("llama-cpp", undefined, "http://localhost:8080");
    expect(req.url).toBe("http://localhost:8080/v1/models");
    expect(parseModelsBody("llama-cpp", { data: [{ id: "qwen3-8b" }] })).toEqual([
      "llama-cpp/qwen3-8b",
    ]);
  });
});
