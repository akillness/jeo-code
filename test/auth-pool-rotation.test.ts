import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  setOauthCredential,
  setOauthToken,
  getStoredOAuthPool,
  resolveCredential,
  rotateCredential,
  hasUnblockedPoolSibling,
  addApiKeyToPool,
  removeApiKeyFromPool,
  removeOAuthAccount,
  selectAuthAccount,
  clearAuthCooldown,
  resetAuthPoolState,
  snapshotProvider,
  loginOAuth,
} from "../src/auth";
import { clearConfigReadCache, readRawGlobalConfig } from "../src/agent/state";
import type { StoredOAuth } from "../src/agent/state";
import { createModelManager } from "../src/ai/model-manager";
import { runAuthCommand } from "../src/commands/auth";
import { complete, staticCompletionContext, type CompletionContext } from "../src/tui/components/autocomplete";
import { loginHint, subscriptionHint, apiKeyHint } from "../src/tui/components/provider-picker";
import type { ProviderStatus } from "../src/ai/provider-status";

const ENV_KEYS = [
  "ANTHROPIC_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_OAUTH_TOKEN",
  "GEMINI_API_KEY",
  "GEMINI_OAUTH_TOKEN",
] as const;

let tmpHome = "";
let prevConfigDir: string | undefined;
let prevFetch: typeof globalThis.fetch;
let prevExitCode: number | undefined;
const savedEnv = new Map<string, string | undefined>();

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-auth-pool-"));
  prevConfigDir = process.env.JEO_CONFIG_DIR;
  process.env.JEO_CONFIG_DIR = path.join(tmpHome, ".jeo");
  prevFetch = globalThis.fetch;
  prevExitCode = process.exitCode;
  process.exitCode = undefined;

  savedEnv.clear();
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }

  clearConfigReadCache();
  await resetAuthPoolState();
});

afterEach(async () => {
  globalThis.fetch = prevFetch;
  process.exitCode = prevExitCode;
  await resetAuthPoolState();
  clearConfigReadCache();

  if (prevConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = prevConfigDir;

  for (const [key, val] of savedEnv.entries()) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }

  if (tmpHome) {
    await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  }
});

