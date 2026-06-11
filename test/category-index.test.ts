import { test, expect } from "bun:test";
import { categoryBadge, categoryForTool, prefixCategory } from "../src/tui/components/category-index";
import { ToolList, formatForgeBox, summarizeForgeInvocation } from "../src/tui/components";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("categoryBadge renders stable plain indexes", () => {
  expect(categoryBadge("cmd", { index: 3, color: false })).toBe("[03:CMD]");
  expect(prefixCategory("file", "src/app.ts", { color: false })).toBe("[FILE] src/app.ts");
});

test("categoryForTool classifies command, file, diff, search, subagent, and generic tools", () => {
  expect(categoryForTool("bash")).toBe("cmd");
  expect(categoryForTool("read")).toBe("file");
  expect(categoryForTool("edit")).toBe("diff");
  expect(categoryForTool("search")).toBe("search");
  expect(categoryForTool("subagent")).toBe("subagent");
  expect(categoryForTool("task")).toBe("subagent");
  expect(categoryForTool("unknown")).toBe("tool");
});

test("ToolList indexed render preserves default but can add category indexes", () => {
  const list = new ToolList();
  list.finish(list.start("bash"), true);
  expect(list.render(undefined, { color: false }).map(stripAnsi)).toEqual(["  ✔ bash ok"]);
  expect(list.render(undefined, { color: false, indexed: true }).map(stripAnsi)).toEqual(["  ✔ [01:CMD] bash ok"]);
});

test("forge box header is the gjc-style bare title (no badge, no language suffix)", () => {
  const box = formatForgeBox(summarizeForgeInvocation("bash", { command: "echo hi" }), { width: 44, unicode: false, paint: s => s, color: false, index: 2 }).map(stripAnsi);
  expect(box.join("\n")).toContain("Bash");
  expect(box.join("\n")).not.toContain("[02:CMD]");
  expect(box.join("\n")).not.toContain("· bash");
  expect(box.every(line => line.length <= 44)).toBe(true);
});
