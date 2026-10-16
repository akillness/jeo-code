import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MODEL_CATALOG, findCatalogModel, toProviderModel, compareReleaseDate } from "../src/ai/model-catalog";
import { findCatalogEntry, validateModelId, recommendedModel, catalogForProvider } from "../src/ai/model-catalog-compat";
import { BUILTIN_ALIASES, aliasesFor, describeAlias, validateAliases } from "../src/ai/model-registry";
import { describeModel, effectiveCredentialForProvider, modelServableWithConfig, oauthServesModel, providerModelFor, qualifyModelId, resolveCall, resolveMaxOutputTokens, resolveProvider } from "../src/ai/model-manager";
import { anthropicAdapter } from "../src/ai/providers/anthropic";
import { priceForModel, costForUsage } from "../src/ai/pricing";
import { chooseDefaultModel, recommendedModelsFor } from "../src/commands/setup-helpers";
import type { Credential } from "../src/auth/storage";
import type { Message } from "../src/ai/types";

// Anthropic Opus 5.5 / Sonnet 5.5: catalog rows, alias resolution, and the resolveCall → adapter
// path that must keep the exact wire id intact under OAuth. Wire ids are dateless dashed ids
// (`claude-<family>-5-5`), canonical == wire id like every other pinned 4.6+/5th-gen row.

const FAMILIES = [
  { family: "opus", wire: "claude-opus-5-5" },
  { family: "sonnet", wire: "claude-sonnet-5-5" },
] as const;
const WIRE_IDS = FAMILIES.map(f => f.wire);

test("catalog: Opus 5.5 and Sonnet 5.5 are Anthropic rows whose canonical id IS the wire id, with the 5th-gen 1M/128k + full-thinking capabilities", () => {
  for (const id of WIRE_IDS) {
    const m = findCatalogModel(id);
    expect({ id, provider: m?.provider }).toEqual({ id, provider: "anthropic" });
    expect({ id, providerModel: m?.providerModel }).toEqual({ id, providerModel: id });
    expect(m?.contextTokens).toBe(1_000_000);
    expect(m?.maxOutputTokens).toBe(128_000);
    expect(m?.thinking).toEqual(["low", "medium", "high", "xhigh"]);
    expect(m?.images).toBe(true);
    // Hard ranking guard: an undated row sorts OLDEST in recency tiebreaks, and a date older
    // than Sonnet 5's would let the previous generation outrank 5.5 on a same-tier tie.
    expect(m?.releaseDate).toMatch(/^\d{4}-\d{2}$/);
    expect(compareReleaseDate(m?.releaseDate, findCatalogModel("claude-sonnet-5")!.releaseDate)).toBeGreaterThanOrEqual(0);
  }
  // Each id is registered exactly once (a duplicate row would make provider-scoped lookups ambiguous).
  for (const id of WIRE_IDS) expect(MODEL_CATALOG.filter(m => m.canonical === id)).toHaveLength(1);
});

test("catalog lookups: 5.5 ids validate as known anthropic models, case-insensitively, and the catalog never rewrites the wire id", () => {
  for (const id of WIRE_IDS) {
    expect(validateModelId(id, "anthropic")).toMatchObject({ known: true, providerMatch: true });
    expect(validateModelId(id, "openai")).toMatchObject({ known: true, providerMatch: false });
    // Normalized lookup resolves to the canonical casing; the wire id stays lowercase-exact.
    expect(findCatalogEntry(id.toUpperCase())?.id).toBe(id);
    expect(toProviderModel(id, "anthropic")).toBe(id);
  }
});

test("routing: 5.5 ids route to anthropic and are unchanged by providerModelFor / qualifyModelId in bare, anthropic/-prefixed, and dated-snapshot forms", () => {
  for (const id of WIRE_IDS) {
    for (const form of [id, `anthropic/${id}`, `${id}-20261001`, `anthropic/${id}-20261001`]) {
      expect({ form, provider: resolveProvider(form) }).toEqual({ form, provider: "anthropic" });
      // The wire id handed to the adapter is exactly what was selected (the adapter strips `anthropic/`).
      expect({ form, wire: providerModelFor(form) }).toEqual({ form, wire: form });
    }
    // A pinned 5.5 id already routes to anthropic, so pin-time qualification must not prefix it.
    expect(qualifyModelId(id, "anthropic")).toBe(id);
  }
});

