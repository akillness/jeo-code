import { test, expect } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { anthropicPayload } from "../src/ai/providers/anthropic";
import { readGlobalConfig, readRawGlobalConfig, saveGlobalConfig, saveConfigPatch, clearConfigReadCache, type Config } from "../src/agent/state";
import { createSession, appendMessages, loadSession } from "../src/agent/session";
import type { Message } from "../src/ai/types";

// ── Anthropic conversation prompt caching ────────────────────────────────────

test("anthropic: the LAST message carries a cache_control breakpoint (conversation caching)", () => {
  const messages: Message[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "tool result" },
  ];
  const payload = JSON.parse(anthropicPayload(messages, { model: "claude-sonnet-4-5" } as any, false, true));
  const msgs = payload.messages;
  // Earlier messages stay plain strings (no per-message block bloat).
  expect(msgs[0].content).toBe("u1");
  expect(msgs[1].content).toBe("a1");
  // The final message is converted to a block with the ephemeral breakpoint.
  const lastBlocks = msgs[msgs.length - 1].content;
  expect(Array.isArray(lastBlocks)).toBe(true);
  expect(lastBlocks[lastBlocks.length - 1]).toEqual({ type: "text", text: "tool result", cache_control: { type: "ephemeral" } });
  // System breakpoint is still present (slot 1 of 4).
  const system = payload.system;
  expect(system[system.length - 1].cache_control).toEqual({ type: "ephemeral" });
});

test("anthropic: image-bearing last message puts the breakpoint on its tail block", () => {
  const img = { mediaType: "image/png", data: "aGk=" };
  const messages: Message[] = [{ role: "user", content: "see image", images: [img] }];
  const payload = JSON.parse(anthropicPayload(messages, { model: "claude-sonnet-4-5" } as any, false, true));
  const blocks = payload.messages[0].content;
  expect(blocks[0].type).toBe("image");
  expect(blocks[blocks.length - 1]).toMatchObject({ type: "text", text: "see image", cache_control: { type: "ephemeral" } });
});

// ── Config read cache ─────────────────────────────────────────────────────────

async function withTempConfigDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-cfgcache-"));
  const prev = process.env.JOC_CONFIG_DIR;
  process.env.JOC_CONFIG_DIR = dir;
  clearConfigReadCache();
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.JOC_CONFIG_DIR;
    else process.env.JOC_CONFIG_DIR = prev;
    clearConfigReadCache();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("config cache: repeated reads hit the cache, saves invalidate it", async () => {
  await withTempConfigDir(async () => {
    await saveGlobalConfig({ providers: {}, defaultModel: "model-a" } as Config);
    expect((await readGlobalConfig()).defaultModel).toBe("model-a");
    expect((await readGlobalConfig()).defaultModel).toBe("model-a"); // cached read
    // Save through the API → cache invalidated → fresh value visible immediately.
    await saveConfigPatch(() => ({ defaultModel: "model-b" }));
    expect((await readGlobalConfig()).defaultModel).toBe("model-b");
    expect((await readRawGlobalConfig()).defaultModel).toBe("model-b");
  });
});

test("config cache: external file writes are picked up via mtime/size", async () => {
  await withTempConfigDir(async (dir) => {
    await saveGlobalConfig({ providers: {}, defaultModel: "model-a" } as Config);
    await readGlobalConfig(); // populate cache
    // Direct write, bypassing saveGlobalConfig (size and content change).
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ providers: {}, defaultModel: "model-external-longer" }), "utf-8");
    expect((await readGlobalConfig()).defaultModel).toBe("model-external-longer");
  });
});

test("config cache: returned configs are clones — caller mutation cannot poison the cache", async () => {
  await withTempConfigDir(async () => {
    await saveGlobalConfig({ providers: {}, defaultModel: "model-a", modelAliases: { x: "y" } } as Config);
    const first = await readGlobalConfig();
    first.defaultModel = "MUTATED";
    first.modelAliases!.x = "MUTATED";
    const second = await readGlobalConfig();
    expect(second.defaultModel).toBe("model-a");
    expect(second.modelAliases!.x).toBe("y");
  });
});

// ── Batched session persistence ───────────────────────────────────────────────

test("appendMessages: one batched append round-trips through loadSession", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-sess-"));
  try {
    const { id } = await createSession(dir);
    const batch: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: '{"tool":"read"}' },
      { role: "user", content: "Tool [read] result (ok):\nbody" },
    ];
    await appendMessages(id, batch, dir);
    await appendMessages(id, [], dir); // empty batch is a no-op, not a blank line
    const { messages } = await loadSession(id, dir);
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe("q");
    expect(messages[2].content).toContain("Tool [read] result");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
