import { test, expect } from "bun:test";
import { SelectList, renderSelectList, type SelectItem } from "../src/tui/components/select-list";

const items = (labels: string[], disabled: string[] = []): SelectItem<string>[] =>
  labels.map(l => ({ value: l, label: l, disabled: disabled.includes(l) }));

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("starts on the first enabled item", () => {
  const list = new SelectList(items(["a", "b", "c"], ["a"]));
  expect(list.selected()!.value).toBe("b");
  expect(list.cursorIndex()).toBe(1);
});

test("up/down wrap and skip disabled items", () => {
  const list = new SelectList(items(["a", "b", "c", "d"], ["b", "c"]));
  expect(list.selected()!.value).toBe("a");
  list.down();
  expect(list.selected()!.value).toBe("d"); // skipped b, c
  list.down();
  expect(list.selected()!.value).toBe("a"); // wrapped
  list.up();
  expect(list.selected()!.value).toBe("d"); // wrap back, skip
});

test("filter narrows visible set and resets cursor to first enabled match", () => {
  const list = new SelectList(items(["apple", "banana", "apricot"]));
  list.setFilter("ap");
  expect(list.visible().map(i => i.value)).toEqual(["apple", "apricot"]);
  expect(list.selected()!.value).toBe("apple");
  list.setFilter("zzz");
  expect(list.isEmpty()).toBe(true);
  expect(list.selected()).toBeUndefined();
});

test("typeChar / backspace edit the filter", () => {
  const list = new SelectList(items(["alpha", "beta"]));
  list.typeChar("b");
  expect(list.filter()).toBe("b");
  expect(list.selected()!.value).toBe("beta");
  list.backspace();
  expect(list.filter()).toBe("");
  expect(list.visible().length).toBe(2);
});

test("page moves by a window without wrapping", () => {
  const list = new SelectList(items(["0", "1", "2", "3", "4", "5", "6", "7"]));
  list.page(1, 3);
  expect(list.selected()!.value).toBe("3");
  list.page(1, 100); // clamps to last
  expect(list.selected()!.value).toBe("7");
  list.page(-1, 100); // clamps to first
  expect(list.selected()!.value).toBe("0");
});

test("renderSelectList shows a scrolling window with cursor + filter footer", () => {
  const list = new SelectList(items(["a", "b", "c", "d", "e", "f"]));
  list.down();
  list.down(); // cursor on "c"
  const lines = renderSelectList(list, { title: "Pick:", rows: 3, color: false, unicode: false });
  const text = lines.join("\n");
  expect(text).toContain("Pick:");
  expect(text).toContain("> c"); // cursor marker on selected
  expect(text).toContain("more"); // scroll indicator present
  expect(text).toContain("type to filter");
});

test("renderSelectList renders group headers + hints, fitted to cols", () => {
  const grouped: SelectItem<string>[] = [
    { value: "x", label: "x", group: "G1", hint: "h1" },
    { value: "y", label: "y", group: "G2", hint: "h2" },
  ];
  const list = new SelectList(grouped);
  const lines = renderSelectList(list, { rows: 5, cols: 30, color: false, unicode: false });
  const text = lines.map(stripAnsi).join("\n");
  expect(text).toContain("G1");
  expect(text).toContain("G2");
  expect(text).toContain("h1");
  expect(lines.map(stripAnsi).every(line => line.length <= 30)).toBe(true);
});
test("renderSelectList supports multi-line titles and pre-styled hints", () => {
  const list = new SelectList<string>([
    { value: "x", label: "x", hint: "\x1b[31mRAW\x1b[0m", hintRaw: true },
  ]);
  const lines = renderSelectList(list, { title: "Line one\n\nLine three", rows: 2, color: false, unicode: false });
  const text = lines.join("\n");
  expect(text).toContain("Line one\n\nLine three");
  expect(text).toContain("\x1b[31mRAW\x1b[0m");
});
test("renderSelectList renders selectable nested sub-list rows", () => {
  const list = new SelectList<string>([
    { value: "heading", label: "Set as PLANNER (Planner)", disabled: true },
    { value: "planner:inherit", label: "thinking inherit", depth: 1, branch: "mid" },
    { value: "planner:xhigh", label: "thinking xhigh", depth: 1, branch: "last" },
  ]);
  const lines = renderSelectList(list, { rows: 5, color: false, unicode: true }).map(stripAnsi);
  expect(list.selected()?.value).toBe("planner:inherit");
  expect(lines.join("\n")).toContain("  Set as PLANNER (Planner)");
  expect(lines.join("\n")).toContain("❯ ├─ thinking inherit");
  expect(lines.join("\n")).toContain("  └─ thinking xhigh");
});

