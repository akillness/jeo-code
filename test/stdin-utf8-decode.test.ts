import { test, expect } from "bun:test";
import { StringDecoder } from "node:string_decoder";

// gjc parity (#2591 "preserve supplementary Unicode input"): a raw stdin "data" chunk
// boundary can land MID multi-byte UTF-8 sequence — real terminals/ptys do not
// guarantee byte-aligned-to-character delivery. The OLD code did a naive
// `chunk.toString("utf8")` PER CHUNK, which replaces a split sequence's incomplete
// tail/head with U+FFFD (the Unicode replacement character) on EACH side of the split,
// corrupting any non-ASCII input (Korean/CJK IME text, emoji, ...) whenever this
// happens. The fix uses a persistent `StringDecoder` that buffers an incomplete
// trailing byte sequence across chunks and only emits complete characters.

test("naive per-chunk toString('utf8') corrupts a multi-byte sequence split across chunks (the bug, quantified)", () => {
  const emoji = "😀"; // U+1F600, a 4-byte UTF-8 sequence (F0 9F 98 80), astral (surrogate pair in UTF-16)
  const bytes = Buffer.from(emoji, "utf8");
  expect(bytes.length).toBe(4);
  const chunkA = bytes.subarray(0, 2); // F0 9F — an incomplete lead
  const chunkB = bytes.subarray(2); // 98 80 — orphaned continuation bytes

  const naiveA = chunkA.toString("utf8");
  const naiveB = chunkB.toString("utf8");
  // Both halves individually decode to the Unicode replacement character, not the
  // emoji reassembled — this is the corruption the fix closes.
  expect(naiveA).toBe("\uFFFD");
  expect(naiveB).toBe("\uFFFD\uFFFD");
  expect(naiveA + naiveB).not.toBe(emoji);
});

test("a persistent StringDecoder correctly reassembles a multi-byte sequence split across chunks (the fix)", () => {
  const emoji = "😀";
  const bytes = Buffer.from(emoji, "utf8");
  const decoder = new StringDecoder("utf8");

  const outA = decoder.write(bytes.subarray(0, 2)); // incomplete lead — buffered internally
  expect(outA).toBe(""); // nothing complete to emit yet
  const outB = decoder.write(bytes.subarray(2)); // completes the sequence
  expect(outA + outB).toBe(emoji);
});

test("StringDecoder also correctly reassembles a split 3-byte Korean (Hangul) character", () => {
  const hangul = "한"; // U+D55C, a 3-byte UTF-8 sequence
  const bytes = Buffer.from(hangul, "utf8");
  expect(bytes.length).toBe(3);
  const decoder = new StringDecoder("utf8");

  const outA = decoder.write(bytes.subarray(0, 1));
  const outB = decoder.write(bytes.subarray(1));
  expect(outA + outB).toBe(hangul);
});

test("StringDecoder never buffers across genuinely complete, ASCII-only chunks (no behavior change for the common case)", () => {
  const decoder = new StringDecoder("utf8");
  expect(decoder.write(Buffer.from("hello ", "utf8"))).toBe("hello ");
  expect(decoder.write(Buffer.from("world", "utf8"))).toBe("world");
});

test("launch.ts wires a persistent StringDecoder into the live stdin data handler, not a naive per-chunk toString", async () => {
  // Source-text-level check (mirrors test/launch-approve-wiring.test.ts's pattern):
  // kfDataHandler is a module-local closure, not exported, so the wiring contract is
  // asserted at the source-text level instead of re-implementing a live PTY here.
  const src = await Bun.file("src/commands/launch.ts").text();
  expect(src).toContain('import { StringDecoder } from "node:string_decoder"');
  expect(src).toContain('new StringDecoder("utf8")');
  expect(src).toContain("kfUtf8Decoder.write(chunk)");
  expect(src).not.toContain('const data = chunk.toString("utf8");');
});
