import { test, expect, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { drainIncomingBuffer, drainIncomingMessages, handleLine, MAX_MCP_FRAME_BYTES } from "../src/mcp/server";
import { TOOLS } from "../src/mcp/tools";
import type { JsonRpcResponse } from "../src/mcp/protocol";
import * as doctorCommand from "../src/commands/doctor";

test("handleLine: malformed JSON-RPC inputs return -32600/-32700, never throw (no server crash)", async () => {
  // valid JSON but not an object → must NOT throw (the bug: `null.jsonrpc` killed the stdin loop)
  expect(await handleLine("null", TOOLS)).toMatchObject({ id: null, error: { code: -32600 } });
  expect(await handleLine("[]", TOOLS)).toMatchObject({ id: null, error: { code: -32600 } });
  expect(await handleLine("42", TOOLS)).toMatchObject({ id: null, error: { code: -32600 } });
  // not JSON at all → parse error
  expect(await handleLine("not json", TOOLS)).toMatchObject({ id: null, error: { code: -32700 } });
});

test("handleLine: valid requests still work after a malformed one", async () => {
  await handleLine("null", TOOLS); // would previously kill the loop
  const init = await handleLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}', TOOLS);
  expect(init).toMatchObject({ id: 1, result: { protocolVersion: expect.any(String) } });
  const ping = await handleLine('{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}', TOOLS);
  expect(ping).toMatchObject({ id: 2, result: {} });
  const unknown = await handleLine('{"jsonrpc":"2.0","id":3,"method":"no/such"}', TOOLS);
  expect(unknown).toMatchObject({ id: 3, error: { code: -32601 } });
});

test("drainIncomingMessages: parses standard MCP Content-Length frames and newline fallback", () => {
  const framedPayload = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
  const newlinePayload = '{"jsonrpc":"2.0","id":2,"method":"ping"}';
  const framed = `Content-Length: ${Buffer.byteLength(framedPayload, "utf8")}\r\n\r\n${framedPayload}`;

  const drained = drainIncomingMessages(`${framed}${newlinePayload}\npartial`);

  expect(drained.messages).toEqual([
    { payload: framedPayload, framed: true },
    { payload: newlinePayload, framed: false },
  ]);
  expect(drained.remaining).toBe("partial");
});