function getHeader(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    const pair = headers.find(([k]) => k.toLowerCase() === name.toLowerCase());
    return pair?.[1];
  }
  const record = headers as Record<string, string | undefined>;
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() === name.toLowerCase()) return v;
  }
  return undefined;
}

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const evt of events) {
        controller.enqueue(encoder.encode(evt));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function captureConsoleLog(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(a => String(a)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = origLog;
  }
  return lines.join("\n");
}

test("OAuth pool upsert & deduplication: 3 distinct accounts append, same email updates in place, replaceAll resets to 1", async () => {
  const future = Date.now() + 3_600_000;

  const r1 = await setOauthCredential("anthropic", {
    access: "tok-alice-v1",
    refresh: "ref-alice-v1",
    expires: future,
    email: "alice@example.com",
    projectId: "proj-alice",
  });
  expect(r1).toEqual({ poolSize: 1, index: 0, added: true });

  const r2 = await setOauthCredential("anthropic", {
    access: "tok-bob-v1",
    refresh: "ref-bob-v1",
    expires: future,
    email: "bob@example.com",
  });
  expect(r2).toEqual({ poolSize: 2, index: 1, added: true });

  const r3 = await setOauthCredential("anthropic", {
    access: "tok-charlie-v1",
    refresh: "ref-charlie-v1",
    expires: future,
    accountId: "acct-charlie-001",
  });
  expect(r3).toEqual({ poolSize: 3, index: 2, added: true });

  // Re-logging in with the same email (even with different casing) updates slot 0 in place
  // and preserves existing projectId when not re-supplied.
  const rAliceUpdate = await setOauthCredential("anthropic", {
    access: "tok-alice-v2",
    refresh: "ref-alice-v2",
    expires: future + 60_000,
    email: "ALICE@example.com",
  });
  expect(rAliceUpdate).toEqual({ poolSize: 3, index: 0, added: false });

  const pool = await getStoredOAuthPool("anthropic");
  expect(pool).toHaveLength(3);
  const slot0 = pool[0] as StoredOAuth;
  const slot1 = pool[1] as StoredOAuth;
  const slot2 = pool[2] as StoredOAuth;
  expect(slot0.access).toBe("tok-alice-v2");
  expect(slot0.refresh).toBe("ref-alice-v2");
  expect(slot0.projectId).toBe("proj-alice");
  expect(slot1.access).toBe("tok-bob-v1");
  expect(slot2.access).toBe("tok-charlie-v1");

  // `--replace` (replaceAll: true) replaces the entire 3-account pool with 1 entry.
  const rReplace = await setOauthCredential(
    "anthropic",
    {
      access: "tok-solo",
      refresh: "ref-solo",
      expires: future,
      email: "solo@example.com",
    },
    { replaceAll: true },
  );
  expect(rReplace).toEqual({ poolSize: 1, index: 0, added: true });

  const afterReplace = await getStoredOAuthPool("anthropic");
  expect(afterReplace).toHaveLength(1);
  const replacedSlot = afterReplace[0] as StoredOAuth;
  expect(replacedSlot.access).toBe("tok-solo");

  // Single-entry pool is compacted to a non-array entry on disk for backward compatibility.
  const raw = await readRawGlobalConfig();
  expect(Array.isArray(raw.oauth?.anthropic)).toBe(false);

  // Manual token replaceAll also resets pool to 1 entry.
  await setOauthToken("anthropic", "manual-bearer-2");
  expect(await getStoredOAuthPool("anthropic")).toHaveLength(2);
  const rTokenReplace = await setOauthToken("anthropic", "manual-bearer-only", { replaceAll: true });
  expect(rTokenReplace).toEqual({ poolSize: 1, index: 0, added: true });
  expect(await getStoredOAuthPool("anthropic")).toEqual(["manual-bearer-only"]);
});

test("Circular rotation (rotateCredential & resolveCredential): rotates 1 -> 2 -> 3 on limits and wraps 3 -> 1 once cooldown clears", async () => {
  const future = Date.now() + 3_600_000;
  await setOauthCredential("anthropic", {
    access: "tok-1",
    refresh: "ref-1",
    expires: future,
    email: "acct1@example.com",
  });
  await setOauthCredential("anthropic", {
    access: "tok-2",
    refresh: "ref-2",
    expires: future,
    email: "acct2@example.com",
  });
  await setOauthCredential("anthropic", {
    access: "tok-3",
    refresh: "ref-3",
    expires: future,
    email: "acct3@example.com",
  });

  // Starts on account 1.
  const c1 = await resolveCredential("anthropic", { sessionKey: "sess-a" });
  expect(c1.kind).toBe("oauth");
  if (c1.kind !== "oauth") throw new Error("expected oauth credential");
  expect(c1.token).toBe("tok-1");
  expect((await snapshotProvider("anthropic")).accounts?.find(a => a.active)?.index).toBe(0);
  expect(await hasUnblockedPoolSibling("anthropic", c1)).toBe(true);

  // Account 1 hits usage limit -> rotates 1 -> 2.
  const rot12 = await rotateCredential(
    "anthropic",
    c1,
    new Error("HTTP 429: usage_limit_reached"),
    { sessionKey: "sess-a" },
  );
  expect(rot12.rotated).toBe(true);
  expect(rot12.fromIndex).toBe(0);
  expect(rot12.toIndex).toBe(1);
  expect(rot12.total).toBe(3);
  expect(rot12.reason).toBe("usage_limit");
  expect(rot12.fromLabel).toBe("acct1@example.com");
  expect(rot12.toLabel).toBe("acct2@example.com");
  expect(rot12.credential.kind === "oauth" && rot12.credential.token).toBe("tok-2");

  const c2 = await resolveCredential("anthropic", { sessionKey: "sess-a" });
  expect(c2.kind === "oauth" && c2.token).toBe("tok-2");
  expect(await hasUnblockedPoolSibling("anthropic", c2)).toBe(true);

  // Account 2 hits rate limit -> rotates 2 -> 3.
  const rot23 = await rotateCredential(
    "anthropic",
    c2,
    new Error("HTTP 429: Rate limit exceeded"),
    { sessionKey: "sess-a" },
  );
  expect(rot23.rotated).toBe(true);
  expect(rot23.fromIndex).toBe(1);
  expect(rot23.toIndex).toBe(2);
  expect(rot23.total).toBe(3);
  expect(rot23.reason).toBe("rate_limit");
  expect(rot23.credential.kind === "oauth" && rot23.credential.token).toBe("tok-3");

  const c3 = await resolveCredential("anthropic", { sessionKey: "sess-a" });
  expect(c3.kind === "oauth" && c3.token).toBe("tok-3");
  // Accounts 1 & 2 are both cooling down, so account 3 has no unblocked sibling right now.
  expect(await hasUnblockedPoolSibling("anthropic", c3)).toBe(false);

  // If account 3 also hits a limit while 1 & 2 are still blocked, rotation reports exhausted with earliestUnblockAt.
  const rotBlocked = await rotateCredential(
    "anthropic",
    c3,
    new Error("HTTP 429: Rate limit exceeded"),
    { sessionKey: "sess-a" },
  );
  expect(rotBlocked.rotated).toBe(false);
  expect(rotBlocked.earliestUnblockAt).toBeGreaterThan(Date.now());

  // Clear cooldown (or let it expire) -> rotating from account 3 wraps circularly 3 -> 1.
  await clearAuthCooldown("anthropic");
  expect(await hasUnblockedPoolSibling("anthropic", c3)).toBe(true);

  const rot31 = await rotateCredential(
    "anthropic",
    c3,
    new Error("HTTP 429: Rate limit exceeded"),
    { sessionKey: "sess-a" },
  );
  expect(rot31.rotated).toBe(true);
  expect(rot31.fromIndex).toBe(2);
  expect(rot31.toIndex).toBe(0);
  expect(rot31.total).toBe(3);
  expect(rot31.toLabel).toBe("acct1@example.com");
  expect(rot31.credential.kind === "oauth" && rot31.credential.token).toBe("tok-1");

  const cWrapped = await resolveCredential("anthropic", { sessionKey: "sess-a" });
  expect(cWrapped.kind === "oauth" && cWrapped.token).toBe("tok-1");
});

test("Per-slot definitive refresh failure: invalid_grant on expired slot 1 removes only slot 1 and returns healthy slot 2", async () => {
  await setOauthCredential("anthropic", {
    access: "tok-expired-1",
    refresh: "ref-revoked-1",
    expires: Date.now() - 120_000,
    email: "dead@example.com",
  });
  await setOauthCredential("anthropic", {
    access: "tok-healthy-2",
    refresh: "ref-healthy-2",
    expires: Date.now() + 3_600_000,
    email: "healthy@example.com",
  });

  const refreshCalls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "https://api.anthropic.com/v1/oauth/token") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { refresh_token?: string };
      refreshCalls.push(body.refresh_token ?? "");
      return new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "Refresh token has been revoked" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  const resolved = await resolveCredential("anthropic");
  expect(refreshCalls).toEqual(["ref-revoked-1"]);
  expect(resolved.kind).toBe("oauth");
  if (resolved.kind !== "oauth") throw new Error("expected oauth credential");
  expect(resolved.token).toBe("tok-healthy-2");
  expect((await snapshotProvider("anthropic")).oauthEmail).toBe("healthy@example.com");

  const remainingPool = await getStoredOAuthPool("anthropic");
  expect(remainingPool).toHaveLength(1);
  const survivor = remainingPool[0] as StoredOAuth;
  expect(survivor.email).toBe("healthy@example.com");
  expect(survivor.access).toBe("tok-healthy-2");
});

