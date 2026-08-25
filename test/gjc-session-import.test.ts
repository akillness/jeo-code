import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { loadSession, listSessions, sessionPath } from "../src/agent/session";
import {
  importGjcSession,
  listGjcSessions,
  resolveGjcSessionRef,
  resolveGjcCodingAgentRoots,
} from "../src/agent/gjc-session-import";

function linesFromRecords(records: Record<string, unknown>[]): string {
  return records.map(record => JSON.stringify(record)).join("\n") + "\n";
}

async function writeSourceSession(root: string, sessionId: string, records: Record<string, unknown>[]) {
  await fs.mkdir(root, { recursive: true });
  const sourcePath = path.join(root, `${sessionId}.jsonl`);
  await fs.writeFile(sourcePath, linesFromRecords(records), "utf8");
  return sourcePath;
}

function sourceLineage(sessionId: string, cwd = "/src") {
  return {
    type: "session",
    version: 5,
    id: sessionId,
    cwd,
  } as Record<string, unknown>;
}

function withTempDir(prefix: string, run: (dir: string) => Promise<void>) {
  return (async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    try {
      await run(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  })();
}

test("resolve roots and cwd filtering", async () => {
  await withTempDir("gjc-root-", async root => {
    const rootA = path.join(root, "a");
    const rootB = path.join(root, "b");

    await writeSourceSession(rootA, "match-session", [
      sourceLineage("match-session", "/workspace/match"),
      { type: "entry", id: "m1", role: "developer", content: "one" },
    ]);
    await writeSourceSession(rootB, "other-session", [
      sourceLineage("other-session", "/workspace/other"),
      { type: "entry", id: "o1", role: "developer", content: "two" },
    ]);

    const matchCwd = await listGjcSessions({
      roots: [rootA, rootB],
      cwd: "/workspace/match",
      anyCwd: false,
    });
    expect(matchCwd.map(item => item.sessionId)).toEqual(["match-session"]);

    const otherCwd = await listGjcSessions({
      roots: [rootA, rootB],
      cwd: "/workspace/other",
      anyCwd: false,
    });
    expect(otherCwd.map(item => item.sessionId)).toEqual(["other-session"]);

    const any = await listGjcSessions({ roots: [rootA, rootB], anyCwd: true });
    expect(any).toHaveLength(2);

    const envRoots = resolveGjcCodingAgentRoots({
      env: {
        HOME: "/tmp/home-does-not-matter",
        GJC_CONFIG_DIR: ".gjc-session-root",
      },
    });
    expect(envRoots).toContain(path.join("/tmp/home-does-not-matter", ".gjc-session-root", "agent", "sessions"));

    const explicitFirst = resolveGjcCodingAgentRoots({
      roots: [
        "/explicit/one",
        "/explicit/two",
      ],
      env: {
        GJC_CODING_AGENT_DIR: "/fallback/from-env",
      },
    });
    expect(explicitFirst).toEqual([path.resolve("/explicit/one"), path.resolve("/explicit/two")]);

    const piFirst = resolveGjcCodingAgentRoots({
      env: {
        PI_CODING_AGENT_DIR: "/pi-agent",
      },
    });
    expect(piFirst).toEqual([path.resolve("/pi-agent", "sessions")]);
  });
});

test("resolve session and leaf ids by exact/prefix", async () => {
  await withTempDir("gjc-resolve-", async root => {
    await writeSourceSession(root, "abc-developer", [
      sourceLineage("abc-developer", "/x"),
      { type: "entry", id: "s1", role: "developer", content: "sys" },
      { type: "entry", id: "u1", parent: "s1", role: "user", content: "first" },
      { type: "entry", id: "u2", parent: "u1", role: "user", content: "second", },
    ]);
    await writeSourceSession(root, "abc-other", [
      sourceLineage("abc-other", "/x"),
      { type: "entry", id: "s2", role: "developer", content: "sys" },
      { type: "entry", id: "a2", parent: "s2", role: "assistant", content: "ok" },
    ]);
    await writeSourceSession(root, "abc-developer-alt", [
      sourceLineage("abc-developer-alt", "/x"),
      { type: "entry", id: "s3", role: "developer", content: "sys" },
      { type: "entry", id: "a3", parent: "s3", role: "assistant", content: "alt" },
    ]);

    const byPrefix = await resolveGjcSessionRef("abc-", undefined, { roots: [root], anyCwd: true });
    expect(byPrefix.kind).toBe("ambiguous-session");

    const exact = await resolveGjcSessionRef("abc-developer", undefined, { roots: [root], anyCwd: true });
    expect(exact).toEqual({ kind: "ok", match: expect.objectContaining({ sessionId: "abc-developer" }) });

    const exactPreferred = await resolveGjcSessionRef("abc-developer", undefined, { roots: [root], anyCwd: true });
    expect(exactPreferred).toEqual({ kind: "ok", match: expect.objectContaining({ sessionId: "abc-developer" }) });
    await writeSourceSession(root, "leaf-prefix-session", [
      sourceLineage("leaf-prefix-session", "/x"),
      { type: "entry", id: "s1", role: "developer", content: "sys" },
      { type: "entry", id: "leaf-abc", parent: "s1", role: "user", content: "leaf" },
    ]);
    const byLeafPrefix = await resolveGjcSessionRef("leaf-prefix-session", "leaf-a", {
      roots: [root],
      anyCwd: true,
    });
    expect(byLeafPrefix).toEqual({
      kind: "ok",
      match: expect.objectContaining({ sessionId: "leaf-prefix-session", leafId: "leaf-abc" }),
    });

    await writeSourceSession(root, "leaf-prefix-ambiguous", [
      sourceLineage("leaf-prefix-ambiguous", "/x"),
      { type: "entry", id: "t1", role: "developer", content: "sys" },
      { type: "entry", id: "leaf-a1", parent: "t1", role: "user", content: "one" },
      { type: "entry", id: "leaf-a2", parent: "t1", role: "user", content: "two" },
    ]);
    const ambiguousLeaf = await resolveGjcSessionRef("leaf-prefix-ambiguous", "leaf", { roots: [root], anyCwd: true });
    expect(ambiguousLeaf.kind).toBe("ambiguous-leaf");
  });
});

test("import maps linear text entries and developer role to system", async () => {
  await withTempDir("gjc-import-linear-", async root => {
    const sourceCwd = "/src/linear";
    const targetCwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-target-"));
    try {
      await writeSourceSession(root, "linear-session", [
        sourceLineage("linear-session", sourceCwd),
        { type: "entry", id: "s1", role: "developer", content: "System prompt" },
        { type: "entry", id: "u1", parent: "s1", role: "user", content: "Hello" },
        { type: "entry", id: "a1", parent: "u1", role: "assistant", content: "Reply" },
      ]);

      const result = await importGjcSession({
        sessionId: "linear-session",
        roots: [root],
        cwd: targetCwd,
      });

      const imported = await loadSession(result.sessionId, targetCwd);
      expect(imported.messages).toEqual([
        { role: "system", content: "System prompt" },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Reply" },
      ]);
      expect(imported.header.sourceSystem).toBe("gjc");
      expect(imported.header.sourceLeafId).toBe("a1");
    } finally {
      await fs.rm(targetCwd, { recursive: true, force: true });
    }
  });
});
test("imports the upstream nested GJC v5 message entry shape", async () => {
  await withTempDir("gjc-import-v5-nested-", async root => {
    const targetCwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-target-"));
    const timestamp = 1_735_000_000_000;
    try {
      await writeSourceSession(root, "nested-session", [
        { ...sourceLineage("nested-session", "/src/nested"), title: "Nested source" },
        {
          type: "message",
          id: "s1",
          parentId: null,
          timestamp,
          message: { role: "developer", content: "system", timestamp },
        },
        {
          type: "message",
          id: "u1",
          parentId: "s1",
          timestamp,
          message: { role: "user", content: [{ type: "text", text: "run it" }], timestamp },
        },
        {
          type: "message",
          id: "a1",
          parentId: "u1",
          timestamp,
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "considering" },
              { type: "text", text: "running" },
              { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "printf ok" } },
            ],
            timestamp,
          },
        },
        {
          type: "message",
          id: "r1",
          parentId: "a1",
          timestamp,
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "bash",
            content: [{ type: "text", text: "ok" }],
            isError: false,
            timestamp,
          },
        },
      ]);

      const result = await importGjcSession({
        sessionId: "nested-session",
        roots: [root],
        cwd: targetCwd,
      });
      const imported = await loadSession(result.sessionId, targetCwd);
      expect(imported.header.title).toBe("Nested source");
      expect(imported.messages).toEqual([
        { role: "system", content: "system" },
        { role: "user", content: "run it" },
        {
          role: "assistant",
          content: "running",
          reasoning: "considering",
          toolUse: [{ id: "call-1", tool: "bash", arguments: { command: "printf ok" } }],
        },
        {
          role: "user",
          content: "ok",
          toolResults: [{ id: "call-1", output: "ok", isError: false }],
        },
      ]);
    } finally {
      await fs.rm(targetCwd, { recursive: true, force: true });
    }
  });
});

