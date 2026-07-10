import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createSession, loadSession, updateSessionDraft } from "../src/agent/session";
import { runSessionSlash } from "../src/commands/launch/session-slash";

// Proves the gajae-code-inspired "unsent prompt survives /resume" feature:
// updateSessionDraft persists/clears the header field, and runSessionSlash's
// `/session resume` path surfaces it back out so the REPL can prefill the box.

test("updateSessionDraft persists a non-empty draft into the session header", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-draft-"));
  try {
    const { id } = await createSession(tempDir);
    await updateSessionDraft(id, "half-typed prom", tempDir);
    const { header } = await loadSession(id, tempDir);
    expect(header.draft).toBe("half-typed prom");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("updateSessionDraft clears a stale draft when given empty/whitespace text", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-draft-"));
  try {
    const { id } = await createSession(tempDir);
    await updateSessionDraft(id, "leftover text", tempDir);
    expect((await loadSession(id, tempDir)).header.draft).toBe("leftover text");

    await updateSessionDraft(id, "   ", tempDir);
    expect((await loadSession(id, tempDir)).header.draft).toBeUndefined();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("updateSessionDraft is a no-op write when the draft already matches", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-draft-"));
  try {
    const { id, path: file } = await createSession(tempDir);
    await updateSessionDraft(id, "same text", tempDir);
    const mtimeAfterFirst = (await fs.stat(file)).mtimeMs;
    await new Promise(r => setTimeout(r, 15));
    await updateSessionDraft(id, "same text", tempDir);
    const mtimeAfterSecond = (await fs.stat(file)).mtimeMs;
    expect(mtimeAfterSecond).toBe(mtimeAfterFirst);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("/session resume surfaces a saved draft in the result for the REPL to prefill", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-draft-"));
  try {
    const { id } = await createSession(tempDir);
    await updateSessionDraft(id, "restore me please", tempDir);

    const result = await runSessionSlash(`/session resume ${id}`, {
      cwd: tempDir,
      history: [{ role: "user", content: "seed" } as any],
      noSession: false,
      sessionId: undefined,
      sessionModel: undefined,
      rl: { history: [] },
      advanceSessionBoxColor: () => {},
      disarmPreview: () => {},
      clearScreen: () => "",
      freshWelcomeLines: () => [],
      logLines: () => {},
      runSelectPicker: async () => {},
    });

    expect(result.sessionId).toBe(id);
    expect(result.draft).toBe("restore me please");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("/session resume omits `draft` from the result when the session had none", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-draft-"));
  try {
    const { id } = await createSession(tempDir);

    const result = await runSessionSlash(`/session resume ${id}`, {
      cwd: tempDir,
      history: [{ role: "user", content: "seed" } as any],
      noSession: false,
      sessionId: undefined,
      sessionModel: undefined,
      rl: { history: [] },
      advanceSessionBoxColor: () => {},
      disarmPreview: () => {},
      clearScreen: () => "",
      freshWelcomeLines: () => [],
      logLines: () => {},
      runSelectPicker: async () => {},
    });

    expect(result.sessionId).toBe(id);
    expect(result.draft).toBeUndefined();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
