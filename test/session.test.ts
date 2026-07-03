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
  newSessionId,
  renameSession,
  updateSessionModel,
  deleteSession,
  resolveSessionRef
} from "../src/agent/session";

test("session lifecycle and logic with custom cwd", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-sess-"));
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-sess-cwd-"));
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

test("session rename and delete lifecycle", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-sess-manage-"));
  try {
    const id = newSessionId();
    const sess = await createSession(tempDir, id);
    const msg: Message = { role: "user", content: "Hello for management" };
    await appendMessage(id, msg, tempDir);

    // Verify initial load has no title
    const initial = await loadSession(id, tempDir);
    expect(initial.header.title).toBeUndefined();

    // Rename session
    await renameSession(id, "My Cool Session", tempDir);

    // Verify load has title and messages are intact
    const loaded = await loadSession(id, tempDir);
    expect(loaded.header.title).toBe("My Cool Session");
    expect(loaded.messages.length).toBe(1);
    expect(loaded.messages[0]).toEqual(msg);

    // Verify listSessions surfaces title
    const list = await listSessions(tempDir);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(id);
    expect(list[0].title).toBe("My Cool Session");
    expect(list[0].preview).toBe("Hello for management");

    // Renaming a missing id rejects
    let threw = false;
    try {
      await renameSession("non-existent-id", "Failed Title", tempDir);
    } catch (err) {
      threw = true;
    }
    expect(threw).toBe(true);

    // Delete session
    const deletedTrue = await deleteSession(id, tempDir);
    expect(deletedTrue).toBe(true);

    // Delete again (missing file) returns false
    const deletedFalse = await deleteSession(id, tempDir);
    expect(deletedFalse).toBe(false);

    // Verify it is gone
    const listEmpty = await listSessions(tempDir);
    expect(listEmpty.length).toBe(0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("session resume with compaction marker and legacy compatibility", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-sess-compat-"));
  const { appendCompaction } = await import("../src/agent/session");

  try {
    const id = newSessionId();
    await createSession(tempDir, id);

    // 1. system prompt + 5 user/assistant messages
    const sysPrompt: Message = { role: "system", content: "You are helpful." };
    const m1: Message = { role: "user", content: "one" };
    const m2: Message = { role: "assistant", content: "two" };
    const m3: Message = { role: "user", content: "three" };
    const m4: Message = { role: "assistant", content: "four" };
    const m5: Message = { role: "user", content: "five" };

    await appendMessage(id, sysPrompt, tempDir); // index 0
    await appendMessage(id, m1, tempDir);        // index 1
    await appendMessage(id, m2, tempDir);        // index 2
    await appendMessage(id, m3, tempDir);        // index 3
    await appendMessage(id, m4, tempDir);        // index 4
    await appendMessage(id, m5, tempDir);        // index 5

    // 2. Append compaction marker.
    // replacesThrough: 3 (system, m1, m2, m3) -> index 0, 1, 2, 3
    await appendCompaction(id, 1, "SUMMARY-MARKER", 3, tempDir);

    // 3. loadSession should return [system, summaryMessage, m4, m5]
    const loaded = await loadSession(id, tempDir);
    expect(loaded.messages.length).toBe(4);
    expect(loaded.messages[0]).toEqual(sysPrompt); // System prompt is preserved
    expect(loaded.messages[1]).toEqual({
      role: "user",
      content: "[Earlier conversation summary]\nSUMMARY-MARKER",
    });
    expect(loaded.messages[2]).toEqual(m4);
    expect(loaded.messages[3]).toEqual(m5);

    // 4. listSessions should show correct messageCount
    const summaries = await listSessions(tempDir);
    expect(summaries.length).toBe(1);
    expect(summaries[0].messageCount).toBe(3); // summaryMessage + m4 + m5 = 3 (since system is not counted in messageCount, or if system is message type, 4)
    // index 0(sys), 1(m1), 2(m2), 3(m3) are replaced. msgIndex for m4 is 4, which is > 3, so m4, m5 are counted (2 messages) plus summaryMessage (1 message) = 3 messages.
    // preview should be first user message ("one")
    expect(summaries[0].preview).toBe("one");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("listSessions uses lightweight parser (avoids full JSON.parse)", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-sess-light-"));
  try {
    const id = newSessionId();
    await createSession(tempDir, id);

    // Append 50 messages
    for (let i = 0; i < 50; i++) {
      await appendMessage(id, { role: "user", content: `message ${i}` }, tempDir);
    }

    // Wrap JSON.parse in a spy
    const originalParse = JSON.parse;
    let parseCalls = 0;
    JSON.parse = (text: string, reviver?: any) => {
      parseCalls++;
      return originalParse(text, reviver);
    };

    try {
      const summaries = await listSessions(tempDir);
      expect(summaries.length).toBe(1);
      expect(summaries[0].messageCount).toBe(50);
      expect(summaries[0].preview).toBe("message 0");
    } finally {
      JSON.parse = originalParse;
    }

    // If we parsed the whole file, it would call JSON.parse at least 51 times (1 header + 50 messages).
    // With lightweight parser, it should only parse the header, look for compaction (none), and first user message.
    // So parseCalls should be exactly 2 (or very low).
    expect(parseCalls).toBeLessThanOrEqual(5);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("per-session model: createSession persists it, loadSession + listSessions restore it", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-sess-model-"));
  try {
    // 1. createSession without a model leaves the header `model` undefined.
    const idA = newSessionId();
    await createSession(tempDir, idA);
    const loadedA = await loadSession(idA, tempDir);
    expect(loadedA.header.model).toBeUndefined();

    // 2. createSession with a model pins it into the header and round-trips.
    const idB = newSessionId();
    await createSession(tempDir, idB, "anthropic/claude-sonnet-4-5");
    const loadedB = await loadSession(idB, tempDir);
    expect(loadedB.header.model).toBe("anthropic/claude-sonnet-4-5");

    // 3. updateSessionModel rewrites the header model in place (no message loss).
    await appendMessage(idB, { role: "user", content: "hi" }, tempDir);
    await updateSessionModel(idB, "openai/gpt-5.5", tempDir);
    const afterUpdate = await loadSession(idB, tempDir);
    expect(afterUpdate.header.model).toBe("openai/gpt-5.5");
    expect(afterUpdate.messages.length).toBe(1);
    expect(afterUpdate.messages[0].content).toBe("hi");

    // 4. updateSessionModel is a no-op when the model is unchanged (file byte-identical).
    const before = await fs.readFile(sessionPath(idB, tempDir), "utf8");
    await updateSessionModel(idB, "openai/gpt-5.5", tempDir);
    const after = await fs.readFile(sessionPath(idB, tempDir), "utf8");
    expect(after).toBe(before);

    // 5. listSessions surfaces the pinned model in its summary.
    const list = await listSessions(tempDir);
    const summaryB = list.find(s => s.id === idB);
    expect(summaryB?.model).toBe("openai/gpt-5.5");

    // 6. updateSessionModel throws a clear error for a missing session.
    let threw = false;
    try {
      await updateSessionModel("does-not-exist", "x", tempDir);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveSessionRef: exact match, unique prefix, ambiguous prefix, not-found, empty string", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-sess-resolve-"));
  try {
    // Two sessions sharing a common prefix, one with a unique-from-the-start id.
    const idShared1 = "abcdef00-0000-0000-0000-000000000001";
    const idShared2 = "abcdef11-0000-0000-0000-000000000002";
    const idUnique = "zzzzzz00-0000-0000-0000-000000000003";
    await createSession(tempDir, idShared1);
    await new Promise(resolve => setTimeout(resolve, 5));
    await createSession(tempDir, idShared2);
    await new Promise(resolve => setTimeout(resolve, 5));
    await createSession(tempDir, idUnique);

    // 1. Exact match wins immediately (fast path), even though it also happens
    //    to be a prefix of idShared2.
    const exact = await resolveSessionRef(idShared1, tempDir);
    expect(exact).toEqual({ kind: "ok", id: idShared1 });

    // 2. Unique prefix match.
    const uniquePrefix = await resolveSessionRef("zzzzzz", tempDir);
    expect(uniquePrefix).toEqual({ kind: "ok", id: idUnique });

    // 3. Ambiguous prefix (2+ sessions share it).
    const ambiguous = await resolveSessionRef("abcdef", tempDir);
    expect(ambiguous.kind).toBe("ambiguous");
    if (ambiguous.kind === "ambiguous") {
      expect(ambiguous.matches.sort()).toEqual([idShared1, idShared2].sort());
    }

    // 4. No match.
    const notFound = await resolveSessionRef("does-not-exist", tempDir);
    expect(notFound).toEqual({ kind: "not-found" });

    // 5. Empty string.
    const empty = await resolveSessionRef("", tempDir);
    expect(empty).toEqual({ kind: "not-found" });
    const whitespaceOnly = await resolveSessionRef("   ", tempDir);
    expect(whitespaceOnly).toEqual({ kind: "not-found" });

    // 6. Case-insensitive prefix match.
    const caseInsensitive = await resolveSessionRef("ZZZZZZ", tempDir);
    expect(caseInsensitive).toEqual({ kind: "ok", id: idUnique });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
