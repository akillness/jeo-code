import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createSession, appendMessage, exportSession } from "../src/agent/session";

async function seed(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-export-"));
  const { id } = await createSession(cwd);
  await appendMessage(id, { role: "system", content: "SYSTEM PROMPT" }, cwd);
  await appendMessage(id, { role: "user", content: "do the thing" }, cwd);
  await appendMessage(id, { role: "assistant", content: "done the thing" }, cwd);
  return JSON.stringify({ cwd, id });
}

test("exportSession: markdown includes header + non-system messages by default", async () => {
  const { cwd, id } = JSON.parse(await seed());
  const md = await exportSession(id, "markdown", cwd);
  expect(md).toContain(`# jeo session ${id}`);
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
  const file = path.join(cwd, ".jeo", "sessions", `${id}.jsonl`);
  await fs.appendFile(file, "{ this is not valid json\n");
  const md = await exportSession(id, "markdown", cwd);
  expect(md).toContain("## Assistant"); // earlier messages still render
});

test("exportSession: markdown fence is longer than backtick runs in the content", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-fence-"));
  const { id } = await createSession(cwd);
  await appendMessage(id, { role: "assistant", content: "see:\n```ts\ncode\n```\nend" }, cwd);
  const md = await exportSession(id, "markdown", cwd);
  // content has a 3-backtick run → the fence must be at least 4 backticks
  expect(md).toContain("````");
});

test("exportSession: assistant reasoning is included in markdown (think → answer) and JSON", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-export-r-"));
  const { id } = await createSession(cwd);
  await appendMessage(cwd ? id : id, { role: "user", content: "q" }, cwd);
  await appendMessage(id, { role: "assistant", content: "the final answer", reasoning: "my reasoning trace" }, cwd);
  const md = await exportSession(id, "markdown", cwd);
  expect(md).toContain("### Thinking");
  expect(md).toContain("my reasoning trace");
  expect(md).toContain("the final answer");
  // thinking precedes the answer
  expect(md.indexOf("my reasoning trace")).toBeLessThan(md.indexOf("the final answer"));
  // JSON export carries reasoning on the message object
  const json = JSON.parse(await exportSession(id, "json", cwd));
  const a = json.messages.find((m: any) => m.role === "assistant");
  expect(a.reasoning).toBe("my reasoning trace");
});
