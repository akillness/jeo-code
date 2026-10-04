import { test, expect, beforeEach, afterEach } from "bun:test";
import { anthropicAdapter, anthropicRequest } from "../src/ai/providers/anthropic";
import type { CallOptions, Message, ReasoningArtifact } from "../src/ai/types";
import type { Credential } from "../src/auth";

// Anthropic Opus 5.5 / Sonnet 5.5 at the provider boundary. Unlike every other 5th-gen id
// (dateless single-digit: claude-sonnet-5, claude-fable-5), these carry a MINOR component
// (`-5-5`), so the id parser, the adaptive-thinking gate, and the verbatim wire contract all
// see a shape the rest of the suite never exercises. The contract defended here: the model
// string that reaches `body.model` is the exact wire id the caller selected (only the
// `anthropic/` routing prefix is stripped) across api-key + OAuth and call + stream.
// Everything is hermetic: fake tokens, stubbed fetch, no network.

const WIRE_IDS = ["claude-opus-5-5", "claude-sonnet-5-5"] as const;
const apiKeyCred: Credential = { kind: "api_key", provider: "anthropic", token: "test-api-key" };
const oauthCred: Credential = { kind: "oauth", provider: "anthropic", token: "test-oauth-token" };
const messages: Message[] = [{ role: "user", content: "hi" }];

// anthropicFallbackModels reads JEO_ANTHROPIC_FALLBACK straight from process.env — pin it so
// ambient host state can neither add nor suppress `fallbacks`, and never leak to other files.
let prevFallbackEnv: string | undefined;
beforeEach(() => {
  prevFallbackEnv = process.env.JEO_ANTHROPIC_FALLBACK;
  delete process.env.JEO_ANTHROPIC_FALLBACK;
});
afterEach(() => {
  if (prevFallbackEnv === undefined) delete process.env.JEO_ANTHROPIC_FALLBACK;
  else process.env.JEO_ANTHROPIC_FALLBACK = prevFallbackEnv;
});

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(e));
      c.close();
    },
  });
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, any>;
}

/** Replace global fetch with a recorder; the caller MUST call `restore()` in `finally`. */
function stubFetch(respond: (req: Captured) => Response): { calls: Captured[]; restore: () => void } {
  const prev = globalThis.fetch;
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const req: Captured = {
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    };
    calls.push(req);
    return respond(req);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = prev; } };
}

test("anthropicRequest: 5.5 wire ids reach body.model verbatim — only the anthropic/ routing prefix is stripped — on api-key + OAuth, stream + non-stream", () => {
  const cases: { input: string; wire: string }[] = [
    { input: "claude-opus-5-5", wire: "claude-opus-5-5" },
    { input: "anthropic/claude-opus-5-5", wire: "claude-opus-5-5" },
    { input: "claude-sonnet-5-5", wire: "claude-sonnet-5-5" },
    { input: "anthropic/claude-sonnet-5-5", wire: "claude-sonnet-5-5" },
    // A dated snapshot must never be collapsed onto the dateless id (or the reverse).
    { input: "claude-opus-5-5-20261001", wire: "claude-opus-5-5-20261001" },
    { input: "anthropic/claude-sonnet-5-5-20261001", wire: "claude-sonnet-5-5-20261001" },
  ];
  for (const cred of [apiKeyCred, oauthCred]) {
    for (const stream of [false, true]) {
      for (const c of cases) {
        const req = anthropicRequest(messages, { model: c.input, maxTokens: 4000 }, cred, stream, true);
        const body = JSON.parse(req.body) as { model: string };
        expect({ cred: cred.kind, stream, input: c.input, sent: body.model }).toEqual({ cred: cred.kind, stream, input: c.input, sent: c.wire });
        expect(req.url).toBe("https://api.anthropic.com/v1/messages");
      }
    }
  }
});

