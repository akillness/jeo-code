import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsageAttempt } from "../src/agent/usage-ledger";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "jeo-usage-test-"));
  directories.push(directory);
  return join(directory, "usage.jsonl");
}

function records(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
}

test("persists a provider attempt without inventing unknown cache or cost", () => {
  const file = fixture();
  const attempt = createUsageAttempt({ file, sessionId: "session-1", role: "parent", provider: "synthetic", model: "model-a" });
  attempt.onUsage({ inputUncachedTokens: 11, outputTokens: 7 });
  attempt.finish();
  const [record] = records(file);
  expect(record).toMatchObject({ type: "usage", version: 1, sessionId: "session-1", role: "parent", provider: "synthetic", model: "model-a", incomplete: true, usage: { input: 11, output: 7 } });
  expect(record.usage).toEqual({ input: 11, output: 7 });
});

test("merges repeated cumulative stream snapshots without adding them", () => {
  const file = fixture();
  const attempt = createUsageAttempt({ file, sessionId: "session-2", role: "parent", provider: "synthetic", model: "model-b" });
  attempt.onUsage({ inputUncachedTokens: 20, outputTokens: 2, cacheReadTokens: 4 });
  attempt.onUsage({ outputTokens: 9, cacheWriteTokens: 3 });
  attempt.onUsage({ outputTokens: 9 });
  attempt.finish();
  attempt.finish();
  const result = records(file);
  expect(result).toHaveLength(1);
  expect(result[0].usage).toEqual({ input: 20, output: 9, cacheRead: 4, cacheWrite: 3 });
});

test("keeps failed or cancelled attempts unresolved and separates parent and child calls", () => {
  const file = fixture();
  const first = createUsageAttempt({ file, sessionId: "parent-session", role: "parent", provider: "synthetic", model: "model-a" });
  first.finish();
  const second = createUsageAttempt({ file, sessionId: "child-session", role: "child", provider: "synthetic", model: "model-b" });
  second.onUsage({ inputUncachedTokens: 12, outputTokens: 5 });
  second.finish();
  const result = records(file);
  expect(result).toHaveLength(2);
  expect(result[0]).toMatchObject({ sessionId: "parent-session", role: "parent", model: "model-a", incomplete: true, usage: {} });
  expect(result[1]).toMatchObject({ sessionId: "child-session", role: "child", model: "model-b", incomplete: true, usage: { input: 12, output: 5 } });
  expect(result[0].id).not.toEqual(result[1].id);
});

test("never persists prompt or error content embedded in provider metadata", () => {
  const file = fixture();
  const attempt = createUsageAttempt({ file, sessionId: "safe-session", role: "parent", provider: "synthetic", model: "model-c" });
  const usage = { inputUncachedTokens: 4, outputTokens: 2, prompt: "secret-prompt-728", error: "secret-error-931" };
  attempt.onUsage(usage);
  attempt.finish();
  const text = readFileSync(file, "utf8");
  expect(text).not.toContain("secret-prompt-728");
  expect(text).not.toContain("secret-error-931");
  expect(records(file)[0].usage).toEqual({ input: 4, output: 2 });
});

test("surfaces a ledger write failure instead of reporting successful persistence", () => {
  const file = fixture();
  writeFileSync(file, "not a directory");
  const attempt = createUsageAttempt({ file: join(file, "impossible", "usage.jsonl"), sessionId: "s", role: "parent", provider: "synthetic", model: "model" });
  attempt.onUsage({ inputUncachedTokens: 2, outputTokens: 1 });
  expect(() => attempt.finish()).toThrow();
});

test("does not mistake aggregate input tokens for known uncached input", () => {
  const file = fixture();
  const attempt = createUsageAttempt({ file, sessionId: "s", role: "parent", provider: "synthetic", model: "model" });
  attempt.onUsage({ inputTokens: 18, outputTokens: 3 });
  attempt.finish();
  const [record] = records(file);
  expect(record.incomplete).toBe(true);
  expect(record.usage).toEqual({ output: 3 });
});
