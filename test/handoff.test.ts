import { test, expect, mock } from "bun:test";
import type { Message } from "../src/agent/loop";

// jeo-native subset of gjc `/handoff` parity — see src/agent/compaction.ts's
// buildHandoffDocument, src/commands/launch/slash-views.ts's
// parseHandoffCommand/handoffLines, and the `compaction.handoffFocus` field on
// src/agent/config-schema.ts's ConfigSchema.

let mockCallLlm = async (_messages: Message[], _opts?: any): Promise<string> => "SUMMARY-TEXT";

await mock.module("../src/agent/loop", () => ({
  callLlm: (messages: Message[], opts?: any) => mockCallLlm(messages, opts),
}));

const { buildHandoffDocument } = await import("../src/agent/compaction");
const { parseHandoffCommand, handoffLines } = await import("../src/commands/launch/slash-views");
const { parseConfig } = await import("../src/agent/config-schema");

function makeHistory(n: number, withSystem = false): Message[] {
  const history: Message[] = [];
  if (withSystem) history.push({ role: "system", content: "system instruction" });
  for (let i = 0; i < n; i++) {
    history.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i}` });
  }
  return history;
}

// ─── buildHandoffDocument: non-destructive generation ───

test("buildHandoffDocument: rejects a too-short history and leaves it untouched (no LLM call)", async () => {
  let called = false;
  mockCallLlm = async () => { called = true; return "SUMMARY-TEXT"; };

  const history = makeHistory(1, true); // system + 1 body message — below the floor
  const original = [...history];

  const res = await buildHandoffDocument(history);

  expect(res.ok).toBe(false);
  expect(res.error).toContain("at least 2");
  expect(res.document).toBeUndefined();
  expect(called).toBe(false);
  expect(history).toEqual(original);
});

test("buildHandoffDocument: rejects an empty history", async () => {
  const res = await buildHandoffDocument([]);
  expect(res.ok).toBe(false);
  expect(res.error).toContain("at least 2");
});

test("buildHandoffDocument: builds a bounded document and appends focus as its own trailing section", async () => {
  mockCallLlm = async (messages, opts) => {
    expect(opts.systemPrompt).toContain("handoff document");
    expect(messages[0].content).toContain("[user] Message 0");
    return "BASE-SUMMARY-BODY";
  };
  const history = makeHistory(6, true);
  const original = [...history];

  const res = await buildHandoffDocument(history, { model: "test-model", focus: "watch the auth flow" });

  expect(res.ok).toBe(true);
  expect(res.document).toContain("# Session Handoff");
  expect(res.document).toContain("BASE-SUMMARY-BODY");
  expect(res.document).toContain("## Focus");
  expect(res.document).toContain("watch the auth flow");
  // Append-only: the focus section comes AFTER the base summary body, never replacing it.
  expect(res.document!.indexOf("BASE-SUMMARY-BODY")).toBeLessThan(res.document!.indexOf("## Focus"));
  // Non-destructive: history is exactly as it was before the call.
  expect(history).toEqual(original);
});

test("buildHandoffDocument: omits the Focus section entirely when no focus is given", async () => {
  mockCallLlm = async () => "NO-FOCUS-SUMMARY";
  const history = makeHistory(4);

  const res = await buildHandoffDocument(history);

  expect(res.ok).toBe(true);
  expect(res.document).toContain("NO-FOCUS-SUMMARY");
  expect(res.document).not.toContain("## Focus");
});

test("buildHandoffDocument: a whitespace-only focus is treated as no focus", async () => {
  mockCallLlm = async () => "WS-FOCUS-SUMMARY";
  const res = await buildHandoffDocument(makeHistory(4), { focus: "   " });
  expect(res.ok).toBe(true);
  expect(res.document).not.toContain("## Focus");
});

test("buildHandoffDocument: mechanically preserves touched files even if the LLM summary omits them", async () => {
  mockCallLlm = async () => "a plain summary with no file mentions";
  const history: Message[] = [
    { role: "user", content: "please write the config" },
    { role: "assistant", content: 'Tool call: {"tool":"write","filePath":"src/config.ts"}' },
    { role: "user", content: "thanks" },
  ];
  const res = await buildHandoffDocument(history);
  expect(res.ok).toBe(true);
  expect(res.touchedFiles).toEqual(["src/config.ts"]);
  expect(res.document).toContain("src/config.ts");
});

test("buildHandoffDocument: summarizer failure surfaces a clear error and leaves history untouched (no destructive mutation)", async () => {
  mockCallLlm = async () => { throw new Error("LLM unavailable"); };
  const history = makeHistory(6, true);
  const original = [...history];

  const res = await buildHandoffDocument(history, { model: "test-model" });

  expect(res.ok).toBe(false);
  expect(res.error).toContain("Handoff summary failed");
  expect(res.error).toContain("History was left untouched");
  expect(res.document).toBeUndefined();
  expect(history).toEqual(original); // still no splice/mutation, unlike maybeCompact's fallback rung
});

test("buildHandoffDocument: an already-aborted signal is reported, not left hanging or mutating history", async () => {
  mockCallLlm = async (_messages, opts?: any) => {
    if (opts?.signal?.aborted) throw new Error("aborted");
    return "SHOULD-NOT-BE-USED";
  };
  const ac = new AbortController();
  ac.abort();
  const history = makeHistory(4, true);
  const original = [...history];

  const res = await buildHandoffDocument(history, { signal: ac.signal });

  expect(res.ok).toBe(false);
  expect(res.error).toContain("cancelled");
  expect(history).toEqual(original);
});

// ─── parseHandoffCommand: command recognition ───

test("parseHandoffCommand: recognizes the bare command with no focus", () => {
  expect(parseHandoffCommand("/handoff")).toEqual({});
});

test("parseHandoffCommand: recognizes a focus argument", () => {
  expect(parseHandoffCommand("/handoff finish the retry ladder")).toEqual({ focus: "finish the retry ladder" });
});

test("parseHandoffCommand: trims surrounding whitespace from the focus argument", () => {
  expect(parseHandoffCommand("/handoff   pad the budget   ")).toEqual({ focus: "pad the budget" });
});

test("parseHandoffCommand: a trailing-space-only argument is treated as no focus", () => {
  expect(parseHandoffCommand("/handoff ")).toEqual({});
});

test("parseHandoffCommand: does not match an unrelated command or a look-alike prefix", () => {
  expect(parseHandoffCommand("/compact")).toBeUndefined();
  expect(parseHandoffCommand("/handoffnow")).toBeUndefined();
  expect(parseHandoffCommand("handoff")).toBeUndefined();
});

// ─── handoffLines: presenter over an already-computed result ───

test("handoffLines: renders the failure path without a document, noting history is untouched", () => {
  const lines = handoffLines({ ok: false, error: "Nothing to hand off yet — need at least 2 conversation messages (have 1)." }, 80);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("Nothing to hand off yet");
  expect(lines[0]).toContain("history left untouched");
});

test("handoffLines: renders the generated document between separators", () => {
  const lines = handoffLines({ ok: true, document: "# Session Handoff\n\nsome body\n\n## Focus\n\nkeep going" }, 80);
  expect(lines[0]).toBe(lines[lines.length - 1]); // matching top/bottom separators
  expect(lines.join("\n")).toContain("some body");
  expect(lines.join("\n")).toContain("## Focus");
  expect(lines.join("\n")).toContain("history left untouched");
});

// ─── config-schema: compaction.handoffFocus threads through without breaking defaults ───

test("parseConfig: compaction.handoffFocus is optional — a config without it still validates (backward compat)", () => {
  const r = parseConfig({ defaultModel: "m" });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.config.compaction).toBeUndefined();
});

test("parseConfig: accepts a configured compaction.handoffFocus default", () => {
  const r = parseConfig({ defaultModel: "m", compaction: { handoffFocus: "always mention migration risk" } });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.config.compaction?.handoffFocus).toBe("always mention migration risk");
});

test("parseConfig: rejects a wrong-typed compaction.handoffFocus with a located message", () => {
  const r = parseConfig({ defaultModel: "m", compaction: { handoffFocus: 123 } });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.message).toContain("compaction.handoffFocus");
});