test("resolveMaxOutputTokens: catalogued 5.5 ids take the catalog 128k capped at 64k at EVERY thinking level — not the legacy thinking-level table an uncatalogued id falls back to", () => {
  const prev = process.env.JEO_MAX_OUTPUT_TOKENS;
  delete process.env.JEO_MAX_OUTPUT_TOKENS;
  try {
    for (const id of WIRE_IDS) {
      for (const level of ["low", "medium", "high", "xhigh"] as const) {
        expect({ id, level, max: resolveMaxOutputTokens(id, level) }).toEqual({ id, level, max: 64_000 });
      }
    }
  } finally {
    if (prev === undefined) delete process.env.JEO_MAX_OUTPUT_TOKENS;
    else process.env.JEO_MAX_OUTPUT_TOKENS = prev;
  }
});

test("anthropic OAuth serves 5.5 ids with no per-model allow-list (unlike Codex/Kimi): an OAuth-only config can serve them, and OAuth beats a configured API key", () => {
  const oauth: Credential = { kind: "oauth", provider: "anthropic", token: "test-oauth-token" };
  for (const id of WIRE_IDS) {
    for (const form of [id, `anthropic/${id}`, `${id}-20261001`]) {
      expect({ form, serves: oauthServesModel("anthropic", form) }).toEqual({ form, serves: true });
      expect({ form, servable: modelServableWithConfig("anthropic", form, { providers: {}, oauth: { anthropic: "test-oauth-token" } }) }).toEqual({ form, servable: true });
      const eff = effectiveCredentialForProvider("anthropic", oauth, { providers: { anthropic: "test-api-key" } }, form);
      expect({ form, kind: eff.kind, token: eff.kind === "none" ? undefined : eff.token }).toEqual({ form, kind: "oauth", token: "test-oauth-token" });
    }
  }
});

test("built-in aliases: each of Opus and Sonnet has at least one alias resolving to its exact 5.5 wire id, and every such alias is a known anthropic target", async () => {
  for (const { family, wire } of FAMILIES) {
    const aliases = aliasesFor(wire);
    expect({ family, aliasCount: aliases.length > 0 }).toEqual({ family, aliasCount: true });
    for (const alias of aliases) {
      const d = describeAlias(alias);
      expect({ alias, isAlias: d.isAlias, target: d.target, knownTarget: d.knownTarget }).toEqual({ alias, isAlias: true, target: wire, knownTarget: true });
      const m = await describeModel(alias, {});
      expect({ alias, resolved: m.resolved, provider: m.provider }).toEqual({ alias, resolved: wire, provider: "anthropic" });
      // The alias must collapse to the exact wire id by the time it reaches the adapter.
      expect(providerModelFor(m.resolved)).toBe(wire);
    }
  }
  // No built-in alias may dangle on a typo'd 5.5 target.
  expect(validateAliases(BUILTIN_ALIASES)).toEqual([]);
});

// Version-explicit spellings are the opt-in to 5.5: dotted (`opus-5.5`) and compact (`opus5.5`),
// for both families. Bare `opus` / `sonnet` are pinned to the 4.6 ids for backward compatibility, so
// a user who typed the bare name before 5.5 shipped keeps the same model.
test("built-in aliases: dotted and compact 5.5 spellings (opus-5.5, opus5.5, sonnet-5.5, sonnet5.5) resolve to the dashed 5.5 wire ids, while bare opus / sonnet stay on the pinned 4.6 ids", async () => {
  const cases: { spelling: string; wire: string }[] = [
    { spelling: "opus-5.5", wire: "claude-opus-5-5" },
    { spelling: "opus5.5", wire: "claude-opus-5-5" },
    { spelling: "sonnet-5.5", wire: "claude-sonnet-5-5" },
    { spelling: "sonnet5.5", wire: "claude-sonnet-5-5" },
    { spelling: "opus", wire: "claude-opus-4-6" },
    { spelling: "sonnet", wire: "claude-sonnet-4-6" },
  ];
  for (const c of cases) {
    const m = await describeModel(c.spelling, {});
    expect({ spelling: c.spelling, resolved: m.resolved, provider: m.provider }).toEqual({ spelling: c.spelling, resolved: c.wire, provider: "anthropic" });
    expect({ spelling: c.spelling, wire: providerModelFor(m.resolved) }).toEqual({ spelling: c.spelling, wire: c.wire });
  }
});

test("recommended default: Sonnet 5.5 is the single recommended Anthropic row, and the setup default, the setup suggestion list, and the catalog ordering all resolve to it — not Opus 5.5 or Sonnet 5", () => {
  const anthropic = catalogForProvider("anthropic");
  expect(anthropic.filter(e => e.recommended).map(e => e.id)).toEqual(["claude-sonnet-5-5"]);
  expect(anthropic[0]!.id).toBe("claude-sonnet-5-5"); // recommended sorts first in /model and setup lists
  expect(recommendedModel("anthropic")).toBe("claude-sonnet-5-5");
  // `jeo setup` accepts a blank answer as the recommended id, and prefills the first listed token.
  expect(chooseDefaultModel("", "anthropic")).toMatchObject({ model: "claude-sonnet-5-5", known: true });
  expect(recommendedModelsFor("anthropic", 5)[0]!.split(" ")[0]).toBe("claude-sonnet-5-5");
  // The default is a cost/capability pick, not "the strongest": Opus 5.5 stays selectable but unrecommended.
  expect(findCatalogEntry("claude-opus-5-5")!.recommended).toBeFalsy();
  expect(findCatalogEntry("claude-sonnet-5")!.recommended).toBeFalsy();
});

