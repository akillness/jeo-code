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

test("empty list renders a (no matches) line, not a crash", () => {
  const list = new SelectList<string>([]);
  const lines = renderSelectList(list, { color: false });
  expect(lines.join("\n")).toContain("(no matches)");
  expect(list.selected()).toBeUndefined();
});
