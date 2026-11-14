import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelManager } from "../src/ai/model-manager";
import type { ProviderAdapter, Usage } from "../src/ai/types";
import { withUsageScope, withChildUsageScope } from "../src/agent/usage-ledger";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "jeo-manager-usage-"));
  directories.push(directory);
  return join(directory, "usage.jsonl");
}

function records(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
}

test("records each retry separately and preserves the caller's usage callback", async () => {
  const file = fixture();
  let count = 0;
  const observed: Usage[] = [];
  const adapter: ProviderAdapter = {
    name: "synthetic",
    async call(_messages, options) {
      count++;
      if (count === 1) {
        options.onUsage?.({ outputTokens: 2 });
        throw new Error("HTTP 503 synthetic-secret-error");
      }
      options.onUsage?.({ inputUncachedTokens: 17, outputTokens: 6 });
      return "answer";
    },
  };
  const manager = createModelManager(async options => ({ adapter, callOptions: { model: "model-a", onUsage: options.onUsage }, credential: { kind: "none", provider: "openai" }, provider: "synthetic", baseUrl: undefined, retry: { retries: 2, sleep: async () => {} } }));
  const output = await withUsageScope({ file, sessionId: "s", role: "parent" }, () => manager.call([{ role: "user", content: "synthetic-secret-prompt" }], { onUsage: usage => observed.push(usage) }));
  expect(output).toBe("answer");
  expect(observed).toEqual([{ outputTokens: 2 }, { inputUncachedTokens: 17, outputTokens: 6 }]);
  const events = records(file);
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ provider: "synthetic", model: "model-a", role: "parent", incomplete: true, usage: { output: 2 } });
  expect(events[1]).toMatchObject({ provider: "synthetic", model: "model-a", role: "parent", incomplete: true, usage: { input: 17, output: 6 } });
  expect(events[0].id).not.toEqual(events[1].id);
  const text = readFileSync(file, "utf8");
  expect(text).not.toContain("synthetic-secret-error");
  expect(text).not.toContain("synthetic-secret-prompt");
});

test("stream retry persists unresolved first attempt and latest cumulative snapshot once", async () => {
  const file = fixture();
  let count = 0;
  const adapter: ProviderAdapter = {
    name: "synthetic",
    async call() { return "unused"; },
    async *stream(_messages, options) {
      count++;
      if (count === 1) throw new Error("HTTP 503");
      options.onUsage?.({ inputUncachedTokens: 20, outputTokens: 2 });
      yield "one";
      options.onUsage?.({ outputTokens: 8, cacheReadTokens: 3 });
      yield "two";
    },
  };
  const manager = createModelManager(async () => ({ adapter, callOptions: { model: "stream-model" }, credential: { kind: "none", provider: "openai" }, provider: "synthetic", baseUrl: undefined, retry: { retries: 2, sleep: async () => {} } }));
  const output = await withUsageScope({ file, sessionId: "s", role: "parent" }, async () => {
    let text = "";
    for await (const chunk of manager.stream([])) text += chunk;
    return text;
  });
  expect(output).toBe("onetwo");
  const events = records(file);
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ usage: {}, incomplete: true, model: "stream-model" });
  expect(events[1]).toMatchObject({ usage: { input: 20, output: 8, cacheRead: 3 }, incomplete: true, model: "stream-model" });
});

test("attributes separate provider selections and child calls without duplicating the parent", async () => {
  const file = fixture();
  const adapter: ProviderAdapter = { name: "synthetic", async call(_messages, options) { options.onUsage?.({ inputUncachedTokens: 4, outputTokens: 1 }); return options.model; } };
  const manager = createModelManager(async options => ({ adapter, callOptions: { model: options.model ?? "unused" }, credential: { kind: "none", provider: "openai" }, provider: options.model === "alternate" ? "fallback-provider" : "synthetic", baseUrl: undefined, retry: { retries: 1 } }));
  await withUsageScope({ file, sessionId: "s", role: "parent" }, async () => {
    expect(await manager.call([], { model: "primary" })).toBe("primary");
    expect(await withChildUsageScope(() => manager.call([], { model: "alternate" }))).toBe("alternate");
  });
  const events = records(file);
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ role: "parent", provider: "synthetic", model: "primary", usage: { input: 4, output: 1 } });
  expect(events[1]).toMatchObject({ role: "child", provider: "fallback-provider", model: "alternate", usage: { input: 4, output: 1 } });
});

test("surfaces persistence failure through the actual call", async () => {
  const file = fixture();
  writeFileSync(file, "not a directory");
  const adapter: ProviderAdapter = { name: "synthetic", async call() { return "answer"; } };
  const manager = createModelManager(async () => ({ adapter, callOptions: { model: "model" }, credential: { kind: "none", provider: "openai" }, provider: "synthetic", baseUrl: undefined, retry: { retries: 1 } }));
  await expect(withUsageScope({ file: join(file, "usage.jsonl"), sessionId: "s", role: "parent" }, () => manager.call([]))).rejects.toThrow();
});

test("an abandoned stream records unresolved usage instead of zero tokens", async () => {
  const file = fixture();
  const adapter: ProviderAdapter = {
    name: "synthetic",
    async call() { return "unused"; },
    async *stream() { yield "partial"; yield "remaining"; },
  };
  const manager = createModelManager(async () => ({ adapter, callOptions: { model: "stream-model" }, credential: { kind: "none", provider: "openai" }, provider: "synthetic", baseUrl: undefined, retry: { retries: 1 } }));
  await withUsageScope({ file, sessionId: "s", role: "parent" }, async () => {
    for await (const chunk of manager.stream([])) {
      expect(chunk).toBe("partial");
      break;
    }
  });
  const events = records(file);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ usage: {}, incomplete: true, model: "stream-model" });
});

test("a failed stream retains the early usage snapshot and served model", async () => {
  const file = fixture();
  const adapter: ProviderAdapter = {
    name: "synthetic",
    async call() { return "unused"; },
    async *stream(_messages, options) {
      options.onUsageSnapshot?.({ inputUncachedTokens: 14, cacheReadTokens: 6, cacheWriteTokens: 3, servedModel: "served-model" });
      throw new Error("synthetic stream failure");
    },
  };
  const manager = createModelManager(async () => ({ adapter, callOptions: { model: "requested-model" }, credential: { kind: "none", provider: "openai" }, provider: "synthetic", baseUrl: undefined, retry: { retries: 1 } }));
  await expect(withUsageScope({ file, sessionId: "s", role: "parent" }, async () => {
    for await (const _chunk of manager.stream([])) { /* consume to trigger the provider */ }
  })).rejects.toThrow("synthetic stream failure");
  const events = records(file);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ model: "served-model", incomplete: true, usage: { input: 14, cacheRead: 6, cacheWrite: 3 } });
  expect(events[0].usage).toEqual({ input: 14, cacheRead: 6, cacheWrite: 3 });
});
