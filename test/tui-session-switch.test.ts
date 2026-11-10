import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendMessages, createSession, updateSessionDraft } from "../src/agent/session";
import { runSessionSlash, sessionSwitchBlocked } from "../src/commands/launch/session-slash";
import type { Message } from "../src/agent/loop";

test("resuming another session replaces transcript, retry state and prompt history", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-session-switch-"));
  try {
    const first = await createSession(cwd);
    const second = await createSession(cwd);
    await appendMessages(first.id, [
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
    ], cwd);
    await appendMessages(second.id, [
      { role: "user", content: "second prompt" },
      { role: "assistant", content: "second answer" },
    ], cwd);
    await updateSessionDraft(second.id, "second draft", cwd);
    const history: Message[] = [{ role: "system", content: "system" }];
    const rl = { history: [] as string[] };
    const displayed: string[] = [];
    const context = {
      cwd, history, rl, noSession: false, sessionId: undefined, sessionModel: undefined,
      advanceSessionBoxColor: () => {}, disarmPreview: () => {}, clearScreen: () => "",
      freshWelcomeLines: () => [], logLines: (lines: string[]) => displayed.push(...lines),
      runSelectPicker: async () => {},
    };
    await runSessionSlash(`/session resume ${first.id}`, context);
    expect(rl.history).toContain("first prompt");
    displayed.length = 0;
    const result = await runSessionSlash(`/session resume ${second.id}`, { ...context, sessionId: first.id });
    expect(result.sessionId).toBe(second.id);
    expect(result.lastUserInput).toBe("second prompt");
    expect(result.lastReply).toBe("second answer");
    expect(result.draft).toBe("second draft");
    expect(history.map(message => message.content)).toEqual(["system", "second prompt", "second answer"]);
    expect(rl.history).toEqual(["second prompt"]);
    expect(displayed.join("\n")).toContain("second answer");
    expect(displayed.join("\n")).not.toContain("first answer");
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("switching to an empty session clears model, draft, retry and readline state", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-session-empty-switch-"));
  try {
    const first = await createSession(cwd, undefined, "model-first");
    const empty = await createSession(cwd);
    await appendMessages(first.id, [{ role: "user", content: "old prompt" }, { role: "assistant", content: "old reply" }], cwd);
    await updateSessionDraft(first.id, "old draft", cwd);
    const history: Message[] = [{ role: "system", content: "system" }];
    const rl = { history: [] as string[] };
    const displayed: string[] = [];
    const context = {
      cwd, history, rl, noSession: false, sessionId: undefined, sessionModel: undefined,
      advanceSessionBoxColor: () => {}, disarmPreview: () => {}, clearScreen: () => "",
      freshWelcomeLines: () => [], logLines: (lines: string[]) => displayed.push(...lines),
      runSelectPicker: async () => {},
    };
    const firstResult = await runSessionSlash(`/session resume ${first.id}`, context);
    expect(firstResult.sessionModel).toBe("model-first");
    const result = await runSessionSlash(`/session resume ${empty.id}`, { ...context, sessionId: first.id, sessionModel: firstResult.sessionModel });
    expect(result.sessionId).toBe(empty.id);
    expect(Object.hasOwn(result, "sessionModel")).toBe(true);
    expect(result.sessionModel).toBeNull();
    expect(result.draft).toBe("");
    expect(result.lastUserInput).toBe("");
    expect(result.lastReply).toBe("");
    expect(history.map(message => message.content)).toEqual(["system"]);
    expect(rl.history).toEqual([]);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("failed resume leaves the current session and its conversation untouched", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-session-failed-switch-"));
  try {
    const current = await createSession(cwd, undefined, "current-model");
    const history: Message[] = [{ role: "system", content: "system" }, { role: "user", content: "keep me" }];
    const rl = { history: ["keep me"] };
    const result = await runSessionSlash("/session resume missing-session", {
      cwd, history, rl, noSession: false, sessionId: current.id, sessionModel: "current-model",
      advanceSessionBoxColor: () => {}, disarmPreview: () => {}, clearScreen: () => "",
      freshWelcomeLines: () => [], logLines: () => {}, runSelectPicker: async () => {},
    });
    expect(result.sessionId).toBe(current.id);
    expect(Object.hasOwn(result, "sessionModel")).toBe(false);
    expect(Object.hasOwn(result, "draft")).toBe(false);
    expect(history.map(message => message.content)).toEqual(["system", "keep me"]);
    expect(rl.history).toEqual(["keep me"]);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("a corrupt session header cannot replace an active session", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-session-corrupt-switch-"));
  try {
    const current = await createSession(cwd, undefined, "current-model");
    const corrupt = await createSession(cwd);
    await fs.writeFile(corrupt.path, "{broken json\n");
    const history: Message[] = [{ role: "system", content: "system" }, { role: "user", content: "keep prompt" }];
    const rl = { history: ["keep prompt"] };
    const result = await runSessionSlash(`/session resume ${corrupt.id}`, {
      cwd, history, rl, noSession: false, sessionId: current.id, sessionModel: "current-model",
      advanceSessionBoxColor: () => {}, disarmPreview: () => {}, clearScreen: () => "",
      freshWelcomeLines: () => [], logLines: () => {}, runSelectPicker: async () => {},
    });
    expect(result.sessionId).toBe(current.id);
    expect(Object.hasOwn(result, "sessionModel")).toBe(false);
    expect(Object.hasOwn(result, "draft")).toBe(false);
    expect(history.map(message => message.content)).toEqual(["system", "keep prompt"]);
    expect(rl.history).toEqual(["keep prompt"]);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("session switches are blocked for each pending input source but unrelated commands remain available", () => {
  const empty = { images: 0, lines: 0, pastedLines: 0, commands: 0, partial: "", pasteActive: false };
  const pendingStates = [
    { ...empty, images: 1 }, { ...empty, lines: 1 }, { ...empty, pastedLines: 1 },
    { ...empty, commands: 1 }, { ...empty, partial: "unfinished" }, { ...empty, pasteActive: true },
  ];
  for (const command of ["/session resume abc", "/session new", "/session drop", "/session delete"]) {
    expect(sessionSwitchBlocked(command, empty)).toBe(false);
    for (const pending of pendingStates) expect(sessionSwitchBlocked(command, pending)).toBe(true);
  }
  for (const command of ["/session list", "/session info", "/session rename title", "/help"]) {
    expect(sessionSwitchBlocked(command, pendingStates[0]!)).toBe(false);
  }
});

test("new and drop retain active session if input arrives during asynchronous session creation", async () => {
  for (const command of ["/session new", "/session drop"]) {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-session-race-"));
    try {
      const current = await createSession(cwd, undefined, "current-model");
      const history: Message[] = [{ role: "system", content: "system" }, { role: "user", content: "keep prompt" }];
      const rl = { history: ["keep prompt"] };
      let checks = 0;
      let commits = 0;
      const result = await runSessionSlash(command, {
        cwd, history, rl, noSession: false, sessionId: current.id, sessionModel: "current-model",
        canSwitchSession: () => ++checks === 1,
        onSessionCommitted: () => { commits++; },
        advanceSessionBoxColor: () => {}, disarmPreview: () => {}, clearScreen: () => "",
        freshWelcomeLines: () => [], logLines: () => {}, runSelectPicker: async () => {},
      });
      expect(checks).toBeGreaterThanOrEqual(2);
      expect(commits).toBe(0);
      expect(result.sessionId).toBe(current.id);
      expect(Object.hasOwn(result, "draft")).toBe(false);
      expect(history.map(message => message.content)).toEqual(["system", "keep prompt"]);
      expect(rl.history).toEqual(["keep prompt"]);
      expect(await fs.stat(current.path).then(() => true, () => false)).toBe(true);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }
});

test("drop commits the new session and cleared draft before deleting the old session", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-session-commit-"));
  try {
    const current = await createSession(cwd);
    const history: Message[] = [{ role: "system", content: "system" }, { role: "user", content: "old prompt" }];
    let commit: { id: string | undefined; draft: string; oldStillExists: boolean; history: string[] } | undefined;
    const result = await runSessionSlash("/session drop", {
      cwd, history, noSession: false, sessionId: current.id, sessionModel: undefined,
      rl: { history: ["old prompt"] }, canSwitchSession: () => true,
      onSessionCommitted: (id, draft) => {
        commit = { id, draft, oldStillExists: existsSync(current.path), history: history.map(message => message.content) };
      },
      advanceSessionBoxColor: () => {}, disarmPreview: () => {}, clearScreen: () => "",
      freshWelcomeLines: () => [], logLines: () => {}, runSelectPicker: async () => {},
    });
    expect(commit).toEqual({ id: result.sessionId, draft: "", oldStillExists: true, history: ["system"] });
    expect(result.sessionId).toBeDefined();
    expect(result.sessionId).not.toBe(current.id);
    expect(existsSync(current.path)).toBe(false);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