test("empty list renders a (no matches) line, not a crash", () => {
  const list = new SelectList<string>([]);
  const lines = renderSelectList(list, { color: false });
  expect(lines.join("\n")).toContain("(no matches)");
  expect(list.selected()).toBeUndefined();
});

const grouped = (): SelectItem<string>[] => [
  { value: "o1", label: "gpt-5", group: "openai" },
  { value: "o2", label: "gpt-4", group: "openai" },
  { value: "a1", label: "sonnet", group: "anthropic" },
  { value: "g1", label: "gemini", group: "google" },
];

test("tabList is ALL plus each provider/group in first-seen order", () => {
  const list = new SelectList(grouped());
  expect(list.tabList()).toEqual(["ALL", "openai", "anthropic", "google"]);
  expect(list.activeTab()).toBe("ALL");
});

test("group-less lists expose only the ALL tab", () => {
  const list = new SelectList(items(["a", "b"]));
  expect(list.tabList()).toEqual(["ALL"]);
  list.cycleTab(1); // no-op when there is nothing to cycle
  expect(list.activeTab()).toBe("ALL");
});

test("cycleTab scopes the visible set to one provider and wraps back to ALL", () => {
  const list = new SelectList(grouped());
  list.cycleTab(1);
  expect(list.activeTab()).toBe("openai");
  expect(list.visible().map(i => i.value)).toEqual(["o1", "o2"]);
  list.cycleTab(1);
  expect(list.activeTab()).toBe("anthropic");
  expect(list.visible().map(i => i.value)).toEqual(["a1"]);
  list.cycleTab(-1); // step back
  expect(list.activeTab()).toBe("openai");
  list.cycleTab(-1); // wrap to ALL
  expect(list.activeTab()).toBe("ALL");
  expect(list.visible().length).toBe(4);
});

test("switching provider tabs resets the cursor to that tab's first item", () => {
  const list = new SelectList(grouped());
  list.cycleTab(1); // openai
  list.down(); // cursor on o2
  expect(list.selected()!.value).toBe("o2");
  list.cycleTab(1); // anthropic — cursor must reset
  expect(list.selected()!.value).toBe("a1");
});

test("a provider tab and a text filter compose (filter applies within the tab)", () => {
  const list = new SelectList(grouped());
  list.cycleTab(1); // openai
  list.setFilter("gpt-5");
  expect(list.visible().map(i => i.value)).toEqual(["o1"]);
  list.setFilter("sonnet"); // anthropic model is hidden by the openai tab
  expect(list.isEmpty()).toBe(true);
});

test("renderSelectList showTabs draws a tab bar marking the active tab + footer hint", () => {
  const list = new SelectList(grouped());
  list.cycleTab(1); // openai active
  const lines = renderSelectList(list, { rows: 6, color: false, unicode: false, showTabs: true }).map(stripAnsi);
  const text = lines.join("\n");
  expect(text).toContain("[openai]"); // active tab bracketed
  expect(text).toContain("ALL");
  expect(text).toContain("anthropic");
  expect(text).toContain("tab provider"); // footer key hint
});

test("renderSelectList omits the tab bar when there is only the ALL tab", () => {
  const list = new SelectList(items(["a", "b"]));
  const text = renderSelectList(list, { color: false, unicode: false, showTabs: true }).map(stripAnsi).join("\n");
  expect(text).not.toContain("tab provider");
  expect(text).not.toContain("[ALL]");
});
