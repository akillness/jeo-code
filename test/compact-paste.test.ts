import { expect, test } from "bun:test";
import {
  CompactPasteStore,
  filterPromptInputChunk,
  captureLivePromptInputChunk,
  PASTE_START,
  PASTE_END,
  type PromptKeyFilterState,
  type PromptInputQueue,
} from "../src/commands/launch/input";
import { renderInputFrame } from "../src/tui/components/input-box";

for (const { name, content, marker } of [
  { name: "single line", content: "private body", marker: "[Paste #1, 1 lines, 12 cols]" },
  { name: "CJK and surrogate pairs", content: "한🙂\r\nab", marker: "[Paste #1, 2 lines, 4 cols]" },
  { name: "mixed line endings and trailing newline", content: "abc\r\nx\ry\n", marker: "[Paste #1, 4 lines, 3 cols]" },
]) {
  test(`compact paste: ${name} renders counts but expands to the exact body`, () => {
    const store = new CompactPasteStore();
    const draft = store.store(content);
    expect(draft).toBe(marker);
    const frame = renderInputFrame(draft, { cols: 80, cursor: draft.length, color: false, unicode: false });
    expect(frame.lines.join("\n")).toContain(marker);
    expect(frame.lines.join("\n")).not.toContain(content);
    expect(store.expand(`before ${draft} after`)).toBe(`before ${content} after`);
  });
}

test("compact paste: repeated pastes preserve typed spacing, tabs and replacement metacharacters", () => {
  const store = new CompactPasteStore();
  const first = "\tprivate $& $` $' $$\r\n한🙂";
  const second = "  second\nbody  ";
  const a = store.store(first);
  const b = store.store(second);
  expect(a).not.toBe(b);
  expect(store.expand(`typed  ${a} / ${b} end`)).toBe(`typed  ${first} / ${second} end`);
  expect(store.expand(`${b} ${a}`)).toBe(`${second} ${first}`);
});

test("compact paste: deleting or editing a marker removes only that hidden body", () => {
  const store = new CompactPasteStore();
  const a = store.store("first secret");
  const b = store.store("second secret");
  expect(store.expand(`before ${b} after`)).toBe("before second secret after");
  const edited = a.slice(0, -1);
  expect(store.expand(`${edited} ${b}`)).toBe(`${edited} second secret`);
  expect(store.expand("typed [Paste #99, 1 lines, 3 cols]")).toBe("typed [Paste #99, 1 lines, 3 cols]");
});

test("compact paste: pasted marker-like text is not recursively expanded", () => {
  const store = new CompactPasteStore();
  const first = store.store("must not replace this nested marker");
  const secondBody = `quoted ${first}`;
  const second = store.store(secondBody);
  expect(store.expand(second)).toBe(secondBody);
});

test("compact paste: reset discards old hidden content instead of reviving it on later submit", () => {
  const store = new CompactPasteStore();
  const removed = store.store("discarded secret");
  store.clear();
  expect(store.expand(removed)).toBe(removed);
  const current = store.store("new content with a different width");
  expect(store.expand(current)).toBe("new content with a different width");
  expect(store.expand(removed)).not.toContain("discarded secret");
});

