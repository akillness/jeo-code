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

test("readLines fires onActivity for EVERY received byte chunk (wire heartbeat)", async () => {
  // Three enqueued byte chunks, including an SSE keepalive comment that yields no line.
  const stream = streamOf(["data: {\"x\":1}\n", ": ping\n", "data: {\"y\":2}\n"]);
  let beats = 0;
  const lines: string[] = [];
  for await (const line of readLines(stream, () => { beats++; })) {
    lines.push(line);
  }
  // Heartbeat counts raw byte arrivals — including the keepalive that produced a line
  // a data-only consumer would discard — so all 3 wire reads register as activity.
  expect(beats).toBe(3);
  expect(lines).toEqual(['data: {"x":1}', ": ping", 'data: {"y":2}']);
});

test("readSse heartbeat fires on a keepalive comment that yields no data payload", async () => {
  // A lone SSE comment (`: keep-alive`) is NOT a data: line — readSse yields nothing for
  // it, but the wire heartbeat MUST still fire so the idle watchdog stays armed.
  const stream = streamOf([": keep-alive\n"]);
  let beats = 0;
  const data: string[] = [];
  for await (const d of readSse(stream, () => { beats++; })) {
    data.push(d);
  }
  expect(data).toEqual([]); // no data payload surfaced
  expect(beats).toBe(1); // but the stream proved itself alive
});
