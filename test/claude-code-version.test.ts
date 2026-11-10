import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  DEFAULT_CLAUDE_CODE_VERSION,
  _resetClaudeCodeVersionForTests,
  compareVersions,
  getClaudeCodeVersion,
  parseRequiredClaudeCodeVersion,
  raiseClaudeCodeVersion,
} from "../src/ai/claude-code-version";
import { anthropicAdapter } from "../src/ai/providers/anthropic";
import type { Message } from "../src/ai/types";
import type { Credential } from "../src/auth";

// Live failure this module exists for (fable-5-2 over OAuth):
//   HTTP 400 {"error":{"type":"invalid_request_error","message":"Claude Code 2.1.289 does not
//   support this model; version 2.1.290 or newer is required. ...","details":{"error_code":
//   "claude_code_version_too_old"}}}
// Contract: ONE version source for User-Agent + billing cc_version, env override wins, and the
// provider self-heals by re-sending once with the server's stated minimum.

const LIVE_400 = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "Claude Code 2.1.289 does not support this model; version 2.1.290 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.",
    details: { error_code: "claude_code_version_too_old" },
  },
  request_id: "req_test",
});

let prevEnv: string | undefined;
beforeEach(() => {
  prevEnv = process.env.JEO_CLAUDE_CODE_VERSION;
  delete process.env.JEO_CLAUDE_CODE_VERSION;
  _resetClaudeCodeVersionForTests();
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.JEO_CLAUDE_CODE_VERSION;
  else process.env.JEO_CLAUDE_CODE_VERSION = prevEnv;
  _resetClaudeCodeVersionForTests();
});

test("compareVersions: numeric dotted compare (not lexicographic), missing components read as 0", () => {
  expect(compareVersions("2.1.290", "2.1.289")).toBe(1);
  expect(compareVersions("2.1.289", "2.1.290")).toBe(-1);
  expect(compareVersions("2.1.300", "2.1.300")).toBe(0);
  expect(compareVersions("2.1.1000", "2.1.999")).toBe(1); // "1000" < "999" as strings
  expect(compareVersions("2.2", "2.1.999")).toBe(1);
  expect(compareVersions("2.1", "2.1.0")).toBe(0);
});

test("getClaudeCodeVersion: never below the shipped baseline, which itself clears the live 2.1.290 minimum", () => {
  expect(compareVersions(DEFAULT_CLAUDE_CODE_VERSION, "2.1.290")).toBeGreaterThanOrEqual(0);
  expect(compareVersions(getClaudeCodeVersion(), DEFAULT_CLAUDE_CODE_VERSION)).toBeGreaterThanOrEqual(0);
  expect(getClaudeCodeVersion()).toMatch(/^\d+\.\d+\.\d+$/);
});

test("getClaudeCodeVersion: JEO_CLAUDE_CODE_VERSION overrides everything (even a lower value, even a raised minimum); malformed values are ignored", () => {
  process.env.JEO_CLAUDE_CODE_VERSION = "2.1.100";
  expect(getClaudeCodeVersion()).toBe("2.1.100");
  // An override is authoritative — a server-raised minimum must not silently replace it.
  expect(raiseClaudeCodeVersion("2.1.999")).toBe(true);
  expect(getClaudeCodeVersion()).toBe("2.1.100");

  process.env.JEO_CLAUDE_CODE_VERSION = "latest";
  _resetClaudeCodeVersionForTests();
  expect(getClaudeCodeVersion()).not.toBe("latest");
  expect(getClaudeCodeVersion()).toMatch(/^\d+\.\d+\.\d+$/);
});

test("parseRequiredClaudeCodeVersion: both live wordings, and nothing for unrelated bodies", () => {
  expect(parseRequiredClaudeCodeVersion(LIVE_400)).toBe("2.1.290");
  expect(parseRequiredClaudeCodeVersion("claude_code_version_too_old: version 2.1.280 minimum")).toBe("2.1.280");
  // Error code present but no parseable version → undefined (caller must not retry blindly).
  expect(parseRequiredClaudeCodeVersion('{"details":{"error_code":"claude_code_version_too_old"}}')).toBeUndefined();
  // Unrelated 400s that happen to mention a version must not trigger the bump path.
  expect(parseRequiredClaudeCodeVersion("anthropic-version 2023-06-01 is required")).toBeUndefined();
  expect(parseRequiredClaudeCodeVersion("`temperature` is deprecated for this model.")).toBeUndefined();
  expect(parseRequiredClaudeCodeVersion("")).toBeUndefined();
});

