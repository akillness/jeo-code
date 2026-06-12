import { test, expect } from "bun:test";
import { drainIncomingMessages, handleLine } from "../src/mcp/server";
import { TOOLS } from "../src/mcp/tools";
import type { JsonRpcResponse } from "../src/mcp/protocol";

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
  const child = Bun.spawn(["bun", "src/cli.ts", "mcp", "serve"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, JEO_MCP_PIPELINE: "1" },
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