test("import preserves ordered tool calls and contiguous tool results with text and images", async () => {
  await withTempDir("gjc-toolchain-", async root => {
    const targetCwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-target-"));
    try {
      await writeSourceSession(root, "tool-session", [
        sourceLineage("tool-session", "/src/tool"),
        { type: "entry", id: "s1", role: "developer", content: "You are assistant" },
        { type: "entry", id: "u1", parent: "s1", role: "user", content: "run it" },
        {
          type: "entry",
          id: "a1",
          parent: "u1",
          role: "assistant",
          blocks: [
            { type: "text", text: "I will run one command" },
            {
              type: "toolCall",
              id: "call-a",
              name: "bash",
              arguments: { command: "echo hi" },
            },
          ],
        },
        {
          type: "entry",
          id: "r1",
          parent: "a1",
          role: "toolResult",
          blocks: [
            { type: "text", text: "result-body" },
            { type: "image", mediaType: "image/png", data: "aW1hZ2VEYXRh" },
            {
              type: "toolResult",
              id: "call-a",
              output: "tool output",
              isError: false,
            },
          ],
        },
      ]);

      const result = await importGjcSession({
        sessionId: "tool-session",
        roots: [root],
        cwd: targetCwd,
      });

      const imported = await loadSession(result.sessionId, targetCwd);
      expect(imported.messages).toEqual([
        { role: "system", content: "You are assistant" },
        { role: "user", content: "run it" },
        {
          role: "assistant",
          content: "I will run one command",
          toolUse: [{ id: "call-a", tool: "bash", arguments: { command: "echo hi" } }],
        },
        {
          role: "user",
          content: "result-body",
          images: [{ mediaType: "image/png", data: "aW1hZ2VEYXRh" }],
          toolResults: [{ id: "call-a", output: "tool output", isError: false }],
        },
      ]);
    } finally {
      await fs.rm(targetCwd, { recursive: true, force: true });
    }
  });
});

