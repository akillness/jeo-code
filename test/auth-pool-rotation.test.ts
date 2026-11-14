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
