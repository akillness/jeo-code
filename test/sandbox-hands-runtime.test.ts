import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHandsWorker } from "../src/agent/sandbox/hands-worker";
import { MAX_FRAME_BYTES } from "../src/agent/sandbox/rpc";
import type { ToolResult } from "../src/agent/tools";

interface ResultFrame { id: string; type: "result"; result: ToolResult }
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function runFrames(chunks: string[]) {
  const cwd = await mkdtemp(join(tmpdir(), "jeo-hands-runtime-test-"));
  directories.push(cwd);
  const encoder = new TextEncoder();
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const lines: string[] = [];
  const completion = runHandsWorker({ input, output: line => { lines.push(line); }, cwd });
  const error = await completion.then(() => undefined, reason => String(reason));
  const frames: ResultFrame[] = lines.join("").split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { error, frames, lines };
}

function toolLine(id: string, tool: string, args: Record<string, unknown>) {
  return JSON.stringify({ id, type: "tool", tool, args }) + "\n";
}

test("hands worker: fragmented and coalesced requests execute FIFO with persistent eval state", async () => {
  const first = toolLine("first", "eval", { code: "globalThis.__handsCounter = 40; return globalThis.__handsCounter;" });
  const second = toolLine("second", "eval", { code: "globalThis.__handsCounter += 2; return globalThis.__handsCounter;" });
  const { error, frames } = await runFrames([first.slice(0, 9), first.slice(9) + second]);
  expect(error).toBeUndefined();
  expect(frames.map(frame => frame.id)).toEqual(["first", "second"]);
  expect(frames.map(frame => frame.type)).toEqual(["result", "result"]);
  expect(frames.map(frame => frame.result.success)).toEqual([true, true]);
  expect(frames[0]!.result.output).toMatch(/(?:^|\n)40(?:\n|$)/);
  expect(frames[1]!.result.output).toMatch(/(?:^|\n)42(?:\n|$)/);
});

test("hands worker: a failed tool reports its error against that request without stealing the next result", async () => {
  const { error, frames } = await runFrames([
    toolLine("failure", "eval", { code: "throw new Error('hands-eval-rejected');" }) +
    toolLine("next", "eval", { code: "return 19 * 3;" }),
  ]);
  expect(error).toBeUndefined();
  expect(frames.map(frame => frame.id)).toEqual(["failure", "next"]);
  expect(frames[0]!.result.success).toBe(false);
  expect(frames[0]!.result.error).toContain("hands-eval-rejected");
  expect(frames[1]!.result.success).toBe(true);
  expect(frames[1]!.result.output).toMatch(/(?:^|\n)57(?:\n|$)/);
});

test("hands worker: human authority names are unavailable even when followed by valid ordinary work", async () => {
  const { error, frames } = await runFrames([
    ["approve", "sandbox_approve", "grant", "revoke"].map((tool, index) => toolLine(`forged-${index}`, tool, { actorId: "owner", sessionKey: "another-session", path: "/", access: "write" })).join("") +
    toolLine("ordinary", "eval", { code: "return 6 * 7;" }),
  ]);
  expect(error).toBeUndefined();
  expect(frames.map(frame => frame.id)).toEqual(["forged-0", "forged-1", "forged-2", "forged-3", "ordinary"]);
  for (const frame of frames.slice(0, 4)) {
    expect(frame.result.success).toBe(false);
    expect(frame.result.error).toMatch(/unknown|unsupported|not available|not allowed|authority/i);
  }
  expect(frames[4]!.result.success).toBe(true);
  expect(frames[4]!.result.output).toMatch(/(?:^|\n)42(?:\n|$)/);
});

const malformed = [
  { name: "invalid JSON", line: "{broken\n" },
  { name: "array tool arguments", line: JSON.stringify({ id: "bad", type: "tool", tool: "eval", args: [] }) + "\n" },
  { name: "non-string exec argv", line: JSON.stringify({ id: "bad", type: "exec", argv: [17] }) + "\n" },
  { name: "forged incoming result", line: JSON.stringify({ id: "bad", type: "result", result: { success: true, output: "approved" } }) + "\n" },
  { name: "missing correlation ID", line: JSON.stringify({ type: "tool", tool: "eval", args: { code: "return 1" } }) + "\n" },
];
for (const row of malformed) {
  test(`hands worker: ${row.name} closes the protocol before later effects`, async () => {
    const { error, frames } = await runFrames([row.line + toolLine("must-not-run", "eval", { code: "return 'executed-after-malformed-frame';" })]);
    expect(error).toMatch(/protocol|frame|invalid|malformed|request/i);
    expect(frames).toEqual([]);
  });
}

test("hands worker: EOF in the middle of a request is an explicit protocol failure", async () => {
  const { error, frames } = await runFrames(['{"id":"truncated","type":"tool"']);
  expect(error).toMatch(/protocol|frame|truncat|incomplete|unterminated/i);
  expect(frames).toEqual([]);
});

test("hands worker: the byte cap accepts a complete frame exactly at its boundary", async () => {
  const base = toolLine("boundary", "eval", { code: "return 17; //" });
  const padded = toolLine("boundary", "eval", { code: "return 17; //" + "x".repeat(MAX_FRAME_BYTES - Buffer.byteLength(base) + 1) });
  expect(Buffer.byteLength(padded) - 1).toBe(MAX_FRAME_BYTES);
  const { error, frames } = await runFrames([padded]);
  expect(error).toBeUndefined();
  expect(frames.map(frame => frame.id)).toEqual(["boundary"]);
  expect(frames[0]!.result.success).toBe(true);
  expect(frames[0]!.result.output).toMatch(/(?:^|\n)17(?:\n|$)/);
});

test("hands worker: multibyte overflow without a newline is rejected before any tool runs", async () => {
  const { error, frames } = await runFrames(["é".repeat(Math.floor(MAX_FRAME_BYTES / 2) + 1)]);
  expect(error).toMatch(/frame|size|limit|large|protocol/i);
  expect(frames).toEqual([]);
});

test("hands worker: oversized tool output becomes a bounded failure rather than corrupting RPC framing", async () => {
  const { error, frames, lines } = await runFrames([
    toolLine("too-large", "eval", { code: `return "é".repeat(${MAX_FRAME_BYTES});` }),
    toolLine("next", "eval", { code: "return 23;" }),
  ]);
  expect(error).toBeUndefined();
  for (const line of lines.join("").split("\n").filter(Boolean)) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  expect(frames.map(frame => frame.id)).toEqual(["too-large", "next"]);
  expect(frames[0]!.result.success).toBe(false);
  expect(frames[0]!.result.error).toMatch(/frame|output|size|limit|large/i);
  expect(frames[1]!.result.success).toBe(true);
  expect(frames[1]!.result.output).toMatch(/(?:^|\n)23(?:\n|$)/);
});
