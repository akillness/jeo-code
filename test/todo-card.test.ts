import { test, expect } from "bun:test";
import chalk from "chalk";
import { formatTodoWriteCard } from "../src/tui/components/todo-card";
import { LaunchTui } from "../src/tui/app";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("formatTodoWriteCard: ✓ header + tree connectors + ☑ strikethrough on done", () => {
  const prev = chalk.level;
  chalk.level = 3;
  try {
    const lines = formatTodoWriteCard([
      { title: "Write bilingual promo md in docs", status: "done" },
      { title: "Produce demo video via remotion skill", status: "in_progress" },
      { title: "Draft LinkedIn post with video", status: "pending" },
    ]);
    const plain = lines.map(stripAnsi);
    expect(plain[0]).toBe("✓ Todo Write 3 tasks");
    expect(plain[1]).toBe("  ├─ ☑ Write bilingual promo md in docs");
    expect(plain[2]).toBe("  ├─ ☐ Produce demo video via remotion skill");
    expect(plain[3]).toBe("  └─ ☐ Draft LinkedIn post with video"); // last item gets └─
    expect(lines[1]).toContain("\x1b[9m"); // done item struck through
    expect(lines[2]).not.toContain("\x1b[9m"); // active item not struck
  } finally {
    chalk.level = prev;
  }
});

test("formatTodoWriteCard: ASCII fallback and empty input", () => {
  const lines = formatTodoWriteCard(
    [{ title: "one", status: "done" }],
    { unicode: false, color: false },
  );
  expect(lines).toEqual(["v Todo Write 1 task", "  `- [x] one"]);
  expect(formatTodoWriteCard([])).toEqual([]);
});

test("LaunchTui.setTodos flushes a Todo Write card into the ledger on change only", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
  tui.start();
  out.length = 0;
  const items = [
    { title: "Scaffold module", status: "done" as const },
    { title: "Write tests", status: "in_progress" as const },
  ];
  tui.setTodos(items);
  const first = stripAnsi(out.join(""));
  // Test env has no unicode TERM — the ASCII fallback glyph set renders.
  expect(first).toContain("Todo Write 2 tasks");
  expect(first).toContain("|- [x] Scaffold module");
  expect(first).toContain("`- [ ] Write tests");

  // Re-sending the SAME list must not flush a duplicate card.
  out.length = 0;
  tui.setTodos(items.map(i => ({ ...i })));
  expect(stripAnsi(out.join(""))).not.toContain("Todo Write 2 tasks");
  tui.finish("done");
});