test("import selects leaves, honors headers and reuses by source hash/session/leaf provenance", async () => {
  await withTempDir("gjc-leaf-reuse-", async root => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-target-"));
    try {
      const sourcePath = await writeSourceSession(root, "leaf-session", [
        sourceLineage("leaf-session", "/src/leaf"),
        { type: "entry", id: "s1", role: "developer", content: "start" },
        { type: "entry", id: "leaf-a", parent: "s1", role: "user", content: "A branch" },
        { type: "entry", id: "leaf-b", parent: "s1", role: "user", content: "B branch" },
      ]);
      const bytes = await fs.readFile(sourcePath);
      const sourceSha = createHash("sha256").update(bytes).digest("hex");

      const a1 = await importGjcSession({
        sessionId: "leaf-session",
        leafId: "leaf-a",
        roots: [root],
        cwd: target,
      });
      const a2 = await importGjcSession({
        sessionId: "leaf-session",
        leafId: "leaf-a",
        roots: [root],
        cwd: target,
      });

      expect(a1.reused).toBe(false);
      expect(a2.reused).toBe(true);
      expect(a2.sessionId).toBe(a1.sessionId);

      const b = await importGjcSession({
        sessionId: "leaf-session",
        leafId: "leaf-b",
        roots: [root],
        cwd: target,
      });

      expect(b.reused).toBe(false);
      expect(b.sessionId).not.toBe(a1.sessionId);

      const imported = await loadSession(a2.sessionId, target);
      expect(imported.header.sourceSha256).toBe(sourceSha);
      expect(imported.header.sourceSessionId).toBe("leaf-session");
      expect(imported.header.sourceLeafId).toBe("leaf-a");
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
  });
});

