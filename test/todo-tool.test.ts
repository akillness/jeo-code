import { test, expect } from "bun:test";
import {
  createTodoTool,
  parseTodoItems,
  normalizeTodoStatus,
  renderTodoChecklist,
} from "../src/agent/todo-tool";

test("normalizeTodoStatus: maps loose strings to canonical statuses", () => {
  expect(normalizeTodoStatus("in-progress")).toBe("in_progress");
  expect(normalizeTodoStatus("ACTIVE")).toBe("in_progress");
  expect(normalizeTodoStatus("completed")).toBe("done");
  expect(normalizeTodoStatus("x")).toBe("pending");
  expect(normalizeTodoStatus(undefined)).toBe("pending");
});

test("parseTodoItems: accepts objects and auto-promotes first pending", () => {
  const items = parseTodoItems({ todos: [{ title: "A" }, { title: "B" }] });
  expect(items).not.toBeNull();
  expect(items![0]).toEqual({ title: "A", status: "in_progress" });
  expect(items![1]).toEqual({ title: "B", status: "pending" });
});

test("parseTodoItems: respects an explicit in_progress (no extra promotion)", () => {
  const items = parseTodoItems({ todos: [{ title: "A", status: "done" }, { title: "B", status: "in_progress" }, { title: "C" }] });
  expect(items!.map(i => i.status)).toEqual(["done", "in_progress", "pending"]);
});

test("parseTodoItems: accepts a string shorthand list", () => {
  const items = parseTodoItems({ items: ["first", "second"] });
  expect(items!.map(i => i.title)).toEqual(["first", "second"]);
  expect(items![0].status).toBe("in_progress"); // auto-promoted
});

test("parseTodoItems: returns null for missing/empty input", () => {
  expect(parseTodoItems({})).toBeNull();
  expect(parseTodoItems({ todos: [] })).toBeNull();
  expect(parseTodoItems({ todos: ["", "   "] })).toBeNull();
});

test("renderTodoChecklist: glyphs reflect status", () => {
  const out = renderTodoChecklist([
    { title: "done one", status: "done" },
    { title: "active one", status: "in_progress" },
    { title: "todo one", status: "pending" },
  ]);
  expect(out).toContain("[x] done one");
  expect(out).toContain("[>] active one");
  expect(out).toContain("[ ] todo one");
});

test("createTodoTool: updates plan, fires onChange, reports done count", async () => {
  const seen: { title: string; status: string }[][] = [];
  const tool = createTodoTool({ onChange: items => seen.push(items.map(i => ({ ...i }))) });

  const res = await tool({ todos: [{ title: "A", status: "done" }, { title: "B" }] }, process.cwd());
  expect(res.success).toBe(true);
  expect(res.output).toContain("Plan updated (1/2 done)");
  expect(seen.length).toBe(1);
  expect(seen[0].map(i => i.status)).toEqual(["done", "in_progress"]);
});

test("createTodoTool: bad input is a soft failure (no throw)", async () => {
  const tool = createTodoTool();
  const res = await tool({ nope: true }, process.cwd());
  expect(res.success).toBe(false);
  expect(res.error).toContain("requires 'todos'");
});
