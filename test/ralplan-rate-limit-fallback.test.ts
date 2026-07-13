import { test, expect, mock, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Rate-limit fast fallback for `runConsensusCriticGate` (mirrors the same pattern
// wired into task-tool.ts's `runSubagentOnce` and launch.ts's turn-level
// `rateLimitFallbackAvailable` — see df3475d/cca5fe2/02b7e59's commit docs for the
// full design history). A single, non-fan-out subagent call: no batch-shared
// excludedCredentialScopes needed here. A bail-only predicate with no real
// reroute-and-retry loop around it would be a net regression (02b7e59's doc
// comment) — this gate pairs the predicate with an actual switch-and-retry.

const origCwd = process.cwd();
let cfgDir = "";
const origConfigDir = process.env.JEO_CONFIG_DIR;

// Ambient provider credentials (real dev-machine env vars) must never leak into
// these tests' credential-scope classification — mirrors
// test/launch-prompt-routing.test.ts's withRoutingProviderEnvCleared convention.
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

afterEach(async () => {
  process.chdir(origCwd);
  if (origConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = origConfigDir;
  if (cfgDir) await fs.rm(cfgDir, { recursive: true, force: true }).catch(() => {});
  cfgDir = "";
});

const OAUTH_STAMP = { access: "x", refresh: "x", expires: Date.now() + 1e9 };

async function writeConfig(config: Record<string, unknown>): Promise<void> {
  cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-ralplan-ratelimit-cfg-"));
  await fs.writeFile(path.join(cfgDir, "config.json"), JSON.stringify(config));
  process.env.JEO_CONFIG_DIR = cfgDir;
}

test("runConsensusCriticGate: 429 with a genuinely different-credential-scope fallback available switches models and completes", async () => {
  await withRoutingProviderEnvCleared(async () => {
    await writeConfig({
      // anthropic served via OAuth subscription (one shared rate-limit window);
      // openai served via an independent API key — a genuinely different
      // credential scope per credentialScopeFor's classification.
      providers: { openai: "sk-test-openai" },
      oauth: { anthropic: OAUTH_STAMP },
      defaultModel: "claude-sonnet-4-6",
      subagents: { critic: { model: "claude-sonnet-4-6" } },
    });

    const modelsCalled: (string | undefined)[] = [];
    const onRetryReturns: (void | false)[] = [];
    // mock.module boundary: runAgentLoop (engine.ts) resolves "../src/agent/loop"
    // dynamically inside invokeCallLlm, so ralplan.ts must be imported AFTER this
    // mock is registered (established convention — see ralplan-draft-model.test.ts).
    let fallbackCall = 0;
    await mock.module("../src/agent/loop", () => ({
      callLlm: async (_msgs: unknown, opts: { model?: string; onRetry?: (attempt: number, err: unknown, delayMs: number) => void | false }) => {
        modelsCalled.push(opts.model);
        if (opts.model === "claude-sonnet-4-6") {
          onRetryReturns.push(opts.onRetry?.(1, { status: 429, message: "rate limited" }, 2000));
          throw { status: 429, message: "Rate limited by Anthropic (HTTP 429)." };
        }
        fallbackCall++;
        // Fresh mkdtemp cwd (nothing written yet) — `find` with a broad pattern
        // still returns success:true (empty match list), unlike `read` which
        // would need a real file to exist.
        if (fallbackCall === 1) return JSON.stringify({ tool: "find", arguments: { globPattern: "*" } });
        return JSON.stringify({ tool: "done", arguments: { reason: "[OKAY]\nJustification: verified against the repo on the fallback model." } });
      },
    }));

    const { runConsensusCriticGate } = await import("../src/commands/ralplan");
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-ralplan-ratelimit-"));
    const res = await runConsensusCriticGate({
      cwd,
      seedContent: "goal: build a thing\nacceptance_criteria:\n  - it works\n",
      plan: 'name: "demo"\nsteps:\n  - name: "do it"\n    role: executor\n    target: "src/x.ts"\n',
    });

    // onRetry bailed (returned false) on the FIRST failed attempt — a fallback
    // WAS available, so the retry ladder never rode a backoff wait.
    expect(onRetryReturns).toEqual([false]);
    // Switched to gpt-5.4 (API-key-served, independent budget) — NEVER to
    // claude-sonnet-5 (same anthropic:oauth scope as the model that just 429'd).
    expect(modelsCalled).toEqual(["claude-sonnet-4-6", "gpt-5.4", "gpt-5.4"]);
    expect(res.verdict).toBe("okay");
    expect(res.detail).toContain("verified against the repo on the fallback model");

    await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
  });
});

test("runConsensusCriticGate: 429 with NO fallback available (single-provider config) still rides the normal retry ladder (regression guard)", async () => {
  await withRoutingProviderEnvCleared(async () => {
    await writeConfig({
      // Single provider (Anthropic OAuth only) — the standard-tier pool contains
      // only claude-sonnet-4-6/claude-sonnet-5, BOTH on the SAME anthropic:oauth
      // scope as the model currently 429ing. Genuinely no fallback candidate.
      providers: {},
      oauth: { anthropic: OAUTH_STAMP },
      defaultModel: "claude-sonnet-4-6",
      subagents: { critic: { model: "claude-sonnet-4-6" } },
    });

    const modelsCalled: (string | undefined)[] = [];
    const onRetryReturns: (void | false)[] = [];
    await mock.module("../src/agent/loop", () => ({
      callLlm: async (_msgs: unknown, opts: { model?: string; onRetry?: (attempt: number, err: unknown, delayMs: number) => void | false }) => {
        modelsCalled.push(opts.model);
        onRetryReturns.push(opts.onRetry?.(1, { status: 429, message: "rate limited" }, 4000));
        throw { status: 429, message: "Rate limited by Anthropic (HTTP 429)." };
      },
    }));

    const { runConsensusCriticGate } = await import("../src/commands/ralplan");
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-ralplan-ratelimit-"));
    const res = await runConsensusCriticGate({
      cwd,
      seedContent: "goal: build a thing\nacceptance_criteria:\n  - it works\n",
      plan: 'name: "demo"\nsteps:\n  - name: "do it"\n    role: executor\n    target: "src/x.ts"\n',
    });

    // onRetry did NOT bail — no candidate existed to switch to, so the engine
    // rides its normal notice-and-wait path exactly as if the fast-fallback
    // wiring were absent (never a bail with nothing to switch to — that would
    // just fail faster with an identical outcome, per 02b7e59's doc comment).
    expect(onRetryReturns).toEqual([undefined]);
    // Only ONE model was ever dispatched — no reroute switch happened.
    expect(modelsCalled).toEqual(["claude-sonnet-4-6"]);
    expect(res.verdict).toBe("unverified");
    expect(res.detail).toContain("HTTP 429");

    await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
  });
});
