import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractJsonObject } from "../src/agent/json";
import { editTool } from "../src/agent/tools";
import { createSession, appendMessage, loadSession, sessionPath } from "../src/agent/session";

// --- json.ts: scan past non-JSON braces (review LOW finding) ---

test("extractJsonObject: skips an earlier non-JSON brace group and finds the later valid object", () => {
  const text = 'I considered { not: json } then decided. {"tool":"done","arguments":{"reason":"ok"}} trailing.';
  expect(extractJsonObject(text)).toEqual({ tool: "done", arguments: { reason: "ok" } });
});

test("extractJsonObject: still throws when no balanced group is valid JSON", () => {
  expect(() => extractJsonObject("{ not json } and { also no }")).toThrow();
});

// --- tools.ts editTool: range validation + whitespace preservation (review MEDIUM finding) ---

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "joc-edit-"));
}

test("editTool: rejects an out-of-bounds line range without writing", async () => {
  const dir = await tmp();
  try {
    await fs.writeFile(path.join(dir, "a.txt"), "l1\nl2\nl3\n", "utf8");
    const res = await editTool("a.txt", "\u22545..6\nX", dir);
    expect(res.success).toBe(false);
    expect(res.error).toContain("out of bounds");
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("l1\nl2\nl3\n");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("editTool: search/replace preserves indentation (no trim)", async () => {
  const dir = await tmp();
  try {
    await fs.writeFile(path.join(dir, "a.ts"), "function f() {\n    return 1;\n}\n", "utf8");
    const editBlock = "<<<<<<< SEARCH\n    return 1;\n=======\n    return 2;\n>>>>>>>";
    const res = await editTool("a.ts", editBlock, dir);
    expect(res.success).toBe(true);
    const out = await fs.readFile(path.join(dir, "a.ts"), "utf8");
    expect(out).toBe("function f() {\n    return 2;\n}\n");
    expect(out).toContain("    return 2;"); // 4-space indent preserved
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("editTool: empty search block is rejected", async () => {
  const dir = await tmp();
  try {
    await fs.writeFile(path.join(dir, "a.txt"), "hello\n", "utf8");
    const res = await editTool("a.txt", "<<<<<<< SEARCH\n\n=======\nX\n>>>>>>>", dir);
    expect(res.success).toBe(false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- session.ts: tolerate a malformed (truncated) tail line (review MEDIUM finding) ---

test("loadSession: tolerates a malformed non-header line and keeps valid messages", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-sess-fix-"));
  try {
    const { id } = await createSession(dir);
    await appendMessage(id, { role: "user", content: "hi" }, dir);
    // Simulate a partial/corrupt append (e.g. crash mid-write).
    await fs.appendFile(sessionPath(id, dir), "{ this is not valid json\n", "utf8");
    await appendMessage(id, { role: "assistant", content: "yo" }, dir);

    const { messages } = await loadSession(id, dir);
    expect(messages.map(m => m.content)).toEqual(["hi", "yo"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