test("header_patch and entry_patch are applied", async () => {
  await withTempDir("gjc-patch-", async root => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-target-"));
    try {
      await writeSourceSession(root, "patch-session", [
        sourceLineage("patch-session", "/src/patch"),
        { type: "entry", id: "s1", role: "developer", content: "initial" },
        { type: "entry", id: "leaf-one", parent: "s1", role: "assistant", content: "A" },
        { type: "entry", id: "leaf-two", parent: "s1", role: "user", content: "B" },
        {
          type: "header_patch",
          patch: [{ op: "replace", path: "/selectedLeafId", value: "leaf-two" }],
        },
        {
          type: "entry_patch",
          entry: "leaf-two",
          patch: [{ op: "replace", path: "/content", value: "patched content" }],
        },
      ]);

      const result = await importGjcSession({
        sessionId: "patch-session",
        roots: [root],
        cwd: target,
      });

      const imported = await loadSession(result.sessionId, target);
      expect(imported.messages).toEqual([
        { role: "system", content: "initial" },
        { role: "user", content: "patched content" },
      ]);
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
  });
});

test("compaction maps selected-chain index and rejects non-first system boundary", async () => {
  await withTempDir("gjc-compaction-", async root => {
    const goodTarget = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-target-"));
    try {
      await writeSourceSession(root, "comp-session", [
        sourceLineage("comp-session", "/src/comp"),
        { type: "entry", id: "s1", role: "developer", content: "system prompt" },
        { type: "entry", id: "u1", parent: "s1", role: "user", content: "one" },
        { type: "entry", id: "a1", parent: "u1", role: "assistant", content: "two" },
        { type: "entry", id: "u2", parent: "a1", role: "user", content: "three" },
        {
          type: "compaction",
          firstKeptEntryId: "u2",
          summary: "imported summary",
        },
      ]);

      const imported = await importGjcSession({
        sessionId: "comp-session",
        roots: [root],
        cwd: goodTarget,
      });
      const sessionFile = sessionPath(imported.sessionId, goodTarget);
      const lines = (await fs.readFile(sessionFile, "utf8")).trim().split("\n");
      const compactionLine = JSON.parse(lines[lines.length - 1]!);
      expect(compactionLine.replacesThrough).toBe(2);
      expect(compactionLine.summary).toBe("imported summary");
    } finally {
      await fs.rm(goodTarget, { recursive: true, force: true });
    }

    const badTarget = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-target-"));
    try {
      await writeSourceSession(root, "comp-session-bad", [
        sourceLineage("comp-session-bad", "/src/comp"),
        { type: "entry", id: "u1", role: "user", content: "start" },
        { type: "entry", id: "a1", parent: "u1", role: "assistant", content: "do" },
        { type: "entry", id: "d1", parent: "a1", role: "developer", content: "late system" },
        {
          type: "compaction",
          firstKeptEntryId: "d1",
          summary: "bad",
        },
      ]);

      await expect(
        importGjcSession({
          sessionId: "comp-session-bad",
          roots: [root],
          cwd: badTarget,
        }),
      ).rejects.toThrow(/non-first system/);
    } finally {
      await fs.rm(badTarget, { recursive: true, force: true });
    }
  });
});

