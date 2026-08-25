import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  writeCrashLog,
  redactCrashText,
  crashLogPath,
  CRASH_LOG_MAX_BYTES,
  CRASH_LOG_MAX_ENTRY_BYTES,
} from "../src/util/crash-log";

let dir: string;
const savedCfgDir = process.env.JEO_CONFIG_DIR;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "jeo-crashlog-"));
  process.env.JEO_CONFIG_DIR = dir;
});

afterEach(async () => {
  if (savedCfgDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = savedCfgDir;
  await fs.promises.rm(dir, { recursive: true, force: true });
});

test("writeCrashLog: records a normal Error with timestamp, name/message, and stack", () => {
  writeCrashLog(new Error("boom"));
  const text = fs.readFileSync(crashLogPath(), "utf-8");
  expect(text).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] Error: boom/);
  expect(text).toContain("Error: boom");
  // Node/Bun error stacks lead with "Error: <message>" then "    at ..." frames.
  expect(text).toMatch(/at /);
});

test("writeCrashLog: owner-only file and dir permissions", () => {
  writeCrashLog(new Error("perm-check"));
  const fileMode = fs.statSync(crashLogPath()).mode & 0o777;
  const dirMode = fs.statSync(dir).mode & 0o777;
  expect(fileMode).toBe(0o600);
  expect(dirMode).toBe(0o700);
});

test("writeCrashLog: appends multiple records rather than overwriting, each on its own line", () => {
  writeCrashLog(new Error("first"));
  writeCrashLog(new Error("second"));
  const text = fs.readFileSync(crashLogPath(), "utf-8");
  const lines = text.trim().split("\n").filter(l => l.includes("] Error:"));
  expect(lines.length).toBe(2);
  expect(lines[0]).toContain("first");
  expect(lines[1]).toContain("second");
});

test("writeCrashLog: non-Error reasons (string, object, number, null, undefined) are recorded without throwing", () => {
  expect(() => writeCrashLog("plain string reason")).not.toThrow();
  expect(() => writeCrashLog({ code: "EFOO", detail: "bar" })).not.toThrow();
  expect(() => writeCrashLog(42)).not.toThrow();
  expect(() => writeCrashLog(null)).not.toThrow();
  expect(() => writeCrashLog(undefined)).not.toThrow();

  const text = fs.readFileSync(crashLogPath(), "utf-8");
  expect(text).toContain("plain string reason");
  expect(text).toContain(`"code":"EFOO"`);
  expect(text).toContain("42");
  expect(text).toContain("null");
  expect(text).toContain("undefined");
});

test("writeCrashLog: resets (does not grow unbounded) once the file crosses the size ceiling", () => {
  // Pre-seed a file already past the ceiling — simulates a prior crash loop.
  fs.writeFileSync(crashLogPath(), Buffer.alloc(CRASH_LOG_MAX_BYTES + 1, "a".charCodeAt(0)));
  expect(fs.statSync(crashLogPath()).size).toBeGreaterThan(CRASH_LOG_MAX_BYTES);

  writeCrashLog(new Error("post-reset"));

  const size = fs.statSync(crashLogPath()).size;
  expect(size).toBeLessThan(CRASH_LOG_MAX_BYTES / 10); // reset, not appended onto the bloat
  const text = fs.readFileSync(crashLogPath(), "utf-8");
  expect(text).toContain("post-reset");
  expect(text).not.toContain("aaaa"); // old bloat content is gone
});

test("writeCrashLog: does not reset a file that is still under the size ceiling", () => {
  writeCrashLog(new Error("one"));
  const sizeAfterOne = fs.statSync(crashLogPath()).size;
  writeCrashLog(new Error("two"));
  const sizeAfterTwo = fs.statSync(crashLogPath()).size;
  expect(sizeAfterTwo).toBeGreaterThan(sizeAfterOne); // appended, not reset
  const text = fs.readFileSync(crashLogPath(), "utf-8");
  expect(text).toContain("one");
  expect(text).toContain("two");
});

test("writeCrashLog: per-entry UTF-8-safe truncation never corrupts a multi-byte boundary", () => {
  // 4-byte-per-codepoint emoji (surrogate pair in UTF-16) repeated well past the
  // per-entry cap — a naive string/byte slice would very likely land mid-codepoint.
  const huge = "🔥".repeat(CRASH_LOG_MAX_ENTRY_BYTES); // ~4x the entry byte cap
  writeCrashLog(new Error(huge));
  const text = fs.readFileSync(crashLogPath(), "utf-8");
  expect(text).not.toContain("\uFFFD"); // replacement char = corrupted decode
  expect(text).toContain("…"); // truncation marker present
  // Round-tripping through UTF-8 bytes must be stable (no corruption introduced).
  const bytes = Buffer.from(text, "utf-8");
  expect(bytes.toString("utf-8")).toBe(text);
});

test("writeCrashLog: never throws even when the target directory cannot be created", () => {
  // Point JEO_CONFIG_DIR at a path that is itself a FILE, so mkdirSync(..., {recursive:true})
  // fails with ENOTDIR — simulates a genuinely broken/unwritable crash-log destination.
  const blockerFile = path.join(dir, "blocker");
  fs.writeFileSync(blockerFile, "not a directory");
  process.env.JEO_CONFIG_DIR = blockerFile;
  expect(() => writeCrashLog(new Error("should not throw"))).not.toThrow();
});

test("redactCrashText: redacts an Authorization: Bearer header, including the token after the space", () => {
  const out = redactCrashText("Authorization: Bearer sk-abcDEF123.456-xyz");
  expect(out).not.toContain("sk-abcDEF123.456-xyz");
  expect(out).toContain("Bearer <redacted>");
});

test("redactCrashText: redacts key=value and key: value secret assignments", () => {
  expect(redactCrashText("api_key=sk-live-abc123")).not.toContain("sk-live-abc123");
  expect(redactCrashText("API_KEY: sk-live-xyz789")).not.toContain("sk-live-xyz789");
  expect(redactCrashText('password="hunter2!"')).not.toContain("hunter2!");
  expect(redactCrashText("secret: my-super-secret-value")).not.toContain("my-super-secret-value");
});

test("redactCrashText: redacts quoted JSON secret fields", () => {
  const out = redactCrashText('{"apiKey":"sk-jsonvalue123","user":"alice"}');
  expect(out).not.toContain("sk-jsonvalue123");
  expect(out).toContain('"user":"alice"'); // non-secret fields untouched
});

test("redactCrashText: leaves ordinary text untouched", () => {
  const msg = "Cannot read properties of undefined (reading 'foo')";
  expect(redactCrashText(msg)).toBe(msg);
});

test("writeCrashLog: end-to-end fatal record redacts secrets before persisting", () => {
  writeCrashLog(new Error("request failed: Authorization: Bearer sk-live-verysecret999"));
  const text = fs.readFileSync(crashLogPath(), "utf-8");
  expect(text).not.toContain("sk-live-verysecret999");
  expect(text).toContain("request failed");
});
