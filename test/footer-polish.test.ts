import { test, expect } from "bun:test";
import { renderFooter } from "../src/tui/components/footer";
import { sparkline } from "../src/tui/components/meter";
import { ToolList } from "../src/tui/components/tool-list";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// Step-derived ETA, progress, and ASCII track features were removed from the footer.

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
