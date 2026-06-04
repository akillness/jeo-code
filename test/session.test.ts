import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { Message } from "../src/agent/loop";
import {
  createSession,
  appendMessage,
  loadSession,
  listSessions,
  latestSessionId,
  sessionPath,
  sessionsDir,
  newSessionId
} from "../src/agent/session";

test("session lifecycle and logic with custom cwd", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-sess-"));
  try {
    // 1. createSession writes a header
    const id1 = newSessionId();
    const sess1 = await createSession(tempDir, id1);
    expect(sess1.id).toBe(id1);
    expect(sess1.path).toBe(sessionPath(id1, tempDir));
    
    const fileContent = await fs.readFile(sess1.path, "utf8");
    const headerObj = JSON.parse(fileContent.trim());
    expect(headerObj.type).toBe("session");
    expect(headerObj.id).toBe(id1);
    expect(headerObj.version).toBe(1);
    expect(headerObj.cwd).toBe(tempDir);
    expect(headerObj.timestamp).toBeDefined();

    // 2. appendMessage + loadSession round-trips messages in order
    const msg1: Message = { role: "user", content: "Hello world" };
    const msg2: Message = { role: "assistant", content: "Hi there!" };
    await appendMessage(id1, msg1, tempDir);
    await appendMessage(id1, msg2, tempDir);

    const loaded = await loadSession(id1, tempDir);
    expect(loaded.header.id).toBe(id1);
    expect(loaded.messages.length).toBe(2);
    expect(loaded.messages[0]).toEqual(msg1);
    expect(loaded.messages[1]).toEqual(msg2);

    // 3. listSessions returns summaries sorted newest-first with correct messageCount + preview
    // Sleep a tiny bit to guarantee distinct timestamp millisecond if needed,
    // though listSessions uses Date parsing.
    await new Promise(resolve => setTimeout(resolve, 10));
    const id2 = newSessionId();
    const sess2 = await createSession(tempDir, id2);
    const msg3: Message = { role: "user", content: "This is a very long user message that is longer than 60 characters to test preview trimming functionality" };
    await appendMessage(id2, msg3, tempDir);

    const list = await listSessions(tempDir);
    expect(list.length).toBe(2);
    // list is sorted newest-first (descending), so sess2 should be first
    expect(list[0].id).toBe(id2);
    expect(list[0].messageCount).toBe(1);
    expect(list[0].preview).toBe("This is a very long user message that is longer than 60 char");

    expect(list[1].id).toBe(id1);
    expect(list[1].messageCount).toBe(2);
    expect(list[1].preview).toBe("Hello world");

    // 4. latestSessionId returns the newest
    const latest = await latestSessionId(tempDir);
    expect(latest).toBe(id2);

    // 5. loadSession throws on missing id
    let threw = false;
    try {
      await loadSession("non-existent-id", tempDir);
    } catch (err) {
      threw = true;
    }
    expect(threw).toBe(true);

    // 6. malformed line is tolerated by listSessions
    const malformedPath = path.join(sessionsDir(tempDir), "malformed.jsonl");
    await fs.writeFile(malformedPath, "this is not json\n", "utf8");

    const listAfterMalformed = await listSessions(tempDir);
    expect(listAfterMalformed.length).toBe(2);
    expect(listAfterMalformed.map(s => s.id)).toContain(id1);
    expect(listAfterMalformed.map(s => s.id)).toContain(id2);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("session default cwd behavior", async () => {
  const originalCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-sess-cwd-"));
  try {
    process.chdir(tempDir);

    const sess = await createSession();
    expect(sess.path).toBe(sessionPath(sess.id));

    const msg: Message = { role: "user", content: "Default CWD test" };
    await appendMessage(sess.id, msg);

    const loaded = await loadSession(sess.id);
    expect(loaded.messages[0]).toEqual(msg);

    const list = await listSessions();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(sess.id);

    const latest = await latestSessionId();
    expect(latest).toBe(sess.id);
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
