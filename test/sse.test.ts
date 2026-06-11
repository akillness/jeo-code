import { test, expect } from "bun:test";
import { readLines, readSse } from "../src/ai/sse";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) {
        c.enqueue(enc.encode(ch));
      }
      c.close();
    }
  });
}

test("readLines reassembles a line split across two chunks", async () => {
  const stream = streamOf(["{\"a\":1}\n{\"b\"", ":2}\n"]);
  const results: string[] = [];
  for await (const line of readLines(stream)) {
    results.push(line);
  }
  expect(results).toEqual(['{"a":1}', '{"b":2}']);
});

test("readLines emits a final unterminated line", async () => {
  const stream = streamOf(["hello"]);
  const results: string[] = [];
  for await (const line of readLines(stream)) {
    results.push(line);
  }
  expect(results).toEqual(["hello"]);
});

test("readSse extracts data payloads and skips [DONE]", async () => {
  const stream = streamOf(["data: {\"x\":1}\n\n", "data: [DONE]\n"]);
  const results: string[] = [];
  for await (const data of readSse(stream)) {
    results.push(data);
  }
  expect(results).toEqual(['{"x":1}']);
});

test("readSse handles a data payload split across chunks", async () => {
  const stream = streamOf(["data: {\"x\"", ":1}\n"]);
  const results: string[] = [];
  for await (const data of readSse(stream)) {
    results.push(data);
  }
  expect(results).toEqual(['{"x":1}']);
});
test("readLines cancels the underlying stream on early return (no socket leak)", async () => {
  let cancelled = false;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc.encode("a\nb\nc\n")); }, // left open (not closed)
    cancel() { cancelled = true; },
  });
  const gen = readLines(stream);
  expect((await gen.next()).value).toBe("a");
  await gen.return(undefined as unknown as string); // early exit → finally → reader.cancel()
  expect(cancelled).toBe(true);
});
