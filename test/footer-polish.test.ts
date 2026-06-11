import { test, expect } from "bun:test";
import { renderFooter } from "../src/tui/components/footer";
import { sparkline } from "../src/tui/components/meter";
import { ToolList } from "../src/tui/components/tool-list";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("footer ETA is opt-in and extrapolates from elapsed/step", () => {
  // default (no showEta) → no eta segment, exact as before
  expect(stripAnsi(renderFooter({ model: "m", step: 2, maxSteps: 10, elapsedMs: 4000 }))).not.toContain("eta");
  // opt-in: 4s for 2 steps → ~8 steps remaining → eta 16s
  const out = stripAnsi(renderFooter({ model: "m", step: 2, maxSteps: 10, elapsedMs: 4000, showEta: true }));
  expect(out).toContain("eta 16s");
  // no eta at the final step
  expect(stripAnsi(renderFooter({ model: "m", step: 10, maxSteps: 10, elapsedMs: 4000, showEta: true }))).not.toContain("eta");
});

test("footer progress is opt-in: percent + steps to next stage", () => {
  const out = stripAnsi(renderFooter({ model: "m", step: 25, maxSteps: 100, showProgress: true }));
  expect(out).toContain("evo 25%");
  expect(out).toContain("Tool User (Homo Habilis) in"); // next stage countdown
  // final stage: percent only, no countdown
  const fin = stripAnsi(renderFooter({ model: "m", step: 100, maxSteps: 100, showProgress: true }));
  expect(fin).toContain("evo 100%");
  expect(fin).not.toContain(" in ");
});

test("footer unicode:false uses ASCII track + arrow", () => {
  const out = stripAnsi(renderFooter({ model: "m", step: 25, maxSteps: 100, showProgress: true, unicode: false }));
  expect(out).toContain("->"); // ascii arrow
  expect(out).toContain("##"); // ascii track markers
});

test("sparkline renders a normalized ramp; empty → empty; ascii fallback", () => {
  const sp = sparkline([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(sp.length).toBe(8);
  expect(sp[0]).toBe("\u2581"); // lowest
  expect(sp[sp.length - 1]).toBe("\u2588"); // highest
  expect(sparkline([])).toBe("");
  expect(sparkline([5, 5, 5])).toBe("\u2581\u2581\u2581"); // flat
  const ascii = sparkline([0, 7], { unicode: false });
  expect(/[^\x00-\x7f]/.test(ascii)).toBe(false);
});

test("ToolList.render caps rows and prepends a '(+N earlier)' summary", () => {
  const list = new ToolList();
  for (let i = 0; i < 10; i++) list.finish(list.start(`t${i}`), true);
  const all = list.render();
  expect(all.length).toBe(10); // no cap → all rows
  const capped = list.render(4);
  expect(capped.length).toBe(4); // 1 summary + 3 recent
  expect(stripAnsi(capped[0]!)).toContain("(+7 earlier)");
  expect(stripAnsi(capped[capped.length - 1]!)).toContain("t9"); // most recent kept
});
