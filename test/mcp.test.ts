import { test, expect } from "bun:test";
import { handleLine } from "../src/mcp/server";
import { TOOLS } from "../src/mcp/tools";

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
