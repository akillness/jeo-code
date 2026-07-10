import { test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { resetPromptRouterWarnings } from "../src/agent/prompt-router";
import { resetLiveProviderModels } from "../src/ai/model-catalog";
import { providerRegistry } from "../src/ai/provider-registry";
import { ProviderHttpError } from "../src/ai/providers/errors";
import type { ProviderAdapter } from "../src/ai/types";
import type { Credential } from "../src/auth";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Every OTHER test covering the rate-limit fast-fallback system (test/retry.test.ts,
// test/engine.test.ts, and launch-prompt-routing.test.ts's own "rate-limit fast
// fallback"/"OAuth subscription scope" sections) mocks exactly ONE layer of the chain
// in isolation — retry.test.ts drives `withRetry` with a synthetic test function
// (no provider/engine involvement at all); engine.test.ts mocks `agent/loop`'s
// `callLlm` directly (bypasses model-manager's `resolveCall`/`withRetry` entirely);
// launch-prompt-routing.test.ts mocks `runAgentLoop` ITSELF via
// `mock.module('../src/agent/engine', ...)` (bypasses the REAL engine onRetry closure,
// the REAL retry.ts withRetry, AND the REAL model-manager.ts resolveCall — it only
// proves launch.ts's OWN rateLimitFallbackAvailable closure/equivalentRouteFallback in
// isolation).
//
// This file proves the FULL chain together: launch.ts's real `rateLimitFallbackAvailable`
// closure -> engine.ts's real `onRetry` closure -> retry.ts's real `withRetry` ->
// model-manager.ts's real `resolveCall` -> a provider adapter. Deliberately does NOT
// mock `../src/agent/engine` or `../src/ai` (the two mocks that make the sibling file's
// tests bypass the real chain) — only the actual network-facing PROVIDER ADAPTER call is
// faked, by registering throwaway `ProviderAdapter`s directly into the REAL
// `providerRegistry` singleton (src/ai/provider-registry.ts) for the duration of each
// test, then restoring the original adapters afterward so nothing leaks into any other
// test file sharing this one Bun test process.
//
// One-shot mode (`-p`) is used exclusively (mirrors launch-fallback-live-discovery.test.ts's
// established rationale): interactive mode fires an unconditional background
// `getLiveModels()` warm-up and constructs a real `LaunchTui`/`readline` interface,
// neither of which one-shot ever reaches (see launch.ts's `isOneShot` branch) — so this
// file needs NO `node:readline/promises` or `../src/tui/app` mock at all, unlike
// launch-prompt-routing.test.ts's interactive-mode helpers.
//
// Cross-file `mock.module` pin-back (established convention — see launch-prompt-
// routing.test.ts's `realAI`/`realEngine`): Bun shares ONE module registry across every
// file in a `bun test` invocation, and `mock.restore()` only undoes `spyOn`/`mock()`
// spies — it does NOT undo `mock.module()`. Roughly three dozen OTHER test files mock
// `../src/agent/loop` (task-tool.test.ts, engine.test.ts, compaction.test.ts, …), and
// files run SEQUENTIALLY within one Bun process — a mock left registered by the LAST
// test in an earlier file (e.g. task-tool.test.ts's final test, which permanently mocks
// `callLlm` to always throw a 429) is still active for every later file, INCLUDING at
// this file's own top-level `import`/module-init time (documented, pre-existing,
// out-of-scope-to-fix-globally — see launch-telegram-remote.test.ts's "GENUINE
// PRE-EXISTING TEST-SUITE FINDING" comment). A naive `{ ...(await
// import("../src/agent/loop")) }` capture is USELESS here — it would just capture
// whatever mock already leaked in before this file's imports even ran.
//
// Since this file's entire point is exercising the REAL loop.ts -> model-manager.ts ->
// provider adapter chain, a leaked mock silently no-ops every assertion below (the fake
// adapters registered into `providerRegistry` would simply never be called). Fix:
// rebuild the REAL `callLlm` directly from `createModelManager` (`../src/ai/model-
// manager` — confirmed via repo-wide grep to be the ONE module in this chain that NO
// test file mocks, directly or via barrel), mirroring loop.ts's own trivial
// non-streaming implementation line-for-line, and re-pin it as the `../src/agent/loop`
// mock in `beforeEach` so this file's tests are correct regardless of what mock state
// (if any) leaked in from elsewhere in the same Bun process.
import { createModelManager } from "../src/ai/model-manager";
const realManager = createModelManager();
// Mirrors loop.ts's `callLlm` line-for-line (both branches — the non-streaming `call()`
// AND the `onToken`-driven `stream()` accumulation path engine.ts's live-view wiring
// can take) so this stand-in is behaviorally identical to the real export, not just a
// same-signature approximation.
async function realCallLlm(messages: unknown, options: Record<string, unknown> = {}): Promise<string> {
  const opts = options as { onToken?: (delta: string) => void };
  if (!opts.onToken) return realManager.call(messages as never, options as never);
  let full = "";
  for await (const delta of realManager.stream(messages as never, options as never)) {
    full += delta;
    try { opts.onToken(delta); } catch { /* render consumer error must not break the turn */ }
  }
  return full;
}

const realAnthropicAdapter = providerRegistry.get("anthropic")!;
const realOpenaiAdapter = providerRegistry.get("openai")!;

const OAUTH_STAMP = { access: "x", refresh: "x", expires: Date.now() + 1e9 };

// Env vars that would otherwise leak an ambient credential into the temp config via
// readGlobalConfig's withEnvOverlay (a stray ANTHROPIC_API_KEY/OPENAI_API_KEY in the
// dev/CI environment would silently add an extra pool candidate and desync the
// deterministic model-selection assertions below) — same convention as
// launch-prompt-routing.test.ts's `withRoutingProviderEnvCleared`.
const ROUTING_PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_OAUTH_TOKEN",
  "GEMINI_API_KEY",
  "GEMINI_OAUTH_TOKEN",
  "XAI_API_KEY",
];

async function withRoutingProviderEnvCleared<T>(run: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ROUTING_PROVIDER_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

let originalIsTTY: boolean | undefined;

beforeEach(() => {
  originalIsTTY = process.stdin.isTTY;
  process.stdin.isTTY = false; // one-shot (`-p`) path — never the interactive REPL
  resetPromptRouterWarnings();
  resetLiveProviderModels();
  // Win the race against any leaked `mock.module("../src/agent/loop", …)` from another
  // test file in this shared Bun process (see the file-header comment above) — pin the
  // REAL callLlm back immediately before every test in this file runs.
  mock.module("../src/agent/loop", () => ({ callLlm: realCallLlm }));
});

afterAll(() => {
  mock.module("../src/agent/loop", () => ({ callLlm: realCallLlm }));
});

afterEach(() => {
  process.stdin.isTTY = originalIsTTY as boolean;
  // Always restore the REAL adapters, even if a test threw mid-run — a leaked fake
  // registration would silently break every OTHER test file sharing this Bun test
  // process (they all resolve "anthropic"/"openai" through the same singleton).
  providerRegistry.register("anthropic", realAnthropicAdapter);
  providerRegistry.register("openai", realOpenaiAdapter);
});

/** A minimal done-tool JSON reply — same shape the real prose/native tool-call
 *  protocol expects (engine.ts's `extractJsonObjectWithSpan`), ending the turn in
 *  exactly one step so this file exercises ONLY the rate-limit/fallback wiring, not
 *  the rest of the agent loop. */
function doneReply(model: string): string {
  return JSON.stringify({ tool: "done", arguments: { reason: `completed via ${model}` } });
}

/** Fake adapter: throws a real `ProviderHttpError` (status 429) for every model in
 *  `rateLimitedModels`, and returns a `done` reply for everything else. Records every
 *  wire-level `options.model` it was called with, in order, so a test can assert the
 *  REAL end-to-end call sequence without relying on any of launch.ts's/engine.ts's
 *  internal instrumentation (which this file deliberately never mocks). */
function fakeAdapter(name: "anthropic" | "openai", rateLimitedModels: Record<string, true>, log: string[]): ProviderAdapter {
  return {
    name,
    async call(_messages, options, _credential: Credential) {
      log.push(options.model);
      if (rateLimitedModels[options.model]) {
        throw new ProviderHttpError(name === "anthropic" ? "Anthropic" : "OpenAI", 429, "rate limited, please slow down");
      }
      return doneReply(options.model);
    },
  };
}

async function runOneShot(
  config: Record<string, unknown>,
  message: string,
): Promise<{ logs: string[] }> {
  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-rate-limit-live-chain-"));
  const savedCfg = process.env.JEO_CONFIG_DIR;
  const savedLog = console.log;
  const logs: string[] = [];
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    process.env.JEO_CONFIG_DIR = cfgDir;
    await fs.writeFile(path.join(cfgDir, "config.json"), JSON.stringify(config));

    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["--no-tui", "--no-session", "-p", message]);

    return { logs };
  } finally {
    console.log = savedLog;
    if (savedCfg === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = savedCfg;
    await fs.rm(cfgDir, { recursive: true, force: true });
  }
}

// --- (a) real chain: OAuth-subscription 429 bails the FIRST attempt (no ~90s ladder)
// and equivalentRouteFallback switches to a genuinely different credential scope. ---

test("real chain: an OAuth-subscription 429 bails the retry ladder on attempt #1 (sub-second, not ~60s+) and switches to a different-credential-scope model", async () => {
  await withRoutingProviderEnvCleared(async () => {
    const anthropicLog: string[] = [];
    const openaiLog: string[] = [];
    // claude-sonnet-4-6 AND claude-sonnet-5 both 429 (proves the fallback never just
    // retries a SIBLING model on the SAME exhausted anthropic:oauth subscription —
    // the exact bug cca5fe2 fixed) — only a genuinely different credential scope
    // (an API-key OpenAI model) can end the turn.
    providerRegistry.register(
      "anthropic",
      fakeAdapter("anthropic", { "claude-sonnet-4-6": true, "claude-sonnet-5": true }, anthropicLog),
    );
    providerRegistry.register("openai", fakeAdapter("openai", {}, openaiLog));

    const start = performance.now();
    const { logs } = await runOneShot(
      {
        providers: { openai: "sk-test-openai" },
        oauth: { anthropic: OAUTH_STAMP },
        defaultModel: "claude-sonnet-4-6",
        routing: { enabled: true },
      },
      "Update the styling in src/app.css to use a darker background color for the header.",
    );
    const elapsedMs = performance.now() - start;

    // Load-bearing timing assertion: a REAL backoff ladder floors at
    // DEFAULT_RATE_LIMIT_MIN_DELAY_MS (2000ms) for the very first retry sleep alone
    // (model-manager.ts's resolveRetryOptions) — completing in well under that proves
    // `onRetry` actually returned `false` and threw immediately instead of sleeping,
    // not that the call merely happened to succeed fast. A regressed bail condition
    // would sleep at least 2s before even reaching the fallback switch.
    expect(elapsedMs).toBeLessThan(1800);

    // Real engine.ts onRetry notice text fired (proves the bail branch, not a
    // generic auto-retry notice).
    const bailNotice = logs.find(l => l.includes("rate limited") && l.includes("switching instead of retrying"));
    expect(bailNotice).toBeDefined();

    // Anthropic was attempted exactly once (claude-sonnet-4-6) — claude-sonnet-5 is
    // the SAME oauth scope and must never be tried.
    expect(anthropicLog).toEqual(["claude-sonnet-4-6"]);
    // OpenAI's real resolveCall/withRetry chain actually ran and succeeded — the
    // turn ended on a genuinely different credential scope.
    expect(openaiLog).toHaveLength(1);
    expect(["gpt-5.4", "o3"]).toContain(openaiLog[0]);
  });
});

// --- (b) real chain regression guard: an API-key rate limit (credentialScopeFor ->
// null) correctly rides ONE extra same-provider, different-model attempt before
// escaping — the side-finding from the prior audit pass. Must NOT be "fixed" later
// into scope-excluding the whole provider like the OAuth-subscription case above. ---

test("real chain: an API-key rate limit rides one extra same-provider attempt before escaping (regression guard — null credentialScope must stay model-scoped, not provider-scoped)", async () => {
  await withRoutingProviderEnvCleared(async () => {
    const openaiLog: string[] = [];
    // Only gpt-4o-mini 429s; every other OpenAI model succeeds. No anthropic
    // credential at all in this config, so the trivial tier's ONLY candidates are
    // OpenAI models sharing ONE api-key (credentialScopeFor -> null for all of
    // them) — proving a null-scope 429 excludes just the failed id, not the whole
    // provider (an accidental "treat null like oauth-subscription" regression would
    // exclude every openai model and end the turn with zero fallback).
    providerRegistry.register("openai", fakeAdapter("openai", { "gpt-4o-mini": true }, openaiLog));

    const start = performance.now();
    const { logs } = await runOneShot(
      {
        providers: { openai: "sk-test-openai" },
        defaultModel: "gpt-4o-mini",
        roles: { smol: "gpt-4o-mini" },
        routing: { enabled: true },
      },
      "what is this?", // trivial, high heuristic confidence -> routes to roles.smol
    );
    const elapsedMs = performance.now() - start;

    // Same bail proof as test (a): the first (gpt-4o-mini) attempt must not sleep
    // through a real backoff before switching to the second model.
    expect(elapsedMs).toBeLessThan(1800);

    const bailNotice = logs.find(l => l.includes("rate limited") && l.includes("switching instead of retrying"));
    expect(bailNotice).toBeDefined();

    // Exactly TWO OpenAI attempts: the failed gpt-4o-mini, then ONE different
    // same-provider model that actually succeeded — proving the null scope excluded
    // only the exact failed id (never the whole provider/scope). gpt-4.1 is the
    // deterministic pick (no sessionId -> selectFromPool index 0 on the alphabetically
    // sorted, unclassified-tercile trivial pool — the same candidate the existing
    // "post-call reroute: recoverable failure on first fallback" test in
    // launch-prompt-routing.test.ts lands on as ITS third hop).
    expect(openaiLog).toEqual(["gpt-4o-mini", "gpt-4.1"]);
  });
});