test("drainIncomingMessages: keeps incomplete MCP frames buffered", () => {
  const payload = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
  const partial = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload.slice(0, -2)}`;

  const drained = drainIncomingMessages(partial);

  expect(drained.messages).toEqual([]);
  expect(drained.remaining).toBe(partial);
});

test("drainIncomingMessages: treats Content-Length as UTF-8 bytes, not string characters", () => {
  const framedPayload = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"jeo_resolve_provider","arguments":{"model":"모델"}}}';
  const nextPayload = '{"jsonrpc":"2.0","id":2,"method":"ping"}';
  const framed = `Content-Length: ${Buffer.byteLength(framedPayload, "utf8")}\r\n\r\n${framedPayload}`;

  const drained = drainIncomingMessages(`${framed}${nextPayload}\n`);

  expect(drained.messages).toEqual([
    { payload: framedPayload, framed: true },
    { payload: nextPayload, framed: false },
  ]);
  expect(drained.remaining).toBe("");
});

test("handleLine: tool list exposes base tools and optional ralph workflow tools", async () => {
  const response = await handleLine('{"jsonrpc":"2.0","id":"tools","method":"tools/list"}', TOOLS);
  expect(response?.id).toBe("tools");
  const tools = toolListFrom(response);
  const names = tools.map(t => t.name);

  expect(names).toContain("jeo_resolve_provider");
  // The process-level JEO_MCP_PIPELINE/JEO_MCP_PIPELINE flag controls whether these are present
  // in the exported TOOLS array. This assertion only runs when the test process has that flag.
  if (process.env.JEO_MCP_PIPELINE === "1" || process.env.JEO_MCP_PIPELINE === "1") {
    expect(names).toEqual(expect.arrayContaining(["jeo_deep_interview", "jeo_ralplan", "jeo_team", "jeo_ultragoal"]));
  }
});

test("stdio server: accepts framed MCP requests and advertises ralph workflow tools when enabled", async () => {
  const request = '{"jsonrpc":"2.0","id":9,"method":"tools/list"}';
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-mcp-cfg-"));
  const child = Bun.spawn(["bun", "src/cli.ts", "mcp", "serve"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // JEO_CONFIG_DIR: the spawned server must NEVER touch the real ~/.jeo.
    env: { ...process.env, JEO_MCP_PIPELINE: "1", JEO_CONFIG_DIR: configDir },
  });

  child.stdin.write(`Content-Length: ${Buffer.byteLength(request, "utf8")}\r\n\r\n${request}`);
  child.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(exitCode).toBe(0);
  expect(stderr).toContain("listening on stdio (8 tools)");
  const response = parseFramedResponse(stdout);
  const names = toolListFrom(response).map(t => t.name);
  expect(names).toEqual(expect.arrayContaining(["jeo_deep_interview", "jeo_ralplan", "jeo_team", "jeo_ultragoal"]));
});

function toolListFrom(response: JsonRpcResponse | null | undefined): { name: string }[] {
  expect(response?.error).toBeUndefined();
  const result = response?.result as { tools?: unknown } | undefined;
  expect(Array.isArray(result?.tools)).toBe(true);
  return result!.tools as { name: string }[];
}

function parseFramedResponse(output: string): JsonRpcResponse {
  const separator = "\r\n\r\n";
  const separatorIndex = output.indexOf(separator);
  expect(separatorIndex).toBeGreaterThanOrEqual(0);
  const header = output.slice(0, separatorIndex);
  const match = /Content-Length:\s*(\d+)/i.exec(header);
  expect(match).not.toBeNull();
  const length = Number(match![1]);
  const bodyStart = separatorIndex + separator.length;
  const body = output.slice(bodyStart, bodyStart + length);
  return JSON.parse(body) as JsonRpcResponse;
}

test("captureCommand captures process.stdout.write and console.info/warn/debug without corrupting stdout", async () => {
  const leakedStdout: string[] = [];
  const origLog = console.log;
  const origInfo = console.info;
  const origWarn = console.warn;
  const origDebug = console.debug;
  const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    leakedStdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write);
  const doctorSpy = spyOn(doctorCommand, "runDoctorCommand").mockImplementation(async () => {
    console.log("from-log", { ok: true });
    console.info("from-info");
    console.warn("from-warn");
    console.debug("from-debug");
    process.stdout.write("from-stdout-str\n");
    process.stdout.write(Buffer.from("from-stdout-buf\n"));
    process.stdout.write(new Uint8Array(Buffer.from("from-stdout-u8\n")));
  });
  try {
    const res = await handleLine('{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"jeo_doctor","arguments":{}}}', TOOLS);
    expect(res?.error).toBeUndefined();
    const result = res?.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0]?.text).toBe([
      'from-log {"ok":true}',
      "from-info",
      "from-warn",
      "from-debug",
      "from-stdout-str",
      "from-stdout-buf",
      "from-stdout-u8",
    ].join("\n"));
    expect(leakedStdout).toEqual([]);
    expect(console.log).toBe(origLog);
    expect(console.info).toBe(origInfo);
    expect(console.warn).toBe(origWarn);
    expect(console.debug).toBe(origDebug);
    expect(process.stdout.write).toBe(stdoutSpy as unknown as typeof process.stdout.write);
  } finally {
    doctorSpy.mockRestore();
    stdoutSpy.mockRestore();
  }
});

test("captureCommand restores console methods and process.stdout.write when the wrapped command throws", async () => {
  const origLog = console.log;
  const origInfo = console.info;
  const origWarn = console.warn;
  const origDebug = console.debug;
  const origWrite = process.stdout.write;
  const doctorSpy = spyOn(doctorCommand, "runDoctorCommand").mockImplementation(async () => {
    console.info("before-boom");
    throw new Error("doctor exploded");
  });
  try {
    const res = await handleLine('{"jsonrpc":"2.0","id":43,"method":"tools/call","params":{"name":"jeo_doctor","arguments":{}}}', TOOLS);
    expect(res).toMatchObject({ id: 43, error: { code: -32603, message: "doctor exploded" } });
    expect(console.log).toBe(origLog);
    expect(console.info).toBe(origInfo);
    expect(console.warn).toBe(origWarn);
    expect(console.debug).toBe(origDebug);
    expect(process.stdout.write).toBe(origWrite);
  } finally {
    doctorSpy.mockRestore();
  }
});

test("drainIncomingBuffer / drainIncomingMessages: handles multi-byte UTF-8 frames split mid-character across chunks", () => {
  const payload1 = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"jeo_resolve_provider","arguments":{"model":"모델🚀🎉"}}}';
  const payload2 = '{"jsonrpc":"2.0","id":2,"method":"ping","params":{"note":"한글✨"}}';
  const frame1 = Buffer.from(`Content-Length: ${Buffer.byteLength(payload1, "utf8")}\r\n\r\n${payload1}`, "utf8");
  const frame2 = Buffer.from(`Content-Length: ${Buffer.byteLength(payload2, "utf8")}\n\n${payload2}`, "utf8");
  const combined = Buffer.concat([frame1, frame2]);

  // Cut right inside the 4-byte UTF-8 sequence for 🚀 in frame1.
  const emojiOffset = combined.indexOf(Buffer.from("🚀", "utf8"));
  expect(emojiOffset).toBeGreaterThan(0);
  const splitPoint = emojiOffset + 2;
  const chunk1 = combined.subarray(0, splitPoint);
  const chunk2 = combined.subarray(splitPoint);

  const first = drainIncomingBuffer(chunk1);
  expect(first.error).toBeUndefined();
  expect(first.messages).toEqual([]);
  expect(first.remaining.equals(chunk1)).toBe(true);

  const second = drainIncomingBuffer(Buffer.concat([first.remaining, chunk2]));
  expect(second.error).toBeUndefined();
  expect(second.messages).toEqual([
    { payload: payload1, framed: true },
    { payload: payload2, framed: true },
  ]);
  expect(second.remaining.length).toBe(0);

  const strDrained = drainIncomingMessages(combined.toString("utf8"));
  expect(strDrained.error).toBeUndefined();
  expect(strDrained.messages).toEqual([
    { payload: payload1, framed: true },
    { payload: payload2, framed: true },
  ]);
  expect(strDrained.remaining).toBe("");
});

test("drainIncomingBuffer / drainIncomingMessages: rejects >16 MiB frames without OOM and recovers next valid frames", () => {
  const validBefore = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
  const validBeforeFrame = `Content-Length: ${Buffer.byteLength(validBefore, "utf8")}\r\n\r\n${validBefore}`;
  const hugeHeader = `Content-Length: ${MAX_MCP_FRAME_BYTES + 1}\r\n\r\n{"partial":true}`;

  const bufDrained = drainIncomingBuffer(Buffer.from(validBeforeFrame + hugeHeader, "utf8"));
  expect(bufDrained.messages).toEqual([{ payload: validBefore, framed: true }]);
  expect(bufDrained.error).toEqual({
    message: `MCP Content-Length ${MAX_MCP_FRAME_BYTES + 1} exceeds max frame size (${MAX_MCP_FRAME_BYTES} bytes)`,
    framed: true,
  });
  expect(bufDrained.remaining.length).toBe(0);

  const msgDrained = drainIncomingMessages(hugeHeader);
  expect(msgDrained.messages).toEqual([]);
  expect(msgDrained.error?.framed).toBe(true);
  expect(msgDrained.error?.message).toContain("exceeds max frame size");
  expect(msgDrained.remaining).toBe("");

  // When a complete oversized frame precedes another valid frame (exercised with a small maxFrameBytes cap),
  // remaining skips past the oversized body so subsequent frames drain cleanly.
  const smallCap = 64;
  const oversizedBody = "x".repeat(80);
  const oversizedFull = `Content-Length: 80\r\n\r\n${oversizedBody}`;
  const validAfter = '{"jsonrpc":"2.0","id":2,"method":"ping"}';
  const validAfterFrame = `Content-Length: ${Buffer.byteLength(validAfter, "utf8")}\r\n\r\n${validAfter}`;

  const step1 = drainIncomingBuffer(Buffer.from(oversizedFull + validAfterFrame, "utf8"), smallCap);
  expect(step1.error).toEqual({
    message: `MCP Content-Length 80 exceeds max frame size (${smallCap} bytes)`,
    framed: true,
  });
  const step2 = drainIncomingBuffer(step1.remaining, smallCap);
  expect(step2.error).toBeUndefined();
  expect(step2.messages).toEqual([{ payload: validAfter, framed: true }]);
  expect(step2.remaining.length).toBe(0);

  // Newline-delimited oversized line also rejects cleanly and preserves the following line.
  const bigLine = "y".repeat(80) + "\n";
  const nlStep1 = drainIncomingBuffer(Buffer.from(bigLine + validAfter + "\n", "utf8"), smallCap);
  expect(nlStep1.error).toEqual({
    message: `MCP message exceeded max frame size (${smallCap} bytes)`,
    framed: false,
  });
  const nlStep2 = drainIncomingBuffer(nlStep1.remaining, smallCap);
  expect(nlStep2.error).toBeUndefined();
  expect(nlStep2.messages).toEqual([{ payload: validAfter, framed: false }]);

  // Unterminated newline-mode overflow clears remaining instead of buffering unboundedly.
  const unterminatedNl = drainIncomingBuffer(Buffer.from("z".repeat(80), "utf8"), smallCap);
  expect(unterminatedNl.error).toEqual({
    message: `MCP message exceeded max frame size (${smallCap} bytes)`,
    framed: false,
  });
  expect(unterminatedNl.remaining.length).toBe(0);
});

test("drainIncomingBuffer / drainIncomingMessages: rejects >16 KiB headers (terminated and unterminated) cleanly", () => {
  const validBefore = '{"jsonrpc":"2.0","id":10,"method":"ping"}';
  const validBeforeFrame = `Content-Length: ${Buffer.byteLength(validBefore, "utf8")}\r\n\r\n${validBefore}`;
  const pad = "a".repeat(16 * 1024 + 64);

  const unterminatedHeader = `Content-Length: 2\r\nX-Pad: ${pad}`;
  const unterminatedBuf = drainIncomingBuffer(Buffer.from(validBeforeFrame + unterminatedHeader, "utf8"));
  expect(unterminatedBuf.messages).toEqual([{ payload: validBefore, framed: true }]);
  expect(unterminatedBuf.error).toEqual({
    message: "MCP header exceeded 16384 bytes without terminator",
    framed: true,
  });
  expect(unterminatedBuf.remaining.length).toBe(0);

  const unterminatedStr = drainIncomingMessages(unterminatedHeader);
  expect(unterminatedStr.error?.message).toBe("MCP header exceeded 16384 bytes without terminator");
  expect(unterminatedStr.remaining).toBe("");

  const terminatedHeader = `Content-Length: 2\r\nX-Pad: ${pad}\r\n\r\n{}`;
  const terminatedBuf = drainIncomingBuffer(Buffer.from(terminatedHeader, "utf8"));
  expect(terminatedBuf.messages).toEqual([]);
  expect(terminatedBuf.error).toEqual({
    message: "MCP header exceeded 16384 bytes",
    framed: true,
  });
  expect(terminatedBuf.remaining.length).toBe(0);

  const terminatedStr = drainIncomingMessages(terminatedHeader);
  expect(terminatedStr.error?.message).toBe("MCP header exceeded 16384 bytes");
  expect(terminatedStr.remaining).toBe("");
});

test("stdio server: oversized Content-Length returns INVALID_REQUEST without killing the stdin loop", async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-mcp-oversize-"));
  const child = Bun.spawn(["bun", "src/cli.ts", "mcp", "serve"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, JEO_CONFIG_DIR: configDir },
  });
  try {
    const reader = child.stdout.getReader();
    let readBuf = Buffer.alloc(0);
    const readNextFramedResponse = async (): Promise<JsonRpcResponse> => {
      while (true) {
        const sep = readBuf.indexOf("\r\n\r\n");
        if (sep !== -1) {
          const header = readBuf.subarray(0, sep).toString("utf8");
          const m = /Content-Length:\s*(\d+)/i.exec(header);
          if (m) {
            const len = Number(m[1]);
            const bodyStart = sep + 4;
            if (readBuf.length - bodyStart >= len) {
              const body = readBuf.subarray(bodyStart, bodyStart + len).toString("utf8");
              readBuf = readBuf.subarray(bodyStart + len);
              return JSON.parse(body) as JsonRpcResponse;
            }
          }
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stdout closed before framed response arrived");
        readBuf = Buffer.concat([readBuf, Buffer.from(value)]);
      }
    };

    // 1. Send >16 MiB Content-Length header; server must reject with -32600 and stay alive.
    child.stdin.write(`Content-Length: ${MAX_MCP_FRAME_BYTES + 1}\r\n\r\n`);
    const errResp = await readNextFramedResponse();
    expect(errResp).toMatchObject({
      id: null,
      error: { code: -32600, message: expect.stringContaining("exceeds max frame size") },
    });

    // 2. Subsequent valid framed request on the same stdio session still succeeds.
    const ping = '{"jsonrpc":"2.0","id":77,"method":"ping","params":{}}';
    child.stdin.write(`Content-Length: ${Buffer.byteLength(ping, "utf8")}\r\n\r\n${ping}`);
    const pingResp = await readNextFramedResponse();
    expect(pingResp).toEqual({ jsonrpc: "2.0", id: 77, result: {} });

    child.stdin.end();
    reader.releaseLock();
    expect(await child.exited).toBe(0);
  } finally {
    await fs.rm(configDir, { recursive: true, force: true });
  }
});