test("Live createModelManager().call() circular failover: rotates across 429 usage/rate limits to account 3 without sleeping and sticks to account 3", async () => {
  const future = Date.now() + 3_600_000;
  await setOauthCredential("anthropic", {
    access: "oauth-tok-1",
    refresh: "ref-1",
    expires: future,
    email: "first@example.com",
  });
  await setOauthCredential("anthropic", {
    access: "oauth-tok-2",
    refresh: "ref-2",
    expires: future,
    email: "second@example.com",
  });
  await setOauthCredential("anthropic", {
    access: "oauth-tok-3",
    refresh: "ref-3",
    expires: future,
    email: "third@example.com",
  });

  const seenAuthHeaders: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const auth = getHeader(init, "authorization") ?? "";
    seenAuthHeaders.push(auth);

    if (auth === "Bearer oauth-tok-1") {
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "usage_limit_reached: monthly quota exhausted" },
        }),
        {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "3600" },
        },
      );
    }
    if (auth === "Bearer oauth-tok-2") {
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "Rate limit exceeded: too many requests" },
        }),
        {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "60" },
        },
      );
    }
    if (auth === "Bearer oauth-tok-3") {
      return new Response(
        JSON.stringify({
          model: "claude-sonnet-4-6",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "ok-from-account-3" }],
          usage: { input_tokens: 8, output_tokens: 4 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected authorization header: ${auth}`);
  }) as typeof fetch;

  const manager = createModelManager();
  const notices: string[] = [];
  const startedAt = Date.now();
  const reply = await manager.call([{ role: "user", content: "ping" }], {
    model: "claude-sonnet-4-6",
    onNotice: msg => notices.push(msg),
  });
  const elapsedMs = Date.now() - startedAt;

  expect(reply).toBe("ok-from-account-3");
  expect(elapsedMs).toBeLessThan(1_000);
  expect(seenAuthHeaders).toEqual([
    "Bearer oauth-tok-1",
    "Bearer oauth-tok-2",
    "Bearer oauth-tok-3",
  ]);
  expect(notices).toEqual([
    "[auth-pool] anthropic account #1 (first@example.com) hit usage limit — rotating to account #2/3 (second@example.com)",
    "[auth-pool] anthropic account #2 (second@example.com) hit rate limit — rotating to account #3/3 (third@example.com)",
  ]);

  // Subsequent calls start directly on account 3 without re-hitting cooled-down accounts 1 or 2.
  seenAuthHeaders.length = 0;
  notices.length = 0;
  const secondReply = await manager.call([{ role: "user", content: "ping again" }], {
    model: "claude-sonnet-4-6",
    onNotice: msg => notices.push(msg),
  });
  expect(secondReply).toBe("ok-from-account-3");
  expect(seenAuthHeaders).toEqual(["Bearer oauth-tok-3"]);
  expect(notices).toEqual([]);
});

test("Live createModelManager().stream() rotates before first chunk, but NEVER replays or rotates after yielding a chunk", async () => {
  const future = Date.now() + 3_600_000;
  await setOauthCredential("anthropic", {
    access: "stream-tok-1",
    refresh: "ref-s1",
    expires: future,
    email: "s1@example.com",
  });
  await setOauthCredential("anthropic", {
    access: "stream-tok-2",
    refresh: "ref-s2",
    expires: future,
    email: "s2@example.com",
  });
  await setOauthCredential("anthropic", {
    access: "stream-tok-3",
    refresh: "ref-s3",
    expires: future,
    email: "s3@example.com",
  });

  const seenAuthHeaders: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const auth = getHeader(init, "authorization") ?? "";
    seenAuthHeaders.push(auth);

    if (auth === "Bearer stream-tok-1") {
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "usage_limit_reached" },
        }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": "120" } },
      );
    }
    if (auth === "Bearer stream-tok-2") {
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "Rate limit exceeded" },
        }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": "30" } },
      );
    }
    if (auth === "Bearer stream-tok-3") {
      return sseResponse([
        'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]);
    }
    throw new Error(`Unexpected authorization header: ${auth}`);
  }) as typeof fetch;

  const manager = createModelManager();
  const notices: string[] = [];
  const chunks: string[] = [];
  for await (const chunk of manager.stream([{ role: "user", content: "stream hi" }], {
    model: "claude-sonnet-4-6",
    onNotice: msg => notices.push(msg),
  })) {
    chunks.push(chunk);
  }

  expect(chunks).toEqual(["Hello ", "world"]);
  expect(seenAuthHeaders).toEqual([
    "Bearer stream-tok-1",
    "Bearer stream-tok-2",
    "Bearer stream-tok-3",
  ]);
  expect(notices).toEqual([
    "[auth-pool] anthropic account #1 (s1@example.com) hit usage limit — rotating to account #2/3 (s2@example.com)",
    "[auth-pool] anthropic account #2 (s2@example.com) hit rate limit — rotating to account #3/3 (s3@example.com)",
  ]);

  // Now test mid-stream failure AFTER yielding a chunk:
  // Clear cooldowns so stream-tok-3 has unblocked siblings available, then have stream-tok-3
  // yield one text chunk before throwing a mid-stream rate_limit_error event.
  await clearAuthCooldown("anthropic");
  seenAuthHeaders.length = 0;
  notices.length = 0;

  globalThis.fetch = (async (_input, init) => {
    const auth = getHeader(init, "authorization") ?? "";
    seenAuthHeaders.push(auth);
    if (auth === "Bearer stream-tok-3") {
      return sseResponse([
        'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial-chunk"}}\n\n',
        'data: {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded mid-stream"}}\n\n',
      ]);
    }
    return sseResponse([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"should-never-run"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]);
  }) as typeof fetch;

  const partialChunks: string[] = [];
  let caughtMidStream: unknown;
  try {
    for await (const chunk of manager.stream([{ role: "user", content: "mid-stream fail" }], {
      model: "claude-sonnet-4-6",
      onNotice: msg => notices.push(msg),
    })) {
      partialChunks.push(chunk);
    }
  } catch (err) {
    caughtMidStream = err;
  }

  expect(partialChunks).toEqual(["partial-chunk"]);
  expect(caughtMidStream).toBeInstanceOf(Error);
  const midStreamErr = caughtMidStream instanceof Error ? caughtMidStream : new Error(String(caughtMidStream));
  expect(midStreamErr.message).toContain("Rate limit exceeded mid-stream");
  // Must NOT rotate or replay onto sibling accounts after emitting output.
  expect(seenAuthHeaders).toEqual(["Bearer stream-tok-3"]);
  expect(notices).toEqual([]);
});

test("API-key pool circular failover on HTTP 429 and CLI commands (pool, use, rotate, logout)", async () => {
  const k1 = await addApiKeyToPool("anthropic", "sk-ant-pool-1111");
  const k2 = await addApiKeyToPool("anthropic", "sk-ant-pool-2222");
  const k3 = await addApiKeyToPool("anthropic", "sk-ant-pool-3333");
  const kDup = await addApiKeyToPool("anthropic", "sk-ant-pool-2222");

  expect(k1).toEqual({ added: true, poolSize: 1 });
  expect(k2).toEqual({ added: true, poolSize: 2 });
  expect(k3).toEqual({ added: true, poolSize: 3 });
  expect(kDup).toEqual({ added: false, poolSize: 3 });

  const seenApiKeys: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const apiKey = getHeader(init, "x-api-key") ?? "";
    seenApiKeys.push(apiKey);
    if (apiKey === "sk-ant-pool-1111") {
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "Rate limit exceeded" },
        }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": "45" } },
      );
    }
    return new Response(
      JSON.stringify({
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: `served-by-${apiKey}` }],
        usage: { input_tokens: 4, output_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const manager = createModelManager();
  const notices: string[] = [];
  const res = await manager.call([{ role: "user", content: "key pool test" }], {
    model: "claude-sonnet-4-6",
    onNotice: msg => notices.push(msg),
  });

  expect(res).toBe("served-by-sk-ant-pool-2222");
  expect(seenApiKeys).toEqual(["sk-ant-pool-1111", "sk-ant-pool-2222"]);
  expect(notices).toEqual([
    "[auth-pool] anthropic account #1 (sk-a...1111) hit rate limit — rotating to account #2/3 (sk-a...2222)",
  ]);

  // CLI: `jeo auth pool list anthropic` shows the 3 keys and active marker on #2.
  const listOut = await captureConsoleLog(() => runAuthCommand(["pool", "list", "anthropic"]));
  expect(listOut).toContain("anthropic (3 credentials):");
  expect(listOut).toContain("* [2] api_key sk-a...2222");

  // CLI: `jeo auth use anthropic 3` switches active key to #3.
  const useOut = await captureConsoleLog(() => runAuthCommand(["use", "anthropic", "3"]));
  expect(useOut).toContain("[SUCCESS] Active anthropic account → [3/3]");
  const afterUse = await resolveCredential("anthropic");
  expect(afterUse.kind === "api_key" && afterUse.token).toBe("sk-ant-pool-3333");

  // CLI: `jeo auth rotate anthropic` wraps circularly 3 -> 1 (and clears cooldown on selected slot).
  const rotateOut = await captureConsoleLog(() => runAuthCommand(["rotate", "anthropic"]));
  expect(rotateOut).toContain("[SUCCESS] Rotated anthropic account → [1/3]");
  const afterRotate = await resolveCredential("anthropic");
  expect(afterRotate.kind === "api_key" && afterRotate.token).toBe("sk-ant-pool-1111");

  // CLI: `jeo auth pool remove anthropic 2` removes key #2, leaving 2 keys.
  const removeOut = await captureConsoleLog(() => runAuthCommand(["pool", "remove", "anthropic", "2"]));
  expect(removeOut).toContain("[SUCCESS] Removed API key '2' from anthropic pool (remaining: 2).");
  const snapAfterKeyRemove = await snapshotProvider("anthropic");
  expect(snapAfterKeyRemove.apiKeyPoolSize).toBe(2);

  // CLI: `jeo auth logout <provider> <selector>` removes only the matching OAuth account.
  await removeApiKeyFromPool("anthropic");
  const future = Date.now() + 3_600_000;
  await setOauthCredential("anthropic", {
    access: "oauth-a",
    refresh: "ref-a",
    expires: future,
    email: "alpha@example.com",
  });
  await setOauthCredential("anthropic", {
    access: "oauth-b",
    refresh: "ref-b",
    expires: future,
    email: "beta@example.com",
  });

  const logoutOut = await captureConsoleLog(() =>
    runAuthCommand(["logout", "anthropic", "alpha@example.com"]),
  );
  expect(logoutOut).toContain("[SUCCESS] Removed OAuth account 'alpha@example.com' from anthropic pool.");

  const remainingOAuth = await getStoredOAuthPool("anthropic");
  expect(remainingOAuth).toHaveLength(1);
  const survivorOAuth = remainingOAuth[0] as StoredOAuth;
  expect(survivorOAuth.email).toBe("beta@example.com");

  // Also verify direct removeOAuthAccount / selectAuthAccount helpers.
  await setOauthCredential("anthropic", {
    access: "oauth-c",
    refresh: "ref-c",
    expires: future,
    email: "gamma@example.com",
  });
  const selected = await selectAuthAccount("anthropic", "gamma@example.com");
  expect(selected.selected).toBe(true);
  expect(selected.index).toBe(1);
  const removed = await removeOAuthAccount("anthropic", 1);
  expect(removed).toEqual({
    removed: true,
    remaining: 1,
    removedLabel: "beta@example.com",
  });
});

test("loginOAuth appends multi-account OAuth tokens and ModelManager rotates circularly between tok-1 and tok-2 on HTTP 429", async () => {
  const r1 = await loginOAuth("anthropic", "tok-1");
  const r2 = await loginOAuth("anthropic", "tok-2");
  expect(r1).toEqual({ poolSize: 1, added: true });
  expect(r2).toEqual({ poolSize: 2, added: true });
  expect(await getStoredOAuthPool("anthropic")).toEqual(["tok-1", "tok-2"]);

  const seenAuthHeaders: string[] = [];
  let failToken = "Bearer tok-1";
  globalThis.fetch = (async (_input, init) => {
    const auth = getHeader(init, "authorization") ?? "";
    seenAuthHeaders.push(auth);
    if (auth === failToken) {
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "Rate limit exceeded" },
        }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": "60" } },
      );
    }
    const label = auth.replace(/^Bearer\s+/, "");
    return new Response(
      JSON.stringify({
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: `ok-from-${label}` }],
        usage: { input_tokens: 4, output_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const manager = createModelManager();
  const firstReply = await manager.call([{ role: "user", content: "ping-1" }], {
    model: "claude-sonnet-4-6",
  });
  expect(firstReply).toBe("ok-from-tok-2");
  expect(seenAuthHeaders).toEqual(["Bearer tok-1", "Bearer tok-2"]);

  // Clear cooldown and rate-limit tok-2 to verify circular wrap 2 -> 1.
  await clearAuthCooldown("anthropic");
  seenAuthHeaders.length = 0;
  failToken = "Bearer tok-2";

  const secondReply = await manager.call([{ role: "user", content: "ping-2" }], {
    model: "claude-sonnet-4-6",
  });
  expect(secondReply).toBe("ok-from-tok-1");
  expect(seenAuthHeaders).toEqual(["Bearer tok-2", "Bearer tok-1"]);
});

test("addApiKeyToPool appends openai API keys and ModelManager rotates circularly between sk-1 and sk-2 on HTTP 429", async () => {
  const k1 = await addApiKeyToPool("openai", "sk-1");
  const k2 = await addApiKeyToPool("openai", "sk-2");
  expect(k1).toEqual({ added: true, poolSize: 1 });
  expect(k2).toEqual({ added: true, poolSize: 2 });

  const raw = await readRawGlobalConfig();
  expect(raw.providers?.openai).toBe("sk-1");
  expect(raw.providerPools?.openai).toEqual(["sk-2"]);

  const seenAuthHeaders: string[] = [];
  let failToken = "Bearer sk-1";
  globalThis.fetch = (async (_input, init) => {
    const auth = getHeader(init, "authorization") ?? "";
    seenAuthHeaders.push(auth);
    if (auth === failToken) {
      return new Response(
        JSON.stringify({
          error: { message: "Rate limit exceeded", type: "rate_limit_error" },
        }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": "60" } },
      );
    }
    const label = auth.replace(/^Bearer\s+/, "");
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: `ok-from-${label}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const manager = createModelManager();
  const firstReply = await manager.call([{ role: "user", content: "ping-1" }], {
    model: "gpt-4o",
  });
  expect(firstReply).toBe("ok-from-sk-2");
  expect(seenAuthHeaders).toEqual(["Bearer sk-1", "Bearer sk-2"]);

  // Clear cooldown and rate-limit sk-2 to verify circular wrap 2 -> 1.
  await clearAuthCooldown("openai");
  seenAuthHeaders.length = 0;
  failToken = "Bearer sk-2";

  const secondReply = await manager.call([{ role: "user", content: "ping-2" }], {
    model: "gpt-4o",
  });
  expect(secondReply).toBe("ok-from-sk-1");
  expect(seenAuthHeaders).toEqual(["Bearer sk-2", "Bearer sk-1"]);
});

test("autocomplete exposes pool under /provider and kimi under /login and /logout", () => {
  const ctx: CompletionContext = {
    ...staticCompletionContext(),
    liveModels: [],
    aliases: [],
    modelsForProvider: () => [],
  };

  const providerRes = complete("/provider ", ctx);
  expect(providerRes.kind).toBe("subcommand");
  expect(providerRes.completions).toContain("pool");

  const loginRes = complete("/login ", ctx);
  expect(loginRes.kind).toBe("provider");
  expect(loginRes.completions).toContain("kimi");

  const logoutRes = complete("/logout ", ctx);
  expect(logoutRes.kind).toBe("provider");
  expect(logoutRes.completions).toContain("kimi");
});

test("oauthIdentityKey prioritizes refresh over projectId so two antigravity accounts sharing projectId do not collide", async () => {
  const future = Date.now() + 3_600_000;

  const r1 = await setOauthCredential("antigravity", {
    access: "tok-ag-1",
    refresh: "ref-shared-1",
    expires: future,
    projectId: "shared-proj",
  });
  expect(r1).toEqual({ poolSize: 1, index: 0, added: true });

  const r2 = await setOauthCredential("antigravity", {
    access: "tok-ag-2",
    refresh: "ref-shared-2",
    expires: future,
    projectId: "shared-proj",
  });
  expect(r2).toEqual({ poolSize: 2, index: 1, added: true });

  const pool = await getStoredOAuthPool("antigravity");
  expect(pool).toHaveLength(2);
  const snap = await snapshotProvider("antigravity");
  expect(snap.poolSize).toBe(2);

  // Re-upserting with the first refresh token updates slot 0 in place rather than adding a 3rd slot.
  const r1Update = await setOauthCredential("antigravity", {
    access: "tok-ag-1-refreshed",
    refresh: "ref-shared-1",
    expires: future + 60_000,
    projectId: "shared-proj",
  });
  expect(r1Update).toEqual({ poolSize: 2, index: 0, added: false });
});

test("setOauthToken extracts OpenAI profile email from JWT payload into snapshotProvider", async () => {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/profile": { email: "u@example.com" } }),
  ).toString("base64url");
  const jwt = `${header}.${payload}.sig`;

  const res = await setOauthToken("openai", jwt);
  expect(res).toEqual({ poolSize: 1, index: 0, added: true });

  const snap = await snapshotProvider("openai");
  expect(snap.poolSize).toBe(1);
  expect(snap.oauthEmail).toBe("u@example.com");
  expect(snap.accounts?.[0]?.email).toBe("u@example.com");
  expect(snap.accounts?.[0]?.identityKey).toBe("openai:email:u@example.com");
});

