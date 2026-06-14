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

test("formatTodoWriteCard: panel mode tints every row, pads to width, drives muted painter", () => {
  const fill = (s: string) => `«bg»${s}«/bg»`;
  const muted = (s: string) => `«m»${s}«/m»`;
  const lines = formatTodoWriteCard(
    [
      { title: "done one", status: "done" },
      { title: "active two", status: "in_progress" },
      { title: "pending three", status: "pending" },
    ],
    { unicode: true, color: true, fill, muted, width: 50 },
  );
  // Every row is wrapped by the fill painter → a panel rectangle.
  expect(lines.every(l => l.startsWith("«bg»") && l.endsWith("«/bg»"))).toBe(true);
  // The muted painter drives secondary text (count, connectors, done + pending labels).
  expect(lines[0]).toContain("«m»3 tasks«/m»");           // count
  expect(lines[1]).toContain("«m»done one«/m»");            // done label via muted
  expect(lines[3]).toContain("«m»pending three«/m»");       // pending label via muted
  // Active item stays accented (cyan bold), NOT muted.
  expect(lines[2]).not.toContain("«m»active two«/m»");
  // Without panel opts the bare rows return unchanged (back-compat).
  const bare = formatTodoWriteCard([{ title: "x", status: "pending" }], { color: false, unicode: false });
  expect(bare).toEqual(["v Todo Write 1 task", "  `- [ ] x"]);
});

test("formatTodoWriteCard: the in_progress item uses the theme accent painter (not hardcoded cyan)", () => {
  const accent = (s: string) => `«a»${s}«/a»`;
  const lines = formatTodoWriteCard(
    [
      { title: "active two", status: "in_progress" },
      { title: "pending three", status: "pending" },
    ],
    { unicode: true, color: true, accent },
  );
  // The active row is painted by the theme accent (so it matches green/red/warm
  // palettes), NOT a fixed cyan.
  expect(lines[1]).toContain("«a»active two«/a»");
  // Pending is NOT accented.
  expect(lines[2]).not.toContain("«a»pending three«/a»");
});

test("LaunchTui.setTodos flushes a Todo Write card into the ledger on change only", () => {
  const prevTerm = process.env.TERM;
  const prevLang = process.env.LANG;
  process.env.TERM = "xterm-256color";
  process.env.LANG = "en_US.UTF-8";
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });

  try {
    tui.start();
    out.length = 0;
    const items = [
      { title: "Scaffold module", status: "done" as const },
      { title: "Write tests", status: "in_progress" as const },
    ];
    tui.setTodos(items);
    const first = stripAnsi(out.join(""));
    expect(first).toContain("Todo Write 2 tasks");
    expect(first).toContain("├─ ☑ Scaffold module");
    expect(first).toContain("└─ ☐ Write tests");



    // Re-sending the SAME list must not flush a duplicate card.
    out.length = 0;
    tui.setTodos(items.map(i => ({ ...i })));
    expect(stripAnsi(out.join(""))).not.toContain("Todo Write 2 tasks");
    tui.finish("done");
  } finally {
    clearInterval((tui as unknown as { timer: ReturnType<typeof setInterval> }).timer);
    if (prevTerm === undefined) delete process.env.TERM;
    else process.env.TERM = prevTerm;
    if (prevLang === undefined) delete process.env.LANG;
    else process.env.LANG = prevLang;
  }
});