test("multiple compaction markers resolve to the last applicable one", async () => {
  await withTempDir("gjc-compaction-multi-", async root => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-target-"));
    try {
      await writeSourceSession(root, "comp-session-multi", [
        sourceLineage("comp-session-multi", "/src/comp"),
        { type: "entry", id: "s1", role: "developer", content: "system" },
        { type: "entry", id: "u1", parent: "s1", role: "user", content: "one" },
        { type: "entry", id: "a1", parent: "u1", role: "assistant", content: "two" },
        { type: "entry", id: "u2", parent: "a1", role: "user", content: "three" },
        {
          type: "compaction",
          firstKeptEntryId: "u2",
          summary: "earliest",
        },
        {
          type: "compaction",
          firstKeptEntryId: "a1",
          summary: "latest",
        },
      ]);

      const imported = await importGjcSession({
        sessionId: "comp-session-multi",
        roots: [root],
        cwd: target,
      });

      const sessionFile = sessionPath(imported.sessionId, target);
      const lines = (await fs.readFile(sessionFile, "utf8")).trim().split("\n");
      const compactionLine = JSON.parse(lines[lines.length - 1]!);
      expect(compactionLine.replacesThrough).toBe(1);
      expect(compactionLine.summary).toBe("latest");
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
  });
});
test("model_change defaults and omission resolve imported header.model", async () => {
  await withTempDir("gjc-model-", async root => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-target-"));
    try {
      await writeSourceSession(root, "model-session", [
        sourceLineage("model-session", "/src/model"),
        { type: "entry", id: "s1", role: "developer", content: "system" },
        { type: "model_change", id: "m1", role: "default", model: "a", parent: "s1" },
        { type: "entry", id: "u1", parent: "m1", role: "user", content: "q1" },
        { type: "model_change", id: "m2", role: "default", model: "b", parent: "u1" },
        { type: "entry", id: "u2", parent: "m2", role: "user", content: "q2" },
        { type: "model_change", id: "m3", role: "omitted", parent: "u2" },
        { type: "entry", id: "u3", parent: "m3", role: "user", content: "q3" },
      ]);

      const imported = await importGjcSession({
        sessionId: "model-session",
        roots: [root],
        cwd: target,
      });

      const loaded = await loadSession(imported.sessionId, target);
      expect(loaded.header.model).toBeUndefined();
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
  });
});

