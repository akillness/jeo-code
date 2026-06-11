import { test, expect, mock } from "bun:test";

// cycle 12 (plan/gjc-inheritance.md): write/edit calls to DISTINCT files in one
// batch run concurrently; same-file calls stay ordered; bash stays exclusive.

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function runBatch(calls: { tool: string; arguments: Record<string, any> }[]) {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tools: calls }),
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }];
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const mutating = async (args: Record<string, any>) => {
    active++;
    maxActive = Math.max(maxActive, active);
    order.push(`start ${args.filePath ?? args.label}`);
    await sleep(20);
    order.push(`end ${args.filePath ?? args.label}`);
    active--;
    return { success: true, output: "ok" };
  };
  await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 1,
    budget: { maxExtensions: 0 },
    tools: { write: mutating, edit: mutating, bash: mutating },
  });
  return { maxActive, order };
}

test("distinct-file writes in one batch run concurrently", async () => {
  const { maxActive, order } = await runBatch([
    { tool: "write", arguments: { filePath: "a.txt", content: "1" } },
    { tool: "write", arguments: { filePath: "b.txt", content: "2" } },
    { tool: "edit", arguments: { filePath: "c.txt", editBlock: "x" } },
  ]);
  expect(maxActive).toBe(3); // all three overlapped
  expect(order.filter(s => s.startsWith("start")).length).toBe(3);
});

test("same-file writes stay strictly sequential (ordered, never overlap)", async () => {
  const { maxActive, order } = await runBatch([
    { tool: "edit", arguments: { filePath: "x.txt", editBlock: "1" } },
    { tool: "edit", arguments: { filePath: "x.txt", editBlock: "2" } },
    { tool: "edit", arguments: { filePath: "x.txt", editBlock: "3" } },
  ]);
  expect(maxActive).toBe(1);
  expect(order).toEqual([
    "start x.txt", "end x.txt",
    "start x.txt", "end x.txt",
    "start x.txt", "end x.txt",
  ]);
});

test("bash is exclusive: it never overlaps a write and runs after the write group", async () => {
  const { maxActive, order } = await runBatch([
    { tool: "write", arguments: { filePath: "a.txt", content: "1" } },
    { tool: "write", arguments: { filePath: "b.txt", content: "2" } },
    { tool: "bash", arguments: { command: "echo hi", label: "bash" } },
  ]);
  // writes a+b overlap (2), bash runs alone after both writes finished.
  expect(maxActive).toBe(2);
  const bashStart = order.indexOf("start bash");
  expect(order.slice(0, bashStart)).toContain("end a.txt");
  expect(order.slice(0, bashStart)).toContain("end b.txt");
  expect(order[order.length - 1]).toBe("end bash");
});

test("a path-less write does not parallelize (treated as a collision)", async () => {
  const { maxActive } = await runBatch([
    { tool: "write", arguments: { label: "no-path-1" } },
    { tool: "write", arguments: { label: "no-path-2" } },
  ]);
  expect(maxActive).toBe(1); // undetermined path → sequential boundary each time
});

test("aliased spellings of the SAME file serialize (F3: ./x vs x lost-update fix)", async () => {
  const { maxActive, order } = await runBatch([
    { tool: "write", arguments: { filePath: "x.txt", content: "1" } },
    { tool: "write", arguments: { filePath: "./x.txt", content: "2" } },
    { tool: "edit", arguments: { filePath: "sub/../x.txt", editBlock: "z" } },
  ]);
  expect(maxActive).toBe(1); // all three resolve to one physical file → strictly sequential
  expect(order.filter(s => s.startsWith("start")).length).toBe(3);
});

test("case-variant paths serialize too (macOS case-insensitive FS safety)", async () => {
  const { maxActive } = await runBatch([
    { tool: "write", arguments: { filePath: "Foo.ts", content: "1" } },
    { tool: "write", arguments: { filePath: "foo.ts", content: "2" } },
  ]);
  expect(maxActive).toBe(1); // over-approximation: safe on every FS
});