test("raiseClaudeCodeVersion: monotonic — raises only above the current value, rejects malformed input, repeated/lower calls are no-ops", () => {
  const base = getClaudeCodeVersion();
  expect(raiseClaudeCodeVersion("not-a-version")).toBe(false);
  expect(raiseClaudeCodeVersion("0.0.1")).toBe(false);
  expect(raiseClaudeCodeVersion(base)).toBe(false);
  expect(getClaudeCodeVersion()).toBe(base);

  expect(raiseClaudeCodeVersion("9.9.9")).toBe(true);
  expect(getClaudeCodeVersion()).toBe("9.9.9");
  expect(raiseClaudeCodeVersion("9.9.9")).toBe(false); // same again → no change
  expect(raiseClaudeCodeVersion("9.9.8")).toBe(false); // lower → no change
  expect(getClaudeCodeVersion()).toBe("9.9.9");
});

// ── Wire: provider self-heals on claude_code_version_too_old ───────────────────────────────

type Captured = { headers: Record<string, string>; body: { model: string; system?: { text: string }[] } };
const oauthCred: Credential = { kind: "oauth", provider: "anthropic", token: "test-oauth-token" };
const messages: Message[] = [{ role: "user", content: "hi" }];

function advertised(req: Captured): { userAgent?: string; billing?: string } {
  return {
    userAgent: /^claude-cli\/(\d+\.\d+\.\d+)(?:\s|$)/.exec(req.headers["user-agent"] ?? "")?.[1],
    billing: /cc_version=(\d+\.\d+\.\d+)(?:\.[0-9a-f]+)?;/.exec(req.body.system?.[0]?.text ?? "")?.[1],
  };
}

function stubFetch(respond: (req: Captured, n: number) => Response): { calls: Captured[]; restore: () => void } {
  const prev = globalThis.fetch;
  const calls: Captured[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const req: Captured = { headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) };
    calls.push(req);
    return respond(req, calls.length);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = prev; } };
}

function tooOld(required: string): Response {
  return new Response(
    JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `Claude Code 2.1.289 does not support this model; version ${required} or newer is required. Run 'claude update'.`, details: { error_code: "claude_code_version_too_old" } } }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

const ok = () => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 3, output_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });

test("anthropicAdapter.call (OAuth, fable-5-2): a 400 claude_code_version_too_old is re-sent ONCE with User-Agent AND billing cc_version raised to the server's minimum", async () => {
  const REQUIRED = "2.1.400";
  const net = stubFetch((req, n) => {
    const { userAgent, billing } = advertised(req);
    const accepted = [userAgent, billing].every(v => v !== undefined && compareVersions(v, REQUIRED) >= 0);
    return accepted ? ok() : tooOld(REQUIRED);
  });
  try {
    const first = getClaudeCodeVersion();
    expect(compareVersions(first, REQUIRED)).toBeLessThan(0); // the stub's floor is above what we ship
    const text = await anthropicAdapter.call(messages, { model: "anthropic/claude-fable-5-2", maxTokens: 50 }, oauthCred);
    expect(text).toBe("ok");
    expect(net.calls.length).toBe(2);
    expect(net.calls[0]!.body.model).toBe("claude-fable-5-2");
    expect(advertised(net.calls[0]!)).toEqual({ userAgent: first, billing: first });
    expect(advertised(net.calls[1]!)).toEqual({ userAgent: REQUIRED, billing: REQUIRED });
    // The raise is process-wide: the NEXT request starts at the raised version (no second 400).
    expect(getClaudeCodeVersion()).toBe(REQUIRED);
  } finally {
    net.restore();
  }
});

test("anthropicAdapter.call (OAuth): the version bump is one-shot — a server that keeps rejecting surfaces the 400 after exactly two fetches", async () => {
  const net = stubFetch((_req, n) => tooOld(n === 1 ? "2.1.500" : "2.1.600"));
  try {
    let error: string | undefined;
    try {
      await anthropicAdapter.call(messages, { model: "claude-fable-5-2", maxTokens: 50 }, oauthCred);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    expect(error).toContain("claude_code_version_too_old");
    expect(net.calls.length).toBe(2);
    expect(advertised(net.calls[1]!).userAgent).toBe("2.1.500");
  } finally {
    net.restore();
  }
});

test("anthropicAdapter.call (OAuth): a 400 WITHOUT the version error code never triggers the bump path (single fetch, version untouched)", async () => {
  const before = getClaudeCodeVersion();
  const net = stubFetch(() => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens: must be >= 1" } }), { status: 400 }));
  try {
    await expect(anthropicAdapter.call(messages, { model: "claude-fable-5-2", maxTokens: 50 }, oauthCred)).rejects.toThrow(/max_tokens/);
    expect(net.calls.length).toBe(1);
    expect(getClaudeCodeVersion()).toBe(before);
  } finally {
    net.restore();
  }
});