test("tool result correlation rejects orphan/duplicate/noncontiguous/unknown", async () => {
  await withTempDir("gjc-corr-", async root => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-target-"));
    try {
      await writeSourceSession(root, "orphan", [
        sourceLineage("orphan", "/src/tool"),
        { type: "entry", id: "s1", role: "developer", content: "system" },
        {
          type: "entry",
          id: "r1",
          parent: "s1",
          role: "toolResult",
          blocks: [{ type: "toolResult", id: "x", output: "out", isError: false }],
        },
      ]);
      await expect(
        importGjcSession({ sessionId: "orphan", roots: [root], cwd: target }),
      ).rejects.toThrow(/orphan toolResult/);

      await writeSourceSession(root, "duplicate", [
        sourceLineage("duplicate", "/src/tool"),
        { type: "entry", id: "s1", role: "developer", content: "system" },
        {
          type: "entry",
          id: "a1",
          parent: "s1",
          role: "assistant",
          blocks: [
            { type: "toolCall", id: "c1", name: "bash", arguments: { command: "a" } },
            { type: "toolCall", id: "c2", name: "bash", arguments: { command: "b" } },
          ],
        },
        {
          type: "entry",
          id: "r1",
          parent: "a1",
          role: "toolResult",
          blocks: [{ type: "toolResult", id: "c1", output: "one", isError: false }],
        },
        {
          type: "entry",
          id: "r2",
          parent: "r1",
          role: "toolResult",
          blocks: [{ type: "toolResult", id: "c1", output: "two", isError: false }],
        },
      ]);
      await expect(
        importGjcSession({ sessionId: "duplicate", leafId: "r2", roots: [root], cwd: target }),
      ).rejects.toThrow(/Unknown toolResult id|Duplicate toolResult id|Duplicate tool call id/);

      await writeSourceSession(root, "noncontig", [
        sourceLineage("noncontig", "/src/tool"),
        { type: "entry", id: "s1", role: "developer", content: "system" },
        {
          type: "entry",
          id: "a1",
          parent: "s1",
          role: "assistant",
          blocks: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "a" } }],
        },
        { type: "entry", id: "u1", parent: "a1", role: "user", content: "gap" },
        {
          type: "entry",
          id: "r1",
          parent: "u1",
          role: "toolResult",
          blocks: [{ type: "toolResult", id: "c1", output: "late", isError: false }],
        },
      ]);
      await expect(
        importGjcSession({ sessionId: "noncontig", roots: [root], cwd: target }),
      ).rejects.toThrow(/Missing toolResult entries/);

      await writeSourceSession(root, "unknown", [
        sourceLineage("unknown", "/src/tool"),
        { type: "entry", id: "s1", role: "developer", content: "system" },
        {
          type: "entry",
          id: "a1",
          parent: "s1",
          role: "assistant",
          blocks: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "a" } }],
        },
        {
          type: "entry",
          id: "r1",
          parent: "a1",
          role: "toolResult",
          blocks: [{ type: "toolResult", id: "different", output: "bad", isError: false }],
        },
      ]);
      await expect(
        importGjcSession({ sessionId: "unknown", roots: [root], cwd: target }),
      ).rejects.toThrow(/Unknown toolResult id/);
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
  });
});

