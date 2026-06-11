import { test, expect } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { editTool, lineAnchor } from "../src/agent/tools";

// hashline 3-way re-map (plan/gjc-inheritance.md cycle 9): content-only hashes
// mean a line that sibling edits SHIFTED keeps its anchor. When the supplied
// anchor no longer sits at its line number, the edit tool relocates the target
// by a uniform delta instead of wasting a retry — but only when the relocation
// is UNAMBIGUOUS and both range ends agree on the delta.

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "jeo-remap-"));
}

test("≔ range with shifted anchors re-maps by uniform delta and applies", async () => {
  const dir = await tmp();
  const file = path.join(dir, "a.ts");
  // Model read a file where alpha/beta were lines 5/6; 3 lines were since
  // prepended, so the block now lives at lines 8/9. Old numbers + old anchors.
  await fs.writeFile(file, "x1\nx2\nx3\nc1\nc2\nc3\nc4\nalpha\nbeta\nc7\n");
  const res = await editTool("a.ts", `≔5${lineAnchor("alpha")}..6${lineAnchor("beta")}\nGAMMA`, dir);
  expect(res.success).toBe(true);
  expect(await fs.readFile(file, "utf-8")).toBe("x1\nx2\nx3\nc1\nc2\nc3\nc4\nGAMMA\nc7\n");
  await fs.rm(dir, { recursive: true, force: true });
});

test("≔A+ insert with a shifted anchor re-maps the insert point", async () => {
  const dir = await tmp();
  const file = path.join(dir, "b.ts");
  // marker was line 3 at read; 2 lines prepended → now line 5.
  await fs.writeFile(file, "z1\nz2\nh1\nh2\nmarker\nt1\n");
  const res = await editTool("b.ts", `≔3${lineAnchor("marker")}+\nINSERTED`, dir);
  expect(res.success).toBe(true);
  expect(await fs.readFile(file, "utf-8")).toBe("z1\nz2\nh1\nh2\nmarker\nINSERTED\nt1\n");
  await fs.rm(dir, { recursive: true, force: true });
});

test("ambiguous anchor (>1 match in window) refuses to re-map and rejects", async () => {
  const dir = await tmp();
  const file = path.join(dir, "c.ts");
  // Two "same" lines: locating the anchor is ambiguous, so the tool must NOT
  // guess — it falls back to the reject+re-present path and leaves the file.
  await fs.writeFile(file, "pre\nsame\nmid\nsame\n");
  const res = await editTool("c.ts", `≔1${lineAnchor("same")}\nX`, dir);
  expect(res.success).toBe(false);
  expect(res.error).toContain("anchor mismatch at line 1");
  expect(await fs.readFile(file, "utf-8")).toBe("pre\nsame\nmid\nsame\n"); // untouched
  await fs.rm(dir, { recursive: true, force: true });
});

test("range whose ends disagree on the delta rejects instead of mis-applying", async () => {
  const dir = await tmp();
  const file = path.join(dir, "d.ts");
  // "A" re-maps with delta +3 (line 2→5), but "B" is at line 7, not 6 — the end
  // anchor would NOT match at end+delta, so the range cannot be relocated safely.
  await fs.writeFile(file, "q1\nq2\nq3\nq4\nA\nq6\nB\n");
  const res = await editTool("d.ts", `≔2${lineAnchor("A")}..3${lineAnchor("B")}\nNEW`, dir);
  expect(res.success).toBe(false);
  expect(res.error).toContain("anchor mismatch");
  expect(await fs.readFile(file, "utf-8")).toBe("q1\nq2\nq3\nq4\nA\nq6\nB\n"); // untouched
  await fs.rm(dir, { recursive: true, force: true });
});

test("matching anchors at their line numbers still apply without re-mapping", async () => {
  const dir = await tmp();
  const file = path.join(dir, "e.ts");
  await fs.writeFile(file, "one\ntwo\nthree\n");
  const res = await editTool("e.ts", `≔2${lineAnchor("two")}\nTWO`, dir);
  expect(res.success).toBe(true);
  expect(await fs.readFile(file, "utf-8")).toBe("one\nTWO\nthree\n");
  await fs.rm(dir, { recursive: true, force: true });
});

test("anchors always lead with a letter so ≔1<anchor> never merges into the line number", () => {
  // Pre-fix, ~7.7% of anchors were two digits (e.g. "68"); `≔1`+`68` parsed as
  // line 168 with NO anchor → verification silently skipped. Letter-leading
  // anchors make the `\d+` line number and the anchor unambiguous.
  for (const s of ["dup", "x", "return 0;", "  const y = 2;", "}", "alpha", "θ", "1234"]) {
    expect(lineAnchor(s)).toMatch(/^[a-z][a-z0-9]$/);
  }
});

test("an edit citing a line-1 anchor verifies instead of merging digits", async () => {
  const dir = await tmp();
  const file = path.join(dir, "f.ts");
  await fs.writeFile(file, "dup\nrest\n");
  // ≔1<anchor> on line 1: the anchor leads with a letter, so the parser keeps
  // line=1 and verifies. A stale anchor on line 1 must REJECT, not blind-write.
  const ok = await editTool("f.ts", `≔1${lineAnchor("dup")}\nDUP`, dir);
  expect(ok.success).toBe(true);
  expect(await fs.readFile(file, "utf-8")).toBe("DUP\nrest\n");
  await fs.rm(dir, { recursive: true, force: true });
});