test("pricing: Opus 5.5 is $4/$20 — not the legacy $15/$75 generic opus row — and Sonnet 5.5 is the Sonnet 5 $2/$10 tier, in bare, anthropic/-prefixed, and dated-snapshot forms", () => {
  for (const form of ["claude-opus-5-5", "anthropic/claude-opus-5-5", "claude-opus-5-5-20261001"]) {
    expect({ form, price: priceForModel(form) }).toEqual({ form, price: { inPerM: 4, outPerM: 20 } });
  }
  for (const form of ["claude-sonnet-5-5", "anthropic/claude-sonnet-5-5", "claude-sonnet-5-5-20261001"]) {
    expect({ form, price: priceForModel(form) }).toEqual({ form, price: { inPerM: 2, outPerM: 10 } });
  }
  // End-to-end cost accounting: 1M in + 1M out on Opus 5.5 is $24 (legacy opus pricing would report $90).
  expect(costForUsage("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(24);
  expect(costForUsage("claude-sonnet-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(12);
});

// ── resolveCall → adapter, OAuth-only config ────────────────────────────────────────────────
// Real resolveCredential/readGlobalConfig against a throwaway config dir holding a FAKE OAuth
// token; the only network surface (fetch) is stubbed. Env that could add an API key, a second
// OAuth source, a default-model override, a fallback opt-in, or an output cap is cleared.

const SANDBOX_ENV = [
  "JEO_CONFIG_DIR",
  "JEO_DEFAULT_MODEL",
  "JEO_ANTHROPIC_FALLBACK",
  "JEO_MAX_OUTPUT_TOKENS",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

async function withOauthSandbox(config: Record<string, unknown>, run: () => Promise<void>): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-anthropic-5-5-"));
  const saved: Record<string, string | undefined> = {};
  for (const k of SANDBOX_ENV) saved[k] = process.env[k];
  const prevFetch = globalThis.fetch;
  try {
    for (const k of SANDBOX_ENV) delete process.env[k];
    const configDir = path.join(home, ".jeo");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({ providers: {}, oauth: { anthropic: { access: "test-oauth-access" } }, ...config }),
      "utf-8",
    );
    process.env.JEO_CONFIG_DIR = configDir;
    await run();
  } finally {
    globalThis.fetch = prevFetch;
    for (const k of SANDBOX_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await fs.rm(home, { recursive: true, force: true });
  }
}

const userMessages: Message[] = [{ role: "user", content: "hi" }];

test("resolveCall + anthropic adapter over OAuth: an alias, a bare id, an anthropic/ id, a dated snapshot, and the configured default all reach the wire as the exact selected 5.5 id", async () => {
  const cases: { name: string; model: string | undefined; wire: string }[] = [];
  for (const { family, wire } of FAMILIES) {
    cases.push(
      { name: `${family}: user alias`, model: `my-${family}`, wire },
      { name: `${family}: bare wire id`, model: wire, wire },
      { name: `${family}: anthropic/ prefixed`, model: `anthropic/${wire}`, wire },
      { name: `${family}: dated snapshot`, model: `${wire}-20261001`, wire: `${wire}-20261001` },
      { name: `${family}: built-in dotted alias`, model: `${family}-5.5`, wire },
      { name: `${family}: built-in compact alias`, model: `${family}5.5`, wire },
    );
  }
  cases.push({ name: "configured default (no per-call model)", model: undefined, wire: "claude-sonnet-5-5" });

  await withOauthSandbox(
    {
      defaultModel: "claude-sonnet-5-5",
      thinkingLevel: "high",
      modelAliases: { "my-opus": "claude-opus-5-5", "my-sonnet": "claude-sonnet-5-5" },
    },
    async () => {
      for (const kind of ["request", "stream"] as const) {
        for (const c of cases) {
          const sent: { url: string; authorization?: string; body: Record<string, any> }[] = [];
          globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
            sent.push({ url: String(url), authorization: (init?.headers as Record<string, string>)?.authorization, body: JSON.parse(String(init?.body)) });
            if (kind === "stream") {
              const enc = new TextEncoder();
              return new Response(
                new ReadableStream({
                  start(ctrl) {
                    ctrl.enqueue(enc.encode('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n'));
                    ctrl.close();
                  },
                }),
                { status: 200, headers: { "content-type": "text/event-stream" } },
              );
            }
            return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200, headers: { "content-type": "application/json" } });
          }) as typeof fetch;

          const resolved = await resolveCall(c.model === undefined ? {} : { model: c.model }, kind);
          const label = `${kind} / ${c.name}`;
          expect({ label, provider: resolved.provider, credential: resolved.credential.kind }).toEqual({ label, provider: "anthropic", credential: "oauth" });

          let text = "";
          if (kind === "stream") for await (const d of resolved.adapter.stream!(userMessages, resolved.callOptions, resolved.credential)) text += d;
          else text = await resolved.adapter.call(userMessages, resolved.callOptions, resolved.credential);
          expect(resolved.adapter).toBe(anthropicAdapter);
          expect({ label, text }).toEqual({ label, text: "ok" });

          expect({ label, calls: sent.length }).toEqual({ label, calls: 1 });
          expect({ label, model: sent[0]!.body.model }).toEqual({ label, model: c.wire });
          expect({ label, url: sent[0]!.url }).toEqual({ label, url: "https://api.anthropic.com/v1/messages" });
          expect({ label, authorization: sent[0]!.authorization }).toEqual({ label, authorization: "Bearer test-oauth-access" });
          expect({ label, stream: sent[0]!.body.stream === true }).toEqual({ label, stream: kind === "stream" });
          // thinkingLevel "high" → adaptive transport for a 5.5 id (no budget_tokens), carried end to end.
          expect({ label, thinking: sent[0]!.body.thinking }).toEqual({ label, thinking: { type: "adaptive", display: "summarized" } });
        }
      }
    },
  );
});