test("unsupported image refs, unsupported patch targets, and v5 version gating", async () => {
  await withTempDir("gjc-invalid-", async root => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-target-"));
    try {
      await writeSourceSession(root, "old-version", [
        {
          type: "session",
          version: 4,
          id: "old-version",
          cwd: "/src/old",
        },
      ]);
      await expect(
        importGjcSession({ sessionId: "old-version", roots: [root], cwd: target }),
      ).rejects.toThrow(/too old/);

      await writeSourceSession(root, "new-version", [
        {
          type: "session",
          version: 6,
          id: "new-version",
          cwd: "/src/new",
        },
      ]);
      await expect(
        importGjcSession({ sessionId: "new-version", roots: [root], cwd: target }),
      ).rejects.toThrow(/future/);

      const malformedJsonPath = path.join(root, "malformed-json.jsonl");
      await fs.writeFile(
        malformedJsonPath,
        `${linesFromRecords([{ type: "session", version: 5, id: "malformed-json", cwd: "/src/malformed" }])}not-json\n`,
        "utf8",
      );
      await expect(
        importGjcSession({ sessionId: "malformed-json", roots: [root], cwd: target }),
      ).rejects.toThrow(/Malformed JSON/);

      const malformedRecordPath = path.join(root, "malformed-record.jsonl");
      await fs.writeFile(
        malformedRecordPath,
        `${linesFromRecords([{ type: "session", version: 5, id: "malformed-record", cwd: "/src/malformed" }])}123\n`,
        "utf8",
      );
      await expect(
        importGjcSession({ sessionId: "malformed-record", roots: [root], cwd: target }),
      ).rejects.toThrow(/Malformed record/);

      const malformedPath = path.join(root, "bad.jsonl");
      await fs.writeFile(malformedPath, "this is not json", "utf8");
      await expect(
        importGjcSession({ sessionId: "bad", roots: [root], cwd: target }),
      ).rejects.toThrow(/not found/);

      await writeSourceSession(root, "unsupported-image", [
        sourceLineage("unsupported-image", "/src/bad"),
        {
          type: "entry",
          id: "s1",
          role: "assistant",
          blocks: [{ type: "image", mediaType: "image/png", url: "file:///tmp/a.png" }],
        },
      ]);
      await expect(
        importGjcSession({ sessionId: "unsupported-image", roots: [root], cwd: target }),
      ).rejects.toThrow(/Unsupported external image reference/);

      await writeSourceSession(root, "unsupported-patch", [
        sourceLineage("unsupported-patch", "/src/bad"),
        { type: "entry", id: "s1", role: "user", content: "hi" },
        {
          type: "entry_patch",
          entry: "s1",
          patch: [{ op: "replace", path: "/unsupported", value: "nope" }],
        },
      ]);
      await expect(
        importGjcSession({ sessionId: "unsupported-patch", roots: [root], cwd: target }),
      ).rejects.toThrow(/Unsupported entry patch target/);
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
  });
});
test("import produces atomic v1 provenance and never mutates source session file", async () => {
  await withTempDir("gjc-provenance-", async root => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-target-"));
    try {
      const sourcePath = await writeSourceSession(root, "provenance-session", [
        sourceLineage("provenance-session", "/src/prov"),
        { type: "entry", id: "s1", role: "developer", content: "system" },
        { type: "entry", id: "u1", parent: "s1", role: "user", content: "hello" },
      ]);

      const before = await fs.stat(sourcePath);
      const beforeBytes = await fs.readFile(sourcePath);
      const sourceSha = createHash("sha256").update(beforeBytes).digest("hex");

      const imported = await importGjcSession({
        sessionId: "provenance-session",
        roots: [root],
        cwd: target,
      });

      const after = await fs.stat(sourcePath);
      const afterBytes = await fs.readFile(sourcePath);
      expect(afterBytes.equals(beforeBytes)).toBe(true);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(imported.reused).toBe(false);

      const header = await loadSession(imported.sessionId, target);
      expect(header.header.version).toBe(1);
      expect(header.header.sourceSystem).toBe("gjc");
      expect(header.header.sourceSessionId).toBe("provenance-session");
      expect(header.header.sourceLeafId).toBe("u1");
      expect(header.header.sourceSha256).toBe(sourceSha);
      expect(header.header.importTimestamp).toBeDefined();

      // failure path should also keep source file immutable
      const failurePath = path.join(root, "failure-session.jsonl");
      await fs.writeFile(
        failurePath,
        linesFromRecords([
          { type: "session", version: 5, id: "failure-session", cwd: "/src/prov" },
          {
            type: "entry",
            id: "o1",
            role: "assistant",
            blocks: [{ type: "toolResult", id: "x", output: 10 }],
          },
        ]),
        "utf8",
      );

      const beforeFail = await fs.stat(failurePath);
      const beforeFailBytes = await fs.readFile(failurePath);
      await expect(
        importGjcSession({ sessionId: "failure-session", roots: [root], cwd: target }),
      ).rejects.toThrow();
      const afterFail = await fs.stat(failurePath);
      const afterFailBytes = await fs.readFile(failurePath);
      expect(afterFailBytes.equals(beforeFailBytes)).toBe(true);
      expect(afterFail.mtimeMs).toBe(beforeFail.mtimeMs);

      const listed = await listSessions(target);
      expect(listed.some(session => session.id === imported.sessionId)).toBe(true);
      expect(listed.some(session => session.id === "failure-session")).toBe(false);
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
  });
});
