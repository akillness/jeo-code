import { test, expect, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { drainIncomingMessages, handleLine } from "../src/mcp/server";
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
