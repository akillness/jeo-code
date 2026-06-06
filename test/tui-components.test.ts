import { test, expect } from "bun:test";
import { Spinner, ToolList, StreamRegion, renderFooter } from "../src/tui/components";
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("Spinner.next cycles and returns to the first frame after a full loop", () => {
  const spinner = new Spinner(["a", "b", "c"]);
  expect(spinner.current()).toBe("a");
  expect(spinner.next()).toBe("a");
  expect(spinner.current()).toBe("b");
  expect(spinner.next()).toBe("b");
  expect(spinner.current()).toBe("c");
  expect(spinner.next()).toBe("c");
  // returns to the first frame after a full loop
  expect(spinner.current()).toBe("a");
  expect(spinner.next()).toBe("a");
});

test("Default spinner uses braille frames", () => {
  const spinner = new Spinner();
  expect(spinner.next()).toBe("\u280b");
});

test("ToolList start->render shows running, finish(ok=true)->ok, finish(ok=false)->FAILED", () => {
  const list = new ToolList();
  
  const idx1 = list.start("read");
  expect(idx1).toBe(0);
  expect(list.render().map(stripAnsi)).toEqual(["  · read running..."]);

  const idx2 = list.start("bash");
  expect(idx2).toBe(1);
  expect(list.render().map(stripAnsi)).toEqual([
    "  · read running...",
    "  · bash running..."
  ]);

  list.finish(idx1, true);
  expect(list.render().map(stripAnsi)).toEqual([
    "  · read ok",
    "  · bash running..."
  ]);

  list.finish(idx2, false);
  expect(list.render().map(stripAnsi)).toEqual([
    "  · read ok",
    "  · bash FAILED"
  ]);

  expect(list.currentTool()).toBeUndefined();
  expect(list.stats()).toEqual({ running: 0, ok: 1, fail: 1, total: 2 });
  list.reset();
  expect(list.render()).toEqual([]);
});

test("StreamRegion.append then render(width) wraps a >width line and splits on \\n", () => {
  const stream = new StreamRegion();
  stream.append("hello\n");
  stream.append("world-longer-text");
  
  // split on \n -> "hello", "world-longer-text"
  // wraps "world-longer-text" with width = 5 -> "world", "-long", "er-te", "xt"
  expect(stream.render(5)).toEqual([
    "hello",
    "world",
    "-long",
    "er-te",
    "xt"
  ]);

  stream.clear();
  expect(stream.render(5)).toEqual([]);
});
test("StreamRegion.render(width, maxLines) truncates the result to maxLines", () => {
  const stream = new StreamRegion();
  stream.append("line1\nline2\nline3");
  expect(stream.render(10, 2)).toEqual([
    "line2",
    "line3"
  ]);
});

test("renderFooter includes model, step 2/25, 2s and omits step when undefined", () => {
  const footer1 = renderFooter({
    model: "m",
    step: 2,
    maxSteps: 25,
    elapsedMs: 2000
  });
  expect(stripAnsi(footer1)).toBe("m · step 2/25 · 2s · \u25cf\u25cf\u25cb\u25cb\u25cb Double Helix (DNA) [2/5]");

  const footer2 = renderFooter({
    model: "m",
    elapsedMs: 2000
  });
  expect(stripAnsi(footer2)).toBe("m · 2s");

  const footer3 = renderFooter({
    model: "claude",
    provider: "anthropic",
    step: 3,
    maxSteps: 10,
    elapsedMs: 4000,
    sessionId: "1a2b3c4d5e6f"
  });
  expect(stripAnsi(footer3)).toBe("claude (anthropic) · step 3/10 · 4s · 1a2b3c4d · \u25cf\u25cf\u25cf\u25cb\u25cb Tool User (Homo Habilis) [3/5]");
});