test("ModelManager.stream and call rotate on Antigravity RESOURCE_EXHAUSTED, HTTP 400 credit balance, and HTTP 529 overloaded_error", async () => {
  const future = Date.now() + 3_600_000;
  const manager = createModelManager();

  // 1) Antigravity SSE in-band error: ProviderStreamError("Antigravity", "Resource exhausted", "RESOURCE_EXHAUSTED", 429)
  await setOauthCredential("antigravity", {
    access: "ag-tok-1",
    refresh: "ag-ref-1",
    expires: future,
    projectId: "proj-ag-1",
    email: "ag1@example.com",
  });
  await setOauthCredential("antigravity", {
    access: "ag-tok-2",
    refresh: "ag-ref-2",
    expires: future,
    projectId: "proj-ag-2",
    email: "ag2@example.com",
  });

  const seenAgAuth: string[] = [];
  let failAgAuth = "Bearer ag-tok-1";
  globalThis.fetch = (async (_input, init) => {
    const auth = getHeader(init, "authorization") ?? "";
    seenAgAuth.push(auth);
    if (auth === failAgAuth) {
      return sseResponse([
        'data: {"error":{"code":429,"message":"Resource exhausted","status":"RESOURCE_EXHAUSTED"}}\n\n',
      ]);
    }
    const label = auth.replace(/^Bearer\s+/, "");
    return sseResponse([
      `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: `ok-from-${label}` }] }, finishReason: "STOP" }] } })}\n\n`,
    ]);
  }) as typeof fetch;

  const agNotices: string[] = [];
  const agChunks: string[] = [];
  for await (const chunk of manager.stream([{ role: "user", content: "hi" }], {
    model: "antigravity/gemini-4-hydrogen-high",
    onNotice: msg => agNotices.push(msg),
  })) {
    agChunks.push(chunk);
  }
  expect(agChunks).toEqual(["ok-from-ag-tok-2"]);
  expect(seenAgAuth).toEqual(["Bearer ag-tok-1", "Bearer ag-tok-2"]);
  expect(agNotices).toEqual([
    "[auth-pool] antigravity account #1 (ag1@example.com) hit rate limit — rotating to account #2/2 (ag2@example.com)",
  ]);

  await clearAuthCooldown("antigravity");
  seenAgAuth.length = 0;
  failAgAuth = "Bearer ag-tok-2";
  const agCallReply = await manager.call([{ role: "user", content: "hi" }], {
    model: "antigravity/gemini-4-hydrogen-high",
  });
  expect(agCallReply).toBe("ok-from-ag-tok-1");
  expect(seenAgAuth).toEqual(["Bearer ag-tok-2", "Bearer ag-tok-1"]);

  // 2) HTTP 400 "Your credit balance is too low"
  await addApiKeyToPool("anthropic", "sk-ant-credit-1");
  await addApiKeyToPool("anthropic", "sk-ant-credit-2");
  const seenAnthropicKeys: string[] = [];
  let failAnthropicKey = "sk-ant-credit-1";
  globalThis.fetch = (async (_input, init) => {
    const key = getHeader(init, "x-api-key") ?? "";
    seenAnthropicKeys.push(key);
    if (key === failAnthropicKey) {
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    if (String(init?.body ?? "").includes('"stream":true')) {
      return sseResponse([
        'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6"}}\n\n',
        `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"stream-ok-${key}"}}\n\n`,
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]);
    }
    return new Response(
      JSON.stringify({
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: `call-ok-${key}` }],
        usage: { input_tokens: 4, output_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const creditCallReply = await manager.call([{ role: "user", content: "credit-call" }], {
    model: "claude-sonnet-4-6",
  });
  expect(creditCallReply).toBe("call-ok-sk-ant-credit-2");
  expect(seenAnthropicKeys).toEqual(["sk-ant-credit-1", "sk-ant-credit-2"]);

  await clearAuthCooldown("anthropic");
  seenAnthropicKeys.length = 0;
  failAnthropicKey = "sk-ant-credit-2";
  const creditStreamChunks: string[] = [];
  for await (const chunk of manager.stream([{ role: "user", content: "credit-stream" }], {
    model: "claude-sonnet-4-6",
  })) {
    creditStreamChunks.push(chunk);
  }
  expect(creditStreamChunks).toEqual(["stream-ok-sk-ant-credit-1"]);
  expect(seenAnthropicKeys).toEqual(["sk-ant-credit-2", "sk-ant-credit-1"]);

  // 3) HTTP 529 "overloaded_error"
  await removeApiKeyFromPool("anthropic");
  await addApiKeyToPool("anthropic", "sk-ant-overload-1");
  await addApiKeyToPool("anthropic", "sk-ant-overload-2");
  seenAnthropicKeys.length = 0;
  failAnthropicKey = "sk-ant-overload-1";
  globalThis.fetch = (async (_input, init) => {
    const key = getHeader(init, "x-api-key") ?? "";
    seenAnthropicKeys.push(key);
    if (key === failAnthropicKey) {
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "overloaded_error", message: "Overloaded" },
        }),
        { status: 529, headers: { "content-type": "application/json" } },
      );
    }
    if (String(init?.body ?? "").includes('"stream":true')) {
      return sseResponse([
        'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6"}}\n\n',
        `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"stream-ok-${key}"}}\n\n`,
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]);
    }
    return new Response(
      JSON.stringify({
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: `call-ok-${key}` }],
        usage: { input_tokens: 4, output_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const overloadCallReply = await manager.call([{ role: "user", content: "overload-call" }], {
    model: "claude-sonnet-4-6",
  });
  expect(overloadCallReply).toBe("call-ok-sk-ant-overload-2");
  expect(seenAnthropicKeys).toEqual(["sk-ant-overload-1", "sk-ant-overload-2"]);

  await clearAuthCooldown("anthropic");
  seenAnthropicKeys.length = 0;
  failAnthropicKey = "sk-ant-overload-2";
  const overloadStreamChunks: string[] = [];
  for await (const chunk of manager.stream([{ role: "user", content: "overload-stream" }], {
    model: "claude-sonnet-4-6",
  })) {
    overloadStreamChunks.push(chunk);
  }
  expect(overloadStreamChunks).toEqual(["stream-ok-sk-ant-overload-1"]);
  expect(seenAnthropicKeys).toEqual(["sk-ant-overload-2", "sk-ant-overload-1"]);
});

test("loginHint, subscriptionHint, and apiKeyHint include pool:2 when poolSize or apiKeyPoolSize is 2", () => {
  const oauthStatus: ProviderStatus = {
    name: "anthropic",
    kind: "oauth",
    label: "OAuth",
    ready: true,
    loggedIn: true,
    oauthEmail: "a@example.com",
    poolSize: 2,
  };
  expect(loginHint(oauthStatus, true)).toContain("pool:2");
  expect(loginHint(oauthStatus, false)).toContain("pool:2");
  expect(loginHint({ ...oauthStatus, poolSize: 1 }, true)).not.toContain("pool:");

  const subStatus: ProviderStatus = {
    name: "qwen-portal",
    kind: "api_key",
    label: "API key",
    envVar: "QWEN_PORTAL_API_KEY",
    ready: true,
    apiKeyPoolSize: 2,
  };
  expect(subscriptionHint(subStatus, true)).toContain("pool:2");
  expect(subscriptionHint(subStatus, false)).toContain("pool:2");
  expect(subscriptionHint({ ...subStatus, apiKeyPoolSize: 1 }, true)).not.toContain("pool:");

  const keyStatus: ProviderStatus = {
    name: "openai",
    kind: "api_key",
    label: "API key",
    envVar: "OPENAI_API_KEY",
    ready: true,
    apiKeyPoolSize: 2,
  };
  expect(apiKeyHint(keyStatus, true)).toContain("pool:2");
  expect(apiKeyHint(keyStatus, false)).toContain("pool:2");
  expect(apiKeyHint({ ...keyStatus, apiKeyPoolSize: 1 }, true)).not.toContain("pool:");
});

test("Antigravity rate_limit/usage_limit cooldowns are model-scoped and do not poison shared cooldowns.json", async () => {
  const future = Date.now() + 3_600_000;
  const sharedFile = path.join(tmpHome, "shared-cooldowns.json");
  const prevShared = process.env.JEO_SHARED_AUTH_POOL_PATH;
  process.env.JEO_SHARED_AUTH_POOL_PATH = sharedFile;

  try {
    await setOauthCredential("antigravity", {
      access: "ag-m-1",
      refresh: "ag-ref-m-1",
      expires: future,
      projectId: "proj-1",
      email: "ag1@example.com",
    });
    await setOauthCredential("antigravity", {
      access: "ag-m-2",
      refresh: "ag-ref-m-2",
      expires: future,
      projectId: "proj-2",
      email: "ag2@example.com",
    });

    const c1 = await resolveCredential("antigravity", { model: "antigravity/gemini-4-hydrogen-high" });
    expect(c1.token).toBe("ag-m-1");

    // Rate limit on gemini-4-hydrogen-high rotates to ag-m-2 for that model.
    const rot = await rotateCredential(
      "antigravity",
      c1,
      new Error("HTTP 429: RESOURCE_EXHAUSTED"),
      { model: "antigravity/gemini-4-hydrogen-high" },
    );
    expect(rot.rotated).toBe(true);
    expect(rot.credential.token).toBe("ag-m-2");

    // Shared cooldowns.json must NOT be written/poisoned by model-scoped rate_limit.
    expect(await Bun.file(sharedFile).exists()).toBe(false);

    // The same account (ag-m-1) remains unblocked for a different Antigravity model (claude-sonnet-4-6).
    expect(
      await hasUnblockedPoolSibling("antigravity", rot.credential, { model: "antigravity/claude-sonnet-4-6" }),
    ).toBe(true);
    const otherModelCred = await resolveCredential("antigravity", {
      accountIndex: 0,
      model: "antigravity/claude-sonnet-4-6",
    });
    expect(otherModelCred.token).toBe("ag-m-1");

    // Calling resolveCredential on the cooled-down model (without accountIndex) skips ag-m-1 and picks ag-m-2.
    const sameModelCred = await resolveCredential("antigravity", { model: "antigravity/gemini-4-hydrogen-high" });
    expect(sameModelCred.token).toBe("ag-m-2");

    // A non-rate/usage limit failure (401 auth_rejected) DOES block the account across all models and writes shared cooldown.
    const authRot = await rotateCredential(
      "antigravity",
      otherModelCred,
      { status: 401, message: "HTTP 401 Unauthorized" },
      { model: "antigravity/claude-sonnet-4-6" },
    );
    expect(authRot.rotated).toBe(true);
    expect(authRot.credential.token).toBe("ag-m-2");
    expect(await Bun.file(sharedFile).exists()).toBe(true);
    expect(
      await hasUnblockedPoolSibling("antigravity", authRot.credential, { model: "antigravity/gemini-4-carbon-high" }),
    ).toBe(false);
  } finally {
    if (prevShared === undefined) delete process.env.JEO_SHARED_AUTH_POOL_PATH;
    else process.env.JEO_SHARED_AUTH_POOL_PATH = prevShared;
  }
});

test("ModelManager keeps dedicated antigravity OAuth isolated from gemini fallback on rotation, and rotates gemini fallback only when antigravity OAuth is absent", async () => {
  const future = Date.now() + 3_600_000;
  const manager = createModelManager();

  // 1) Dedicated antigravity OAuth + gemini OAuth configured: rotation must NOT jump to gemini.
  await setOauthCredential("antigravity", {
    access: "ag-dedicated-1",
    refresh: "ag-dedicated-ref-1",
    expires: future,
    projectId: "proj-ag",
    email: "ag@example.com",
  });
  await setOauthCredential("gemini", {
    access: "gem-only-1",
    refresh: "gem-only-ref-1",
    expires: future,
    projectId: "proj-gem",
    email: "gem@example.com",
  });

  const seenAuth: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    seenAuth.push(getHeader(init, "authorization") ?? "");
    return sseResponse([
      'data: {"error":{"code":429,"message":"Individual quota reached. Resets in 1h.","status":"QUOTA_EXHAUSTED"}}\n\n',
    ]);
  }) as typeof fetch;

  await expect(
    manager.call([{ role: "user", content: "hi" }], { model: "antigravity/gemini-4-hydrogen-high" }),
  ).rejects.toThrow();
  expect(seenAuth.every(h => h === "Bearer ag-dedicated-1")).toBe(true);
  expect(seenAuth).not.toContain("Bearer gem-only-1");

  // 2) When antigravity OAuth is absent, gemini OAuth fallback works and rotates across gemini OAuth slots.
  await removeOAuthAccount("antigravity");
  await clearAuthCooldown();
  await setOauthCredential("gemini", {
    access: "gem-only-2",
    refresh: "gem-only-ref-2",
    expires: future,
    projectId: "proj-gem-2",
    email: "gem2@example.com",
  });

  seenAuth.length = 0;
  globalThis.fetch = (async (_input, init) => {
    const auth = getHeader(init, "authorization") ?? "";
    seenAuth.push(auth);
    if (auth === "Bearer gem-only-1") {
      return sseResponse([
        'data: {"error":{"code":429,"message":"Resource exhausted","status":"RESOURCE_EXHAUSTED"}}\n\n',
      ]);
    }
    return sseResponse([
      `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "ok-from-gem-2" }] }, finishReason: "STOP" }] } })}\n\n`,
    ]);
  }) as typeof fetch;

  const reply = await manager.call([{ role: "user", content: "hi" }], {
    model: "antigravity/gemini-4-hydrogen-high",
  });
  expect(reply).toBe("ok-from-gem-2");
  expect(seenAuth).toEqual(["Bearer gem-only-1", "Bearer gem-only-2"]);
});

test("loadedPoolDirs LRU cache caps at 32 directories and evicts least-recently-used entry", async () => {
  const dirs = Array.from({ length: 33 }, (_, idx) => path.join(tmpHome, `lru-dir-${idx}`));
  try {
    // Seed dirs[0] and dirs[1] with rotated/blocked state in memory, then reset their on-disk
    // auth-pool-state.json so a cache hit (in-memory) is distinguishable from a cache miss (disk reload).
    for (const [idx, primary, secondary] of [
      [0, "sk-d0-primary", "sk-d0-secondary"],
      [1, "sk-d1-primary", "sk-d1-secondary"],
    ] as const) {
      process.env.JEO_CONFIG_DIR = dirs[idx];
      clearConfigReadCache();
      await addApiKeyToPool("openai", primary);
      await addApiKeyToPool("openai", secondary);
      const rot = await rotateCredential(
        "openai",
        { kind: "api_key", provider: "openai", token: primary },
        { status: 429, message: "Rate limit" },
      );
      expect(rot.rotated).toBe(true);
      await fs.writeFile(
        path.join(dirs[idx], "auth-pool-state.json"),
        JSON.stringify({ version: 1, pools: {} }),
        "utf-8",
      );
    }

    // Load 30 additional distinct dirs (total 32 in loadedPoolDirs: dirs[0]..dirs[31]).
    for (let i = 2; i < 32; i++) {
      process.env.JEO_CONFIG_DIR = dirs[i];
      clearConfigReadCache();
      await snapshotProvider("openai");
    }

    // dirs[0] must still be cached at cap 32; snapshotProvider promotes dirs[0] to MRU
    // without overwriting auth-pool-state.json on disk, making dirs[1] the LRU entry.
    process.env.JEO_CONFIG_DIR = dirs[0];
    clearConfigReadCache();
    const snap0BeforeEvict = await snapshotProvider("openai");
    expect(snap0BeforeEvict.accounts?.[0]?.blockedUntil).toBeGreaterThan(Date.now());

    // Loading the 33rd directory evicts the LRU entry (dirs[1]), while keeping MRU dirs[0].
    process.env.JEO_CONFIG_DIR = dirs[32];
    clearConfigReadCache();
    await snapshotProvider("openai");

    process.env.JEO_CONFIG_DIR = dirs[0];
    clearConfigReadCache();
    const snap0AfterEvict = await snapshotProvider("openai");
    expect(snap0AfterEvict.accounts?.[0]?.blockedUntil).toBeGreaterThan(Date.now());

    process.env.JEO_CONFIG_DIR = dirs[1];
    clearConfigReadCache();
    const snap1AfterEvict = await snapshotProvider("openai");
    expect(snap1AfterEvict.accounts?.[0]?.blockedUntil).toBeUndefined();
    expect(snap1AfterEvict.accounts?.[0]?.active).toBe(true);
  } finally {
    for (const dir of dirs) {
      process.env.JEO_CONFIG_DIR = dir;
      await resetAuthPoolState();
    }
  }
});

test("persistDirPools prunes expired cooldowns across loaded dirs and drops empty pool entries", async () => {
  const dirA = path.join(tmpHome, "prune-dir-a");
  const dirB = path.join(tmpHome, "prune-dir-b");
  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = () => fakeNow;

  try {
    // Configure dirA with a short-lived cooldown on openai (both keys blocked -> cursor wraps to 0)
    // and a longer-lived cooldown on groq that must survive pruning.
    process.env.JEO_CONFIG_DIR = dirA;
    clearConfigReadCache();
    await addApiKeyToPool("openai", "sk-a-1");
    await addApiKeyToPool("openai", "sk-a-2");
    await addApiKeyToPool("groq", "grq-a-1");
    await addApiKeyToPool("groq", "grq-a-2");

    const rotA1 = await rotateCredential(
      "openai",
      { kind: "api_key", provider: "openai", token: "sk-a-1" },
      { status: 429, retryAfterMs: 5_000 },
    );
    expect(rotA1.rotated).toBe(true);
    const rotA2 = await rotateCredential(
      "openai",
      { kind: "api_key", provider: "openai", token: "sk-a-2" },
      { status: 429, retryAfterMs: 5_000 },
    );
    expect(rotA2.rotated).toBe(false);

    const rotGroq = await rotateCredential(
      "groq",
      { kind: "api_key", provider: "groq", token: "grq-a-1" },
      { status: 429, retryAfterMs: 60_000 },
    );
    expect(rotGroq.rotated).toBe(true);

    const beforeState = JSON.parse(await fs.readFile(path.join(dirA, "auth-pool-state.json"), "utf-8"));
    expect(Object.keys(beforeState.pools["openai:api_key"].blockedUntil)).toHaveLength(2);
    expect(Object.keys(beforeState.pools["openai:api_key"].blockedReason)).toHaveLength(2);

    // Configure dirB with a short-lived cooldown in loadedPoolDirs, then remove its disk file
    // so later snapshotProvider observes the in-memory dirMap directly.
    process.env.JEO_CONFIG_DIR = dirB;
    clearConfigReadCache();
    await addApiKeyToPool("openai", "sk-b-1");
    await addApiKeyToPool("openai", "sk-b-2");
    await rotateCredential(
      "openai",
      { kind: "api_key", provider: "openai", token: "sk-b-1" },
      { status: 429, retryAfterMs: 5_000 },
    );
    await fs.unlink(path.join(dirB, "auth-pool-state.json"));

    // Advance clock past the 5s cooldowns, but keep the 60s groq cooldown active.
    fakeNow += 10_000;

    // An unrelated persistDirPools() trigger in dirA prunes expired cooldowns across all loaded dirs.
    process.env.JEO_CONFIG_DIR = dirA;
    clearConfigReadCache();
    await addApiKeyToPool("deepseek", "ds-a-1");
    await resolveCredential("deepseek");

    const afterState = JSON.parse(await fs.readFile(path.join(dirA, "auth-pool-state.json"), "utf-8"));
    expect(afterState.pools["openai:api_key"]).toBeUndefined();
    expect(Object.keys(afterState.pools["groq:api_key"].blockedUntil)).toHaveLength(1);
    expect(Object.values(afterState.pools["groq:api_key"].blockedReason)).toEqual(["rate_limit"]);

    const snapAOpenai = await snapshotProvider("openai");
    expect(snapAOpenai.accounts?.every(a => a.blockedUntil === undefined && a.blockedReason === undefined)).toBe(true);

    process.env.JEO_CONFIG_DIR = dirB;
    clearConfigReadCache();
    const snapBOpenai = await snapshotProvider("openai");
    expect(snapBOpenai.accounts?.every(a => a.blockedUntil === undefined && a.blockedReason === undefined)).toBe(true);
  } finally {
    Date.now = realNow;
    for (const dir of [dirA, dirB]) {
      process.env.JEO_CONFIG_DIR = dir;
      await resetAuthPoolState();
    }
  }
});
