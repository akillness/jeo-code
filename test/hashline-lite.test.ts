import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readTool, editTool, lineAnchor } from "../src/agent/tools";

// hashline-lite (plan/gjc-inheritance.md B2, gjc hashline 경량 계승):
// read output carries 2-char content anchors (`42ab|`); ≔ edits may cite them
// and are verified against the CURRENT content before mutating. SEARCH blocks
// that accidentally carry the display prefixes are stripped (dual-protocol fixup).

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "jeo-hashline-"));
}

test("lineAnchor: content-only, ignores trailing whitespace/CR, stable 2 chars", () => {
  expect(lineAnchor("const a = 1;")).toBe(lineAnchor("const a = 1;  "));
  expect(lineAnchor("const a = 1;")).toBe(lineAnchor("const a = 1;\r"));
  expect(lineAnchor("const a = 1;")).toMatch(/^[a-z0-9]{2}$/);
  expect(lineAnchor("const a = 1;")).not.toBe(lineAnchor("const a = 2;"));
});

test("read output lines carry LINEhh| anchors that match lineAnchor", async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, "a.ts"), "alpha\nbeta\n");
  const res = await readTool("a.ts", undefined, dir);
  expect(res.output.split("\n")[0]).toBe(`1${lineAnchor("alpha")}|alpha`);
  expect(res.output.split("\n")[1]).toBe(`2${lineAnchor("beta")}|beta`);
  await fs.rm(dir, { recursive: true, force: true });
});

test("≔ with matching anchors applies; with stale anchors rejects and re-presents", async () => {
  const dir = await tmp();
  const file = path.join(dir, "b.ts");
  await fs.writeFile(file, "one\ntwo\nthree\n");
  const ok = await editTool("b.ts", `≔2${lineAnchor("two")}\nTWO`, dir);
  expect(ok.success).toBe(true);
  expect(await fs.readFile(file, "utf-8")).toBe("one\nTWO\nthree\n");

  // Anchor minted from content that is no longer on line 2 → rejected with recovery.
  const stale = await editTool("b.ts", `≔2${lineAnchor("two")}\nNEVER`, dir);
  expect(stale.success).toBe(false);
  expect(stale.error).toContain("anchor mismatch at line 2");
  expect(stale.error).toContain("Current content:");
  expect(await fs.readFile(file, "utf-8")).toBe("one\nTWO\nthree\n"); // untouched
  await fs.rm(dir, { recursive: true, force: true });
});

test("≔ range anchors verify both endpoints; plain ≔A..B stays valid (back-compat)", async () => {
  const dir = await tmp();
  const file = path.join(dir, "c.ts");
  await fs.writeFile(file, "l1\nl2\nl3\nl4\n");
  const both = await editTool("c.ts", `≔2${lineAnchor("l2")}..3${lineAnchor("l3")}\nMID`, dir);
  expect(both.success).toBe(true);
  expect(await fs.readFile(file, "utf-8")).toBe("l1\nMID\nl4\n");
  // No anchors → no verification, legacy behavior.
  const plain = await editTool("c.ts", "≔1..1\nL1", dir);
  expect(plain.success).toBe(true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("≔A+ insert verifies the anchor line when supplied", async () => {
  const dir = await tmp();
  const file = path.join(dir, "d.ts");
  await fs.writeFile(file, "head\ntail\n");
  const ok = await editTool("d.ts", `≔1${lineAnchor("head")}+\ninserted`, dir);
  expect(ok.success).toBe(true);
  expect(await fs.readFile(file, "utf-8")).toBe("head\ninserted\ntail\n");
  const bad = await editTool("d.ts", "≔1zz+\nnope", dir);
  expect(bad.success === false && bad.error?.includes("anchor mismatch")).toBe(true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("SEARCH block with copy-pasted anchor prefixes is stripped and applied", async () => {
  const dir = await tmp();
  const file = path.join(dir, "e.ts");
  await fs.writeFile(file, "function f() {\n  return 1;\n}\n");
  // The model copied read output verbatim — display prefixes included.
  const block = [
    "<<<<<<< SEARCH",
    `1${lineAnchor("function f() {")}|function f() {`,
    `2${lineAnchor("  return 1;")}|  return 1;`,
    "=======",
    "function f() {",
    "  return 2;",
    ">>>>>>>",
  ].join("\n");
  const res = await editTool("e.ts", block, dir);
  expect(res.success).toBe(true);
  expect(await fs.readFile(file, "utf-8")).toBe("function f() {\n  return 2;\n}\n");
  await fs.rm(dir, { recursive: true, force: true });
});