test("compact paste: split terminal reads never leak body bytes or submit a partial paste", () => {
  const store = new CompactPasteStore();
  const state: PromptKeyFilterState = { inPaste: false };
  const env = { loneLfShiftEnter: false, slashMatchCount: 0, historyPanelOpen: false, columns: 80, storePaste: (text: string) => store.store(text) };
  const first = filterPromptInputChunk(`${PASTE_START}private\r`, null, env, state).out;
  expect(first.replaceAll(PASTE_START, "")).toBe("");
  const second = filterPromptInputChunk(`\n한🙂\t$&${PASTE_END}`, null, env, state).out;
  const draft = (first + second).replaceAll(PASTE_START, "").replaceAll(PASTE_END, "");
  expect(draft).toMatch(/^\[Paste #1, 2 lines, \d+ cols\]$/);
  expect(draft).not.toContain("private");
  expect(store.expand(draft)).toBe("private\r\n한🙂\t$&");
});

test("compact paste: live-turn capture uses the same compact draft and exact submission body", () => {
  const store = new CompactPasteStore();
  const queue: PromptInputQueue = { pendingLines: [], pastedLines: [], partial: "typed ", inPaste: false };
  const options = { storePaste: (text: string) => store.store(text) };
  captureLivePromptInputChunk(queue, `${PASTE_START}live\r`, options);
  expect(queue.partial).toBe("typed ");
  captureLivePromptInputChunk(queue, `\nbody${PASTE_END}`, options);
  expect(queue.partial).toBe("typed [Paste #1, 2 lines, 4 cols]");
  expect(queue.pendingLines).toEqual([]);
  expect(queue.pastedLines).toEqual([]);
  expect(store.expand(queue.partial)).toBe("typed live\r\nbody");
});

test("compact paste: every split of delimiters, CRLF and UTF-16 preserves the original submission", () => {
  const content = "private-split\r\n한🙂\t$&";
  const bytes = `${PASTE_START}${content}${PASTE_END}`;
  for (let split = 1; split < bytes.length; split++) {
    const store = new CompactPasteStore();
    const state: PromptKeyFilterState = { inPaste: false };
    const env = { loneLfShiftEnter: false, slashMatchCount: 0, historyPanelOpen: false, columns: 80, storePaste: (text: string) => store.store(text) };
    const head = filterPromptInputChunk(bytes.slice(0, split), null, env, state).out;
    expect(head.replaceAll(PASTE_START, "")).toBe("");
    const tail = filterPromptInputChunk(bytes.slice(split), null, env, state).out;
    const draft = (head + tail).replaceAll(PASTE_START, "").replaceAll(PASTE_END, "");
    expect(draft).toMatch(/^\[Paste #1, 2 lines, \d+ cols\]$/);
    expect(store.expand(draft)).toBe(content);
  }
});

test("compact paste: hidden-content detection distinguishes resolvable references from literal or edited markers", () => {
  const store = new CompactPasteStore();
  const first = store.store("hidden body");
  const second = store.store(`quoted ${first}`);
  for (const { text, hidden } of [
    { text: `typed ${first} tail`, hidden: true },
    { text: `${first} ${first}`, hidden: true },
    { text: second, hidden: true },
    { text: first.slice(0, -1), hidden: false },
    { text: "[Paste #99, 1 lines, 4 cols]", hidden: false },
    { text: "ordinary typed words", hidden: false },
  ]) {
    expect(store.has(text)).toBe(hidden);
    expect(store.has(text)).toBe(store.expand(text) !== text);
  }
  const self = new CompactPasteStore();
  const literal = "[Paste #1, 1 lines, 28 cols]";
  expect(self.store(literal)).toBe(literal);
  expect(self.has(literal)).toBe(false);
  expect(self.expand(literal)).toBe(literal);
});

test("compact paste: long bodies retain nested start-marker bytes as data across terminal reads", () => {
  const store = new CompactPasteStore();
  const state: PromptKeyFilterState = { inPaste: false };
  const env = { loneLfShiftEnter: false, slashMatchCount: 0, historyPanelOpen: false, columns: 80, storePaste: (text: string) => store.store(text) };
  const content = `${"private-long\r\n".repeat(200)}literal ${PASTE_START} nested\t한🙂`;
  const head = filterPromptInputChunk(`${PASTE_START}${content.slice(0, 1000)}`, null, env, state).out;
  expect(head.replaceAll(PASTE_START, "")).toBe("");
  const tail = filterPromptInputChunk(`${content.slice(1000)}${PASTE_END}`, null, env, state).out;
  const draft = (head + tail).replaceAll(PASTE_START, "").replaceAll(PASTE_END, "");
  expect(draft).toMatch(/^\[Paste #1, 201 lines, \d+ cols\]$/);
  expect(store.expand(draft)).toBe(content);
});

test("compact paste: two pastes in one terminal read preserve typed text and independent payloads", () => {
  const store = new CompactPasteStore();
  const state: PromptKeyFilterState = { inPaste: false };
  const env = { loneLfShiftEnter: false, slashMatchCount: 0, historyPanelOpen: false, columns: 80, storePaste: (text: string) => store.store(text) };
  const first = "first\r\n한🙂";
  const second = "second\t$&";
  const result = filterPromptInputChunk(`left ${PASTE_START}${first}${PASTE_END} middle ${PASTE_START}${second}${PASTE_END} right`, null, env, state);
  const draft = result.out.replaceAll(PASTE_START, "").replaceAll(PASTE_END, "");
  expect(draft).toMatch(/^left \[Paste #1, 2 lines, \d+ cols\] middle \[Paste #2, 1 lines, \d+ cols\] right$/);
  expect(store.expand(draft)).toBe(`left ${first} middle ${second} right`);
});

for (const withMetadata of [false, true]) {
  test(`compact paste: restoring a historical literal marker ${withMetadata ? "with unmatched metadata" : "without metadata"} never revives another history entry`, () => {
    const store = new CompactPasteStore();
    const earlier = store.restore({ content: "ABC\nDEF" });
    const literal = "[Paste #1, 2 lines, 3 cols]";
    const restored = store.restore({
      content: literal,
      ...(withMetadata ? { inputDisplay: { text: literal, textLength: literal.length, pastes: [] } } : {}),
    });
    expect(store.expand(restored)).toBe(literal);
    expect(store.expand(earlier)).toBe("ABC\nDEF");
  });
}

const firstRestoreMarker = "[Paste #7, 1 lines, 4 cols]";
const secondRestoreMarker = "[Paste #8, 1 lines, 4 cols]";
for (const { name, content, inputDisplay } of [
  { name: "different visible text", content: "SAFE", inputDisplay: { text: "DIFFERENT", textLength: 4, pastes: [] } },
  { name: "negative range", content: "SAFE", inputDisplay: { text: firstRestoreMarker, textLength: 4, pastes: [{ marker: firstRestoreMarker, start: -1, end: 4 }] } },
  { name: "range past canonical end", content: "SAFE", inputDisplay: { text: firstRestoreMarker, textLength: 4, pastes: [{ marker: firstRestoreMarker, start: 0, end: 5 }] } },
  { name: "fractional range", content: "SAFE", inputDisplay: { text: firstRestoreMarker, textLength: 4, pastes: [{ marker: firstRestoreMarker, start: 0.5, end: 4 }] } },
  { name: "reversed range", content: "SAFE", inputDisplay: { text: firstRestoreMarker, textLength: 4, pastes: [{ marker: firstRestoreMarker, start: 3, end: 1 }] } },
  { name: "overlapping ranges", content: "ABCDEF", inputDisplay: { text: firstRestoreMarker + secondRestoreMarker, textLength: 6, pastes: [{ marker: firstRestoreMarker, start: 0, end: 4 }, { marker: secondRestoreMarker, start: 2, end: 6 }] } },
  { name: "valid bounds with inconsistent reconstruction", content: "SAFE", inputDisplay: { text: `wrong ${firstRestoreMarker}`, textLength: 4, pastes: [{ marker: firstRestoreMarker, start: 0, end: 4 }] } },
  { name: "missing reference in display", content: "SAFE", inputDisplay: { text: "unrelated display", textLength: 4, pastes: [{ marker: firstRestoreMarker, start: 0, end: 4 }] } },
]) {
  test(`compact paste: ${name} metadata cannot replace canonical history text`, () => {
    const store = new CompactPasteStore();
    const restored = store.restore({ content, inputDisplay });
    expect(store.expand(restored)).toBe(content);
  });
}

for (const { name, key } of [
  { name: "Backspace DEL", key: "\u007f" },
  { name: "Backspace BS", key: "\b" },
]) {
  test(`compact paste: live ${name} removes one complete hidden paste without damaging typed text`, () => {
    const store = new CompactPasteStore();
    const queue: PromptInputQueue = { pendingLines: [], pastedLines: [], partial: "typed prefix ", inPaste: false };
    const options = { storePaste: (text: string) => store.store(text) };
    captureLivePromptInputChunk(queue, `${PASTE_START}secret\nbody${PASTE_END}`, options);
    expect(store.expand(queue.partial)).toBe("typed prefix secret\nbody");
    captureLivePromptInputChunk(queue, key, options);
    expect(queue.partial).toBe("typed prefix ");
    expect(store.expand(queue.partial)).toBe("typed prefix ");
    captureLivePromptInputChunk(queue, "ordinary text", options);
    expect(store.expand(queue.partial)).toBe("typed prefix ordinary text");
    expect(queue.pendingLines).toEqual([]);
    expect(queue.pastedLines).toEqual([]);
  });
}

test("compact paste: live Backspace still edits ordinary typed characters one at a time", () => {
  const store = new CompactPasteStore();
  const queue: PromptInputQueue = { pendingLines: [], pastedLines: [], partial: "typed 🙂", inPaste: false };
  const options = { storePaste: (text: string) => store.store(text) };
  captureLivePromptInputChunk(queue, "\u007f", options);
  expect(store.expand(queue.partial)).toBe("typed ");
  captureLivePromptInputChunk(queue, "x", options);
  expect(store.expand(queue.partial)).toBe("typed x");
});

test("compact paste: forward Delete at the live append cursor leaves both hidden pastes and ordinary text intact", () => {
  const store = new CompactPasteStore();
  const options = { storePaste: (text: string) => store.store(text) };
  const queue: PromptInputQueue = { pendingLines: [], pastedLines: [], partial: "typed prefix ", inPaste: false };
  captureLivePromptInputChunk(queue, `${PASTE_START}secret\nbody${PASTE_END}`, options);
  const display = queue.partial;
  captureLivePromptInputChunk(queue, "\u001b[3~", options);
  expect(queue.partial).toBe(display);
  expect(store.expand(queue.partial)).toBe("typed prefix secret\nbody");
  captureLivePromptInputChunk(queue, "ordinary text", options);
  captureLivePromptInputChunk(queue, "\u001b[3~", options);
  expect(store.expand(queue.partial)).toBe("typed prefix secret\nbodyordinary text");
});

for (const { name, inputDisplay } of [
  { name: "negative text length", inputDisplay: { text: "DIFFERENT", textLength: -1, pastes: [] } },
  { name: "text length past content end", inputDisplay: { text: "DIFFERENT", textLength: 100, pastes: [] } },
  { name: "non-finite text length", inputDisplay: { text: "DIFFERENT", textLength: Number.NaN, pastes: [] } },
  { name: "fractional text length", inputDisplay: { text: "DIFFERENT", textLength: 2.5, pastes: [] } },
  { name: "conflicting repeated reference", inputDisplay: { text: firstRestoreMarker + firstRestoreMarker, textLength: 4, pastes: [{ marker: firstRestoreMarker, start: 0, end: 2 }, { marker: firstRestoreMarker, start: 2, end: 4 }] } },
  { name: "unsafe display escapes", inputDisplay: { text: "\u001b[2JSAFE", textLength: 4, pastes: [] } },
]) {
  test(`compact paste: ${name} metadata falls back to canonical content`, () => {
    const store = new CompactPasteStore();
    const content = "SAFE";
    expect(store.expand(store.restore({ content, inputDisplay }))).toBe(content);
  });
}

for (const { name, chunks, expected } of [
  { name: "paste, Backspace, and typing in one read", chunks: [`${PASTE_START}secret\nbody${PASTE_END}\u007fnext`], expected: "prefix next" },
  { name: "Backspace and typing after a separate paste read", chunks: [`${PASTE_START}secret\nbody${PASTE_END}`, "\bnext"], expected: "prefix next" },
  { name: "ordinary typing before and after Backspace in one read", chunks: ["ab\u007fc"], expected: "prefix ac" },
  { name: "typed suffix Backspace after a paste in one read", chunks: [`${PASTE_START}secret\nbody${PASTE_END}ab\u007fc`], expected: "prefix secret\nbodyac" },
]) {
  test(`compact paste: live ${name} preserves edit order`, () => {
    const store = new CompactPasteStore();
    const queue: PromptInputQueue = { pendingLines: [], pastedLines: [], partial: "prefix ", inPaste: false };
    for (const chunk of chunks) captureLivePromptInputChunk(queue, chunk, { storePaste: content => store.store(content) });
    expect(store.expand(queue.partial)).toBe(expected);
  });
}

test("compact paste: non-string display text loaded from serialized history falls back to canonical content", () => {
  const store = new CompactPasteStore();
  const message = JSON.parse('{"content":"SAFE","inputDisplay":{"text":42,"textLength":4,"pastes":[]}}');
  expect(store.expand(store.restore(message))).toBe("SAFE");
});

test("compact paste: live Home followed by Backspace uses the append cursor and never fragments a hidden paste", () => {
  const store = new CompactPasteStore();
  const options = { storePaste: (content: string) => store.store(content) };
  const queue: PromptInputQueue = { pendingLines: [], pastedLines: [], partial: "prefix ", inPaste: false };
  captureLivePromptInputChunk(queue, `${PASTE_START}secret\nbody${PASTE_END}`, options);
  captureLivePromptInputChunk(queue, "\u001b[H\u007fnext", options);
  expect(queue.partial).toBe("prefix next");
  expect(store.expand(queue.partial)).toBe("prefix next");
});

for (const { name, key } of [
  { name: "kitty CSI-u", key: "\u001b[127u" },
  { name: "xterm modifyOtherKeys", key: "\u001b[27;1;127~" },
]) {
  test(`compact paste: idle ${name} Backspace removes the complete marker before forwarding typed suffix`, () => {
    const store = new CompactPasteStore();
    const marker = store.store("secret\nbody");
    const rl = { line: `prefix ${marker}`, cursor: `prefix ${marker}`.length };
    const result = filterPromptInputChunk(`${key}next`, rl, {
      loneLfShiftEnter: false, slashMatchCount: 0, historyPanelOpen: false, columns: 80,
      atomicMarkers: true, storePaste: content => store.store(content),
    }, { inPaste: false });
    expect(rl.line).toBe("prefix ");
    expect(rl.cursor).toBe("prefix ".length);
    expect(result.out).toBe("next");
    expect(store.expand(rl.line + result.out)).toBe("prefix next");
  });

  test(`compact paste: live ${name} Backspace removes the complete marker and preserves following typing`, () => {
    const store = new CompactPasteStore();
    const options = { storePaste: (content: string) => store.store(content) };
    const queue: PromptInputQueue = { pendingLines: [], pastedLines: [], partial: "prefix ", inPaste: false };
    captureLivePromptInputChunk(queue, `${PASTE_START}secret\nbody${PASTE_END}`, options);
    captureLivePromptInputChunk(queue, `${key}next`, options);
    expect(queue.partial).toBe("prefix next");
    expect(store.expand(queue.partial)).toBe("prefix next");
  });

  test(`compact paste: live ${name} Backspace retains ordinary Unicode character editing`, () => {
    const store = new CompactPasteStore();
    const queue: PromptInputQueue = { pendingLines: [], pastedLines: [], partial: "prefix 🙂", inPaste: false };
    captureLivePromptInputChunk(queue, `${key}next`, { storePaste: content => store.store(content) });
    expect(store.expand(queue.partial)).toBe("prefix next");
  });
}

test("compact paste: a kitty Backspace key release does not delete a hidden paste", () => {
  const store = new CompactPasteStore();
  const marker = store.store("secret\nbody");
  const rl = { line: `prefix ${marker}`, cursor: `prefix ${marker}`.length };
  const result = filterPromptInputChunk("\u001b[127;1:3unext", rl, {
    loneLfShiftEnter: false, slashMatchCount: 0, historyPanelOpen: false, columns: 80,
    atomicMarkers: true, storePaste: content => store.store(content),
  }, { inPaste: false });
  expect(rl.line).toBe(`prefix ${marker}`);
  expect(result.out).toBe("next");
  expect(store.expand(rl.line + result.out)).toBe("prefix secret\nbodynext");
});

for (const { name, escape } of [
  { name: "kitty CSI-u", escape: "\u001b[27u" },
  { name: "xterm modifyOtherKeys", escape: "\u001b[27;1;27~" },
]) {
  test(`compact paste: ${name} Escape never leaves readline a dangling Meta prefix before the next typed character`, () => {
    const state: PromptKeyFilterState = { inPaste: false };
    const env = { loneLfShiftEnter: false, slashMatchCount: 0, historyPanelOpen: false, columns: 80 };
    const rl = { line: "", cursor: 0 };
    const escaped = filterPromptInputChunk(escape, rl, env, state);
    const next = filterPromptInputChunk("a", rl, env, state);
    expect(escaped.out).toBe("");
    expect(next.out).toBe("a");
  });
}
