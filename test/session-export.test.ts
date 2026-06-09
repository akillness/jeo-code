import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createSession, appendMessage, exportSession } from "../src/agent/session";

async function seed(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "joc-export-"));
  const { id } = await createSession(cwd);
  await appendMessage(id, { role: "system", content: "SYSTEM PROMPT" }, cwd);
  await appendMessage(id, { role: "user", content: "do the thing" }, cwd);
  await appendMessage(id, { role: "assistant", content: "done the thing" }, cwd);
  return JSON.stringify({ cwd, id });
}

test("exportSession: markdown includes header + non-system messages by default", async () => {
  const { cwd, id } = JSON.parse(await seed());
  const md = await exportSession(id, "markdown", cwd);
  expect(md).toContain(`# joc session ${id}`);
  expect(md).toContain("- Messages: 2"); // system excluded
  expect(md).toContain("## User");
  expect(md).toContain("do the thing");
  expect(md).toContain("## Assistant");
  expect(md).not.toContain("SYSTEM PROMPT");
});

test("exportSession: includeSystem keeps the system message", async () => {
  const { cwd, id } = JSON.parse(await seed());
  const md = await exportSession(id, "markdown", cwd, { includeSystem: true });
  expect(md).toContain("SYSTEM PROMPT");
  expect(md).toContain("- Messages: 3");
});

test("exportSession: json is structured and parseable", async () => {
  const { cwd, id } = JSON.parse(await seed());
  const json = JSON.parse(await exportSession(id, "json", cwd));
  expect(json.id).toBe(id);
  expect(json.messageCount).toBe(2);
  expect(json.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
});

test("exportSession: tolerates a malformed trailing line", async () => {
  const { cwd, id } = JSON.parse(await seed());
  const file = path.join(cwd, ".joc", "sessions", `${id}.jsonl`);
  await fs.appendFile(file, "{ this is not valid json\n");
  const md = await exportSession(id, "markdown", cwd);
  expect(md).toContain("## Assistant"); // earlier messages still render
});
