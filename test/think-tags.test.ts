import { test, expect } from "bun:test";
import { createThinkSplitter } from "../src/ai/think-tags";

function run(deltas: string[]): { visible: string; reasoning: string } {
  let reasoning = "";
  const s = createThinkSplitter(d => { reasoning += d; });
  let visible = "";
  for (const d of deltas) visible += s.push(d);
  visible += s.flush();
  return { visible, reasoning };
}

test("plain text passes through untouched (no tags, no reasoning)", () => {
  expect(run(["hello ", "world"])).toEqual({ visible: "hello world", reasoning: "" });
});

test("a whole <think> block is routed to reasoning, answer stays visible", () => {
  expect(run(["<think>weighing options</think>the answer"]))
    .toEqual({ visible: "the answer", reasoning: "weighing options" });
});

test("text before and after the think block is preserved", () => {
  expect(run(["pre <think>mid</think> post"]))
    .toEqual({ visible: "pre  post", reasoning: "mid" });
});

test("tags split across chunk boundaries are reassembled", () => {
  // every tag char arrives in its own delta
  const deltas = "<think>abc</think>XY".split("");
  expect(run(deltas)).toEqual({ visible: "XY", reasoning: "abc" });
});

test("open tag straddling two chunks", () => {
  expect(run(["ans<thi", "nk>reason</think>done"]))
    .toEqual({ visible: "ansdone", reasoning: "reason" });
});

test("close tag straddling two chunks", () => {
  expect(run(["<think>reason</thi", "nk>visible"]))
    .toEqual({ visible: "visible", reasoning: "reason" });
});

test("unterminated <think> at stream end flushes as reasoning, not answer", () => {
  expect(run(["<think>still thinking"]))
    .toEqual({ visible: "", reasoning: "still thinking" });
});

test("a lone trailing '<' is not lost (flushed as visible)", () => {
  expect(run(["a<"])).toEqual({ visible: "a<", reasoning: "" });
});

test("a literal '<' mid-text is not delayed or dropped", () => {
  expect(run(["if (a < b) return"])).toEqual({ visible: "if (a < b) return", reasoning: "" });
});

test("multiple think blocks accumulate reasoning and concatenate visible text", () => {
  expect(run(["<think>one</think>A<think>two</think>B"]))
    .toEqual({ visible: "AB", reasoning: "onetwo" });
});
