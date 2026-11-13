import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendMessage, appendMessages, appendParentResponse, appendSubagentEvent, appendSubagentMessage, createSession, loadSession, renameSession, updateSessionDraft, updateSessionModel } from "../src/agent/session";
import { renderSessionTimeline, runSessionSlash, sessionPromptHistory } from "../src/commands/launch/session-slash";
import type { Message } from "../src/agent/loop";
import chalk from "chalk";
import { CompactPasteStore } from "../src/commands/launch/input";

test("subagent history survives reload and resume without presenting unfinished work as completed", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-agent-restore-"));
  const displayed: string[] = [];
  const output = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    displayed.push(args.map(String).join(" "));
  });
  try {
    const session = await createSession(cwd);
    await appendSubagentEvent(session.id, { runId: "complete-run", role: "reviewer", kind: "start", detail: "Review the patch" }, cwd);
    await appendSubagentEvent(session.id, { runId: "complete-run", role: "reviewer", kind: "tool", detail: "read src/app.ts", success: true }, cwd);
    await appendSubagentEvent(session.id, { runId: "complete-run", role: "reviewer", kind: "done", detail: "Patch reviewed", success: true }, cwd);
    await appendSubagentEvent(session.id, { runId: "open-run", role: "tester", kind: "start", detail: "Check recovery" }, cwd);
    await appendSubagentEvent(session.id, { runId: "open-run", role: "tester", kind: "thinking", detail: "transient thought" }, cwd);
    await fs.appendFile(session.path, '{"type":"subagent_event","event":{"kind":42}}\n');

    const loaded = await loadSession(session.id, cwd);
    expect(loaded.subagentEvents.map(event => event.kind)).toEqual(["start", "tool", "done", "start"]);
    expect(loaded.subagentEvents.map(event => event.runId)).toEqual(["complete-run", "complete-run", "complete-run", "open-run"]);
    const history: Message[] = [{ role: "system", content: "system" }];
    await runSessionSlash(`/session resume ${session.id}`, {
      cwd, history, noSession: false, sessionId: undefined, sessionModel: undefined,
      rl: { history: [] }, advanceSessionBoxColor: () => {}, disarmPreview: () => {},
      clearScreen: () => "", freshWelcomeLines: () => [],
      logLines: () => {}, runSelectPicker: async () => {},
    });
    const text = displayed.join("\n").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    expect(text).toContain("Patch reviewed");
    expect(text).toContain("Check recovery");
    expect(text).toMatch(/interrupt|unfinished|incomplete|no completion observed/i);
    expect(text).not.toContain("transient thought");
    expect(text).not.toMatch(/TESTER[^\n]*\bdone\b/i);
  } finally {
    output.mockRestore();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("a late subagent event cannot recreate a deleted session file", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-agent-deleted-"));
  try {
    const session = await createSession(cwd);
    await fs.unlink(session.path);
    await expect(appendSubagentEvent(session.id, {
      runId: "late-run", role: "tester", kind: "done", detail: "late result", success: true,
    }, cwd)).rejects.toThrow();
    expect(await fs.stat(session.path).then(() => true, () => false)).toBe(false);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("concurrent header rewrites preserve appended messages and subagent events", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-agent-write-race-"));
  try {
    const session = await createSession(cwd);
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 30; i++) {
      writes.push(renameSession(session.id, `title-${i}`, cwd));
      writes.push(updateSessionModel(session.id, `model-${i}`, cwd));
      writes.push(updateSessionDraft(session.id, `draft-${i}`, cwd));
      writes.push(appendMessages(session.id, [{ role: "user", content: `message-${i}` }], cwd));
      writes.push(appendSubagentEvent(session.id, { runId: `run-${i}`, role: "tester", kind: "start", detail: `task-${i}` }, cwd));
    }
    await Promise.all(writes);
    const loaded = await loadSession(session.id, cwd);
    expect(loaded.header.title).toBe("title-29");
    expect(loaded.header.model).toBe("model-29");
    expect(loaded.header.draft).toBe("draft-29");
    expect(loaded.messages.map(message => message.content)).toEqual(Array.from({ length: 30 }, (_, i) => `message-${i}`));
    expect(loaded.subagentEvents.map(event => event.detail)).toEqual(Array.from({ length: 30 }, (_, i) => `task-${i}`));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("reload and resume preserve actual conversation and subagent records in file order", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-agent-timeline-"));
  const displayed: string[] = [];
  const output = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    displayed.push(args.map(String).join(" "));
  });
  try {
    const session = await createSession(cwd);
    const start = { runId: "r1", role: "reviewer", kind: "start" as const, detail: "Review task" };
    const childPrompt: Message = { role: "user", content: "Inspect the parser" };
    const childReply: Message = { role: "assistant", content: "Parser finding: preserves order" };
    await appendMessage(session.id, { role: "user", content: "First user prompt" }, cwd);
    await appendSubagentEvent(session.id, start, cwd);
    await appendSubagentMessage(session.id, { runId: "r1", role: "reviewer", message: childPrompt }, cwd);
    await appendSubagentMessage(session.id, { runId: "r1", role: "reviewer", message: childReply }, cwd);
    await appendSubagentEvent(session.id, { runId: "r1", role: "reviewer", kind: "done", detail: "Review complete", success: true }, cwd);
    await appendMessage(session.id, { role: "assistant", content: "First assistant answer" }, cwd);
    for (let i = 0; i < 8; i++) {
      await appendMessages(session.id, [{ role: "user", content: `Later prompt ${i}` }, { role: "assistant", content: `Later answer ${i}` }], cwd);
    }
    const loaded = await loadSession(session.id, cwd);
    expect(loaded.subagentMessages.map(item => item.message)).toEqual([childPrompt, childReply]);
    expect(loaded.timeline.slice(0, 6).map(entry => entry.type)).toEqual([
      "message", "subagent_event", "subagent_message", "subagent_message", "subagent_event", "message",
    ]);
    const history: Message[] = [{ role: "system", content: "system" }];
    await runSessionSlash(`/session resume ${session.id}`, {
      cwd, history, noSession: false, sessionId: undefined, sessionModel: undefined,
      rl: { history: [] }, advanceSessionBoxColor: () => {}, disarmPreview: () => {},
      clearScreen: () => "", freshWelcomeLines: () => [],
      logLines: () => {}, runSelectPicker: async () => {},
    });
    const text = displayed.join("\n").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    const markers = ["First user prompt", "Review task", "Inspect the parser", "Parser finding: preserves order", "Review complete", "First assistant answer", "Later answer 7"];
    let previous = -1;
    for (const marker of markers) {
      const index = text.indexOf(marker);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
  } finally {
    output.mockRestore();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("legacy sessions restore only recorded activity, and late child records cannot recreate deleted files", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-agent-legacy-"));
  try {
    const session = await createSession(cwd);
    await appendSubagentEvent(session.id, { runId: "old", role: "tester", kind: "start", detail: "Legacy activity" }, cwd);
    const loaded = await loadSession(session.id, cwd);
    expect(loaded.subagentMessages).toEqual([]);
    expect(loaded.subagentEvents.map(event => event.detail)).toEqual(["Legacy activity"]);
    await fs.unlink(session.path);
    await expect(appendSubagentMessage(session.id, { runId: "old", role: "tester", message: { role: "assistant", content: "late" } }, cwd)).rejects.toThrow();
    expect(await fs.stat(session.path).then(() => true, () => false)).toBe(false);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("subagent records are isolated across sessions in the same project", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-agent-isolation-"));
  try {
    const first = await createSession(cwd);
    const second = await createSession(cwd);
    await appendSubagentMessage(first.id, { runId: "shared-id", role: "tester", message: { role: "assistant", content: "first private result" } }, cwd);
    await appendSubagentMessage(second.id, { runId: "shared-id", role: "tester", message: { role: "assistant", content: "second private result" } }, cwd);
    const [firstLoaded, secondLoaded] = await Promise.all([loadSession(first.id, cwd), loadSession(second.id, cwd)]);
    expect(firstLoaded.subagentMessages.map(item => item.message.content)).toEqual(["first private result"]);
    expect(secondLoaded.subagentMessages.map(item => item.message.content)).toEqual(["second private result"]);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("oversized subagent messages are explicitly truncated while small records stay intact", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-agent-limit-"));
  try {
    const session = await createSession(cwd);
    const small: Message = { role: "user", content: "small", images: [{ mediaType: "image/png", data: "aGk=" }] };
    const large: Message = { role: "assistant", content: "prefix " + "x".repeat(2 * 1024 * 1024), images: [{ mediaType: "image/png", data: "aGk=" }] };
    await appendSubagentMessage(session.id, { runId: "r", role: "tester", message: small }, cwd);
    await appendSubagentMessage(session.id, { runId: "r", role: "tester", message: large }, cwd);
    const loaded = await loadSession(session.id, cwd);
    expect(loaded.subagentMessages[0]!.message).toEqual(small);
    expect(loaded.subagentMessages[0]!.truncated).toBeUndefined();
    expect(loaded.subagentMessages[1]!.truncated).toBe(true);
    expect(loaded.subagentMessages[1]!.message.content).toBe(large.content.slice(0, 65536));
    expect(loaded.subagentMessages[1]!.message.images).toBeUndefined();
    const entries = loaded.timeline.filter(entry => entry.type === "subagent_message");
    expect(entries[0]!.truncated).toBeUndefined();
    expect(entries[1]!.truncated).toBe(true);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("parent response linkage preserves ordered records without duplicating engine history", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-parent-link-"));
  try {
    const session = await createSession(cwd);
    const request: Message = { role: "user", content: "Review change" };
    const response: Message = { role: "assistant", content: '{"tool":"task","arguments":{"task":"review"}}', toolUse: [{ id: "call_1_0", tool: "task", arguments: { task: "review" } }] };
    const toolResult: Message = { role: "user", content: "Tool [task] result (ok):\nreviewed", toolResults: [{ id: "call_1_0", output: "reviewed", isError: false }] };
    await appendMessage(session.id, request, cwd);
    await appendParentResponse(session.id, "response-1", response, cwd);
    await appendSubagentEvent(session.id, { runId: "r", role: "reviewer", kind: "start", detail: "review" }, cwd);
    const interrupted = await loadSession(session.id, cwd);
    expect(interrupted.messages).toHaveLength(2);
    expect(interrupted.messages[0]).toEqual(request);
    expect(interrupted.messages[1]).toMatchObject({ role: "user" });
    expect(interrupted.messages[1]!.content).toContain("[Interrupted tool execution]");
    expect(interrupted.messages[1]!.content).toContain(response.content);
    expect(interrupted.timeline.map(entry => entry.type)).toEqual(["message", "parent_response", "subagent_event"]);
    await appendMessages(session.id, [response, toolResult], cwd, ["response-1", undefined]);
    const loaded = await loadSession(session.id, cwd);
    expect(loaded.messages).toEqual([request, response, toolResult]);
    expect(loaded.timeline.map(entry => entry.type)).toEqual(["message", "parent_response", "subagent_event", "message", "message"]);
    const [legacy, parent, , linked, result] = loaded.timeline;
    expect(legacy?.type === "message" && legacy.responseId).toBeUndefined();
    expect(parent?.type === "parent_response" && parent.id).toBe("response-1");
    expect(linked?.type === "message" && linked.responseId).toBe("response-1");
    expect(result?.type === "message" && result.responseId).toBeUndefined();
    await fs.unlink(session.path);
    await expect(appendParentResponse(session.id, "late", response, cwd)).rejects.toThrow();
    expect(await fs.stat(session.path).then(() => true, () => false)).toBe(false);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("timeline replay displays linked parent calls once before children and retains orphan responses", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-parent-replay-"));
  try {
    const session = await createSession(cwd);
    const linked: Message = { role: "assistant", content: JSON.stringify({ tool: "task", arguments: { role: "reviewer", task: "inspect" } }) };
    const orphan: Message = { role: "assistant", content: JSON.stringify({ tool: "task", arguments: { role: "tester", task: "test" } }) };
    await appendMessage(session.id, { role: "user", content: "Perform both tasks" }, cwd);
    await appendParentResponse(session.id, "linked", linked, cwd);
    await appendSubagentEvent(session.id, { runId: "review", role: "reviewer", kind: "start", detail: "Review started" }, cwd);
    await appendSubagentMessage(session.id, { runId: "review", role: "reviewer", message: { role: "assistant", content: "Reviewer finding" } }, cwd);
    await appendMessages(session.id, [linked], cwd, ["linked"]);
    await appendParentResponse(session.id, "orphan", orphan, cwd);
    await appendSubagentEvent(session.id, { runId: "test", role: "tester", kind: "start", detail: "Testing started" }, cwd);
    await appendSubagentMessage(session.id, { runId: "test", role: "tester", message: { role: "assistant", content: "truncated child " + "x".repeat(2 * 1024 * 1024) } }, cwd);
    const text = renderSessionTimeline((await loadSession(session.id, cwd)).timeline).join("\n");
    const markers = ["Perform both tasks", "Task: reviewer", "Review started", "Reviewer finding", "Task: tester", "Testing started", "truncated child", "stored message truncated"];
    let previous = -1;
    for (const marker of markers) {
      const index = text.indexOf(marker);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
    expect(text.split("Task: reviewer").length - 1).toBe(1);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("replay marks an interrupted tool call as unknown rather than successful", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-tool-outcomes-"));
  try {
    const session = await createSession(cwd);
    const call = (filePath: string): Message => ({ role: "assistant", content: JSON.stringify({ tool: "read", arguments: { filePath } }) });
    await appendMessage(session.id, { role: "user", content: "Read the files" }, cwd);
    await appendMessages(session.id, [call("ok.txt"), { role: "user", content: "Tool [read] result (ok):\ncontents" }], cwd);
    await appendMessages(session.id, [call("bad.txt"), { role: "user", content: "Tool [read] result (fail):\nnot found" }], cwd);
    await appendParentResponse(session.id, "interrupted", call("pending.txt"), cwd);
    const lines = renderSessionTimeline((await loadSession(session.id, cwd)).timeline);
    expect(lines.find(line => line.includes("Read ok.txt"))).toContain("✔");
    expect(lines.find(line => line.includes("Read bad.txt"))).toContain("✗");
    const pending = lines.find(line => line.includes("Read pending.txt"));
    expect(pending).toContain("…");
    expect(pending).toContain("(no result recorded)");
    expect(pending).not.toContain("✔");
    expect(pending).not.toContain("✗");
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("session timeline replay sanitizes tool paths and results while retaining colors", () => {
  const previousLevel = chalk.level;
  chalk.level = 1;
  try {
    const osc = "\x1b]52;c;Y2xpcGJvYXJk\x07";
    const cursor = "\x1b[2J";
    const messages: Message[] = [
      { role: "user", content: "Read the file" },
      { role: "assistant", content: JSON.stringify({ tool: "read", arguments: { filePath: `safe${osc}${cursor}name.txt` } }) },
      { role: "user", content: `Tool [read] result (ok):\nresult ${osc}${cursor}preserved` },
    ];
    const timeline = messages.map(message => ({ type: "message" as const, timestamp: "2026-01-01T00:00:00Z", message }));
    const output = renderSessionTimeline(timeline, true).join("\n");
    expect(output).toMatch(/\x1b\[[0-9;]*m/);
    const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("safename.txt");
    expect(plain).toContain("result preserved");
    expect(plain).not.toContain("Y2xpcGJvYXJk");
    expect(plain).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  } finally {
    chalk.level = previousLevel;
  }
});

test("sessionPromptHistory filters protocol frames before compacting genuine prompts", () => {
  const first = "private first\r\n한🙂";
  const last = "private second\t$&";
  const messages: Message[] = [
    { role: "system", content: "system-private" },
    { role: "user", content: first },
    { role: "assistant", content: "assistant-private" },
    ...["Tool [read] result (ok):\nprivate result", "[mid-turn steering] hidden", "[Earlier conversation summary] hidden", "[Interrupted tool execution] hidden", "Your last reply was invalid", "The step budget for this turn is exhausted", "You are cycling through the same request"].map(content => ({ role: "user" as const, content })),
    { role: "user", content: last },
  ];
  const store = new CompactPasteStore();
  const compact = sessionPromptHistory(messages, message => store.store(message.content));
  expect(compact).toEqual(["[Paste #2, 1 lines, 18 cols]", "[Paste #1, 2 lines, 13 cols]"]);
  expect(compact.map(text => store.expand(text))).toEqual([last, first]);
  expect(sessionPromptHistory(messages)).toEqual([last, first]);
});

test("session resume restores compact editable history while retry and model history retain canonical prompts", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-compact-resume-"));
  try {
    const session = await createSession(cwd);
    const sourceStore = new CompactPasteStore();
    const display = `before ${sourceStore.store("private resume body\r\n한🙂\t$&")} after`;
    const content = sourceStore.expand(display);
    await appendMessages(session.id, [
      { role: "user", content, inputDisplay: sourceStore.snapshot(display, content) },
      { role: "assistant", content: JSON.stringify({ tool: "read", arguments: { path: "report.txt" } }) },
      { role: "user", content: "Tool [read] result (ok):\nprivate feedback" },
      { role: "assistant", content: "saved answer" },
    ], cwd);
    const history: Message[] = [{ role: "system", content: "system" }];
    const rl = { history: [] as string[] };
    const store = new CompactPasteStore();
    store.store("unrelated draft");
    const result = await runSessionSlash(`/session resume ${session.id}`, {
      cwd, history, noSession: false, sessionId: undefined, sessionModel: undefined, rl,
      advanceSessionBoxColor: () => {}, disarmPreview: () => {}, clearScreen: () => "", freshWelcomeLines: () => [],
      logLines: () => {}, runSelectPicker: async () => {}, promptHistoryText: message => store.restore(message),
    });
    expect(rl.history).toEqual(["before [Paste #2, 2 lines, 19 cols] after"]);
    expect(store.expand(rl.history[0]!)).toBe(content);
    expect(result.lastUserInput).toBe(content);
    expect(result.lastReply).toBe("saved answer");
    expect(history.filter(message => message.role === "user").map(message => message.content)).toEqual([content, "Tool [read] result (ok):\nprivate feedback"]);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