test("anthropicRequest: 5.5 ids (incl. dated snapshots) use ADAPTIVE thinking with display:summarized and drop the interleaved-thinking beta on api-key AND OAuth", () => {
  const models = [...WIRE_IDS, "claude-opus-5-5-20261001", "claude-sonnet-5-5-20261001"];
  for (const cred of [apiKeyCred, oauthCred]) {
    for (const model of models) {
      // temperature is set on purpose: extended thinking forbids a custom temperature, so a
      // misclassified (non-thinking / budget) transport would leak it into the body.
      const req = anthropicRequest(messages, { model, maxTokens: 40_000, temperature: 0.2, reasoningEffort: "high" }, cred, true, true);
      const body = JSON.parse(req.body);
      const label = `${cred.kind}/${model}`;
      expect({ label, thinking: body.thinking }).toEqual({ label, thinking: { type: "adaptive", display: "summarized" } });
      expect({ label, output_config: body.output_config }).toEqual({ label, output_config: { effort: "high" } });
      expect({ label, temperature: body.temperature }).toEqual({ label, temperature: undefined });
      expect({ label, interleaved: (req.headers["anthropic-beta"] ?? "").includes("interleaved-thinking") }).toEqual({ label, interleaved: false });
    }
  }
});

for (const model of WIRE_IDS) {
  test(`anthropicRequest: OAuth + ${model} keeps the Claude Code cloak (bearer, billing header, SDK prelude, metadata, betas) around the exact wire id`, () => {
    const req = anthropicRequest(messages, { model, maxTokens: 4000, systemPrompt: "SYS" }, oauthCred, true, true);
    const body = JSON.parse(req.body);

    expect(body.model).toBe(model);
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req.headers.authorization).toBe("Bearer test-oauth-token");
    expect(req.headers["x-api-key"]).toBeUndefined();
    expect(req.headers.accept).toBe("text/event-stream");
    expect(req.headers["x-app"]).toBe("cli");
    expect(req.headers["anthropic-beta"]).toContain("claude-code-20250219");
    expect(req.headers["anthropic-beta"]).toContain("oauth-2025-04-20");

    expect(body.system).toHaveLength(3);
    expect(body.system[0].text).toStartWith("x-anthropic-billing-header: cc_version=");
    expect(body.system[1]).toEqual({ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." });
    expect(body.system[2]).toEqual({ type: "text", text: "SYS", cache_control: { type: "ephemeral" } });
    expect(body.metadata?.user_id).toMatch(/^user_[0-9a-f]{64}_account_[0-9a-f-]{36}_session_[0-9a-f-]{36}$/);
  });
}

test("anthropicRequest: 5.5 ids never opt into server-side fallback (it would silently re-route the call to a different model than the wire id selected)", () => {
  for (const cred of [apiKeyCred, oauthCred]) {
    for (const model of [...WIRE_IDS, "claude-opus-5-5-20261001"]) {
      const req = anthropicRequest(messages, { model, maxTokens: 4000 }, cred, false, true);
      const body = JSON.parse(req.body) as { model: string; fallbacks?: unknown };
      expect({ cred: cred.kind, model, fallbacks: body.fallbacks }).toEqual({ cred: cred.kind, model, fallbacks: undefined });
      expect({ cred: cred.kind, model, beta: (req.headers["anthropic-beta"] ?? "").includes("server-side-fallback") }).toEqual({ cred: cred.kind, model, beta: false });
      expect(body.model).toBe(model);
    }
  }
});

for (const model of WIRE_IDS) {
  test(`anthropicAdapter.call over OAuth: ${model} goes out exactly as selected and the reasoning artifact is tagged with the served model verbatim`, async () => {
    const served = `${model}-20261001`; // snapshot the API reports back; must not be normalized to the request id
    const net = stubFetch(() =>
      new Response(
        JSON.stringify({
          model: served,
          content: [
            { type: "thinking", thinking: "weighing", signature: "sig-call" },
            { type: "text", text: "answer" },
          ],
          usage: { input_tokens: 7, output_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));
    try {
      const arts: ReasoningArtifact[] = [];
      const opts: CallOptions = { model: `anthropic/${model}`, maxTokens: 50, reasoningEffort: "high", onReasoningArtifact: a => { arts.push(a); } };
      const text = await anthropicAdapter.call(messages, opts, oauthCred);

      expect(text).toBe("answer");
      expect(net.calls).toHaveLength(1);
      const sent = net.calls[0]!;
      expect(sent.url).toBe("https://api.anthropic.com/v1/messages");
      expect(sent.headers.authorization).toBe("Bearer test-oauth-token");
      expect(sent.headers.accept).toBe("application/json");
      expect(sent.body.model).toBe(model);
      expect(sent.body.stream).toBeUndefined();
      expect(sent.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
      expect(arts).toEqual([{ provider: "anthropic", model: served, text: "weighing", signature: "sig-call" }]);
    } finally {
      net.restore();
    }
  });

  test(`anthropicAdapter.stream over OAuth: ${model} goes out exactly as selected and the streamed reasoning artifact is tagged with the served model verbatim`, async () => {
    const served = `${model}-20261001`;
    const net = stubFetch(() =>
      new Response(
        sseStream([
          `data: {"type":"message_start","message":{"model":"${served}","usage":{"input_tokens":7}}}\n\n`,
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"weighing"}}\n\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-stream"}}\n\n',
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"ans"}}\n\n',
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"wer"}}\n\n',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ));
    try {
      const arts: ReasoningArtifact[] = [];
      const opts: CallOptions = { model: `anthropic/${model}`, maxTokens: 50, reasoningEffort: "high", onReasoningArtifact: a => { arts.push(a); } };
      let text = "";
      for await (const d of anthropicAdapter.stream!(messages, opts, oauthCred)) text += d;

      expect(text).toBe("answer");
      expect(net.calls).toHaveLength(1);
      const sent = net.calls[0]!;
      expect(sent.url).toBe("https://api.anthropic.com/v1/messages");
      expect(sent.headers.authorization).toBe("Bearer test-oauth-token");
      expect(sent.headers.accept).toBe("text/event-stream");
      expect(sent.body.model).toBe(model);
      expect(sent.body.stream).toBe(true);
      expect(sent.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
      expect(arts).toEqual([{ provider: "anthropic", model: served, text: "weighing", signature: "sig-stream" }]);
    } finally {
      net.restore();
    }
  });
}

function okResponse(mode: "call" | "stream"): Response {
  return mode === "call"
    ? new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 3, output_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } })
    : new Response(sseStream(['data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n']), { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function runAdapter(mode: "call" | "stream", opts: CallOptions, cred: Credential): Promise<string> {
  let text = "";
  if (mode === "call") text = await anthropicAdapter.call(messages, opts, cred);
  else for await (const d of anthropicAdapter.stream!(messages, opts, cred)) text += d;
  return text;
}

// ── Claude Code identity floor (OAuth) ──────────────────────────────────────────────────────
// Live OAuth probe: Sonnet 5.5 was served, but Opus 5.5 answered HTTP 400
// `claude_code_version_too_old: version 2.1.280 minimum` because the OAuth cloak advertised
// 2.1.63. The floor below is the SERVER's minimum, not "whatever we ship today" — the tests
// pin >= floor and cross-field agreement, never the exact current version, so bumping the
// constant to a newer release keeps them green and regressing below the floor turns them red.
const MIN_CLAUDE_CODE_VERSION = "2.1.280";

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

const VERSION_GATE_MODELS = [...WIRE_IDS, "claude-opus-5-5-20261001", "claude-sonnet-5-5-20261001"];

for (const field of ["userAgent", "billing"] as const) {
  test(`anthropicRequest: OAuth ${field === "userAgent" ? "User-Agent claude-cli/<version>" : "billing header cc_version"} is at least the server's minimum Claude Code version (${MIN_CLAUDE_CODE_VERSION}) for every 5.5 id, stream + non-stream`, () => {
    const failures: { model: string; stream: boolean; advertised: string | undefined; minimum: string }[] = [];
    for (const model of VERSION_GATE_MODELS) {
      for (const stream of [false, true]) {
        const req = anthropicRequest(messages, { model, maxTokens: 4000, systemPrompt: "SYS" }, oauthCred, stream, true);
        const body = JSON.parse(req.body) as { system?: { text: string }[] };
        const advertised = advertisedVersions(req.headers, body.system)[field];
        if (advertised === undefined || compareVersions(advertised, MIN_CLAUDE_CODE_VERSION) < 0) {
          failures.push({ model, stream, advertised, minimum: MIN_CLAUDE_CODE_VERSION });
        }
      }
    }
    expect(failures).toEqual([]);
  });
}

test("anthropicRequest: OAuth User-Agent version and billing cc_version are the SAME version (one source of truth, no field left behind when the constant moves)", () => {
  const mismatches: { model: string; stream: boolean; userAgent: string | undefined; billing: string | undefined }[] = [];
  for (const model of VERSION_GATE_MODELS) {
    for (const stream of [false, true]) {
      const req = anthropicRequest(messages, { model, maxTokens: 4000, systemPrompt: "SYS" }, oauthCred, stream, true);
      const body = JSON.parse(req.body) as { system?: { text: string }[] };
      const { userAgent, billing } = advertisedVersions(req.headers, body.system);
      // Both must be parseable AND equal; two `undefined`s must not pass vacuously.
      if (userAgent === undefined || billing === undefined || userAgent !== billing) mismatches.push({ model, stream, userAgent, billing });
    }
  }
  expect(mismatches).toEqual([]);
});

// Wire-level: the stub emulates the live server gate (400 claude_code_version_too_old when EITHER
// advertised version is below the floor). A version rejection is not recoverable by retrying, so the
// only passing shape is a single accepted fetch.
for (const model of VERSION_GATE_MODELS) {
  for (const mode of ["call", "stream"] as const) {
    test(`anthropicAdapter.${mode} over OAuth: ${model} is not turned away by the Claude Code minimum-version gate (one fetch, accepted)`, async () => {
      const net = stubFetch(req => {
        const { userAgent, billing } = advertisedVersions(req.headers, req.body.system);
        const tooOld = [userAgent, billing].some(v => v === undefined || compareVersions(v, MIN_CLAUDE_CODE_VERSION) < 0);
        if (!tooOld) return okResponse(mode);
        return new Response(
          JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `claude_code_version_too_old: version ${MIN_CLAUDE_CODE_VERSION} minimum` } }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      });
      try {
        let text = "";
        let error: string | undefined;
        try {
          text = await runAdapter(mode, { model: `anthropic/${model}`, maxTokens: 50 }, oauthCred);
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        expect({ model, mode, error, calls: net.calls.length }).toEqual({ model, mode, error: undefined, calls: 1 });
        expect(text).toBe("ok");
        expect(net.calls[0]!.body.model).toBe(model);
        expect(net.calls[0]!.headers.authorization).toBe("Bearer test-oauth-token");
      } finally {
        net.restore();
      }
    });
  }
}

// Fast mode (no reasoningEffort) with a caller-supplied temperature. Anthropic's newest models reject
// ANY temperature, and the 400 wording is not stable across models/rollouts — the adapter's reactive
// retry only recognises one exact string ("`temperature` is deprecated for this model."), so it cannot
// be the safety net. Contract: a 5.5 request never carries `temperature`; the FIRST and ONLY fetch is
// the accepted one. The stub 400s ANY body carrying `temperature` with wording the retry matcher does
// not know, so a request that sends it fails outright instead of recovering on a second attempt.
const TEMPERATURE_REJECTED = "`temperature` may not be set for this model.";
for (const cred of [apiKeyCred, oauthCred]) {
  for (const model of [...WIRE_IDS, "claude-opus-5-5-20261001", "claude-sonnet-5-5-20261001"]) {
    for (const mode of ["call", "stream"] as const) {
      test(`anthropicAdapter.${mode} (${cred.kind}, no reasoning): ${model} sends exactly ONE request, with NO temperature, no thinking, and the exact wire id`, async () => {
        const net = stubFetch(req =>
          "temperature" in req.body
            ? new Response(
                JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: TEMPERATURE_REJECTED } }),
                { status: 400, headers: { "content-type": "application/json" } },
              )
            : okResponse(mode));
        try {
          let text = "";
          let error: string | undefined;
          try {
            text = await runAdapter(mode, { model: `anthropic/${model}`, maxTokens: 50, temperature: 0.2 }, cred);
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          }
          expect({ cred: cred.kind, model, mode, error, calls: net.calls.length }).toEqual({ cred: cred.kind, model, mode, error: undefined, calls: 1 });
          expect(text).toBe("ok");
          const sent = net.calls[0]!;
          expect(sent.body.model).toBe(model); // prefix stripped only
          expect("temperature" in sent.body).toBe(false);
          expect(sent.body.thinking).toBeUndefined();
          expect(sent.body.output_config).toBeUndefined();
          expect(sent.body.stream === true).toBe(mode === "stream");
        } finally {
          net.restore();
        }
      });
    }
  }
}
