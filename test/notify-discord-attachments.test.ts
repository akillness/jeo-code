import { expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { stageDiscordAttachments } from "../src/agent/notify/discord-attachments";

const bytes = Uint8Array.from([0, 255, 12, 65]);
const attachment = { filename: "input.bin", url: "https://cdn.discordapp.com/attachments/123/456/input.bin", size: bytes.length };

let directory: string;
beforeEach(async () => { directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-discord-input-test-"))); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

function stageInput(attachments: unknown[], options: { fetchImpl: typeof fetch }) {
  return stageDiscordAttachments(attachments, { ...options, directory: path.join(directory, "input") });
}

test("authorized attachment is materialized with its exact bytes and removed after use", async () => {
  const stage = await stageInput([attachment], { fetchImpl: async () => new Response(bytes) });
  try {
    expect(stage.files).toHaveLength(1);
    expect(new Uint8Array(await fs.readFile(stage.files[0]!))).toEqual(bytes);
  } finally { await stage.cleanup(); }
  await expect(fs.stat(stage.files[0]!)).rejects.toThrow();
});

test("untrusted attachment destinations are rejected before network access", async () => {
  let requests = 0;
  const fetchImpl: typeof fetch = async () => { requests++; return new Response(bytes); };
  for (const candidate of [
    { ...attachment, url: "https://cdn.discordapp.com.evil.example/a" },
    { ...attachment, url: "http://cdn.discordapp.com/a" },
    { ...attachment, url: "https://user@cdn.discordapp.com/a" },
  ]) await expect(stageInput([candidate], { fetchImpl })).rejects.toThrow();
  expect(requests).toBe(0);
});

test("unsafe input filenames remain confined to the private staging directory", async () => {
  const stage = await stageInput([{ ...attachment, filename: "../../secret" }, { ...attachment, filename: ".env" }], { fetchImpl: async () => new Response(bytes) });
  try {
    expect(path.dirname(stage.files[0]!)).toBe(path.dirname(stage.files[1]!));
    expect(path.basename(stage.files[0]!)).not.toContain("/");
    expect(path.basename(stage.files[1]!)).not.toBe(".env");
    expect(new Uint8Array(await fs.readFile(stage.files[0]!))).toEqual(bytes);
  } finally { await stage.cleanup(); }
});

test("redirects, mismatched sizes and oversized downloads cannot become input files", async () => {
  await expect(stageInput([attachment], { fetchImpl: async () => new Response(null, { status: 302, headers: { Location: "https://evil.example/file" } }) })).rejects.toThrow();
  await expect(stageInput([{ ...attachment, size: 3 }], { fetchImpl: async () => new Response(bytes) })).rejects.toThrow();
  let requests = 0;
  await expect(stageInput([{ ...attachment, size: 25 * 1024 * 1024 + 1 }], { fetchImpl: async () => { requests++; return new Response(bytes); } })).rejects.toThrow();
  expect(requests).toBe(0);
});

test("attachment count and declared aggregate limits are enforced before downloading", async () => {
  let requests = 0;
  const fetchImpl: typeof fetch = async () => { requests++; return new Response(bytes); };
  await expect(stageInput(Array.from({ length: 11 }, () => attachment), { fetchImpl })).rejects.toThrow();
  const large = { ...attachment, size: 25 * 1024 * 1024 };
  await expect(stageInput([large, large, attachment], { fetchImpl })).rejects.toThrow();
  expect(requests).toBe(0);
});