// ── fast mode (no reasoning): temperature ───────────────────────────────────────────────────
// With thinking off and a caller-supplied temperature, Anthropic's newest models answer ANY
// temperature with a 400 whose wording is not stable across models/rollouts. The adapter's reactive
// retry only recognises one exact string ("`temperature` is deprecated for this model."), so it cannot
// be the safety net. Contract: a 5.5 request never carries `temperature`; the FIRST and ONLY fetch is
// the accepted one. The stub 400s ANY body carrying `temperature` with wording the retry matcher does
// not know, so a request that sends it fails outright instead of recovering on a second attempt.
test("resolveCall + anthropic adapter over OAuth, fast mode (reasoningEffort none): a caller-supplied temperature is never sent — exactly ONE fetch per 5.5 call, accepted, no thinking, exact wire id", async () => {
  const rejected = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "`temperature` may not be set for this model." } });
  await withOauthSandbox({ defaultModel: "claude-sonnet-5-5", thinkingLevel: "high" }, async () => {
    for (const kind of ["request", "stream"] as const) {
      for (const { family, wire } of FAMILIES) {
        const spellings: { spelling: string; wire: string }[] = [
          { spelling: wire, wire },
          { spelling: `${family}5.5`, wire },
          { spelling: `anthropic/${wire}`, wire },
          { spelling: `${wire}-20261001`, wire: `${wire}-20261001` },
        ];
        for (const s of spellings) {
          const bodies: Record<string, unknown>[] = [];
          globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            bodies.push(body);
            if ("temperature" in body) return new Response(rejected, { status: 400, headers: { "content-type": "application/json" } });
            if (kind === "stream") {
              const enc = new TextEncoder();
              return new Response(
                new ReadableStream({
                  start(ctrl) {
                    ctrl.enqueue(enc.encode('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n'));
                    ctrl.close();
                  },
                }),
                { status: 200, headers: { "content-type": "text/event-stream" } },
              );
            }
            return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200, headers: { "content-type": "application/json" } });
          }) as typeof fetch;

          const label = `${kind} / ${s.spelling}`;
          let text = "";
          let error: string | undefined;
          try {
            const resolved = await resolveCall({ model: s.spelling, reasoningEffort: "none", temperature: 0.2 }, kind);
            if (kind === "stream") for await (const d of resolved.adapter.stream!(userMessages, resolved.callOptions, resolved.credential)) text += d;
            else text = await resolved.adapter.call(userMessages, resolved.callOptions, resolved.credential);
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          }

          expect({ label, error, text, calls: bodies.length }).toEqual({ label, error: undefined, text: "ok", calls: 1 });
          const sent = bodies[0]!;
          expect({ label, model: sent.model, stream: sent.stream === true }).toEqual({ label, model: s.wire, stream: kind === "stream" });
          expect({ label, temperature: sent.temperature, thinking: sent.thinking, output_config: sent.output_config }).toEqual({ label, temperature: undefined, thinking: undefined, output_config: undefined });
        }
      }
    }
  });
});
