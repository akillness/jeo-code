import { expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  MAX_ARTIFACTS,
  MAX_DISCORD_ATTACHMENT_REDIRECTS,
  stageDiscordAttachments,
  validateDiscordAttachmentUrl,
} from "../src/agent/notify/discord-attachments";

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
    { ...attachment, url: "https://cdn.discordapp.com:443/a" },
    { ...attachment, url: "https://%63dn.discordapp.com/a" },
    { ...attachment, url: "https://cdn.discordapp.com./a" },
    { ...attachment, url: "https://сdn.discordapp.com/a" },
  ]) await expect(stageInput([candidate], { fetchImpl })).rejects.toThrow();
  expect(requests).toBe(0);
});

test("trusted CDN policy uses parsed exact hosts with documented case normalization", () => {
  expect(validateDiscordAttachmentUrl("HTTPS://CDN.DISCORDAPP.COM/attachments/ü").hostname).toBe("cdn.discordapp.com");
  expect(validateDiscordAttachmentUrl("https://media.discordapp.net/a").hostname).toBe("media.discordapp.net");
  for (const value of [
    "http://cdn.discordapp.com/a",
    "https://cdn.discordapp.com.evil.example/a",
    "https://user:pass@cdn.discordapp.com/a",
    "https://cdn.discordapp.com:443/a",
    "https://%63dn.discordapp.com/a",
    "https://сdn.discordapp.com/a",
    "https://cdn.discordapp.com./a",
  ]) expect(() => validateDiscordAttachmentUrl(value)).toThrow();
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

test("trusted redirects are followed manually and every redirect destination is validated", async () => {
  const requested: string[] = [];
  const stage = await stageInput([attachment], { fetchImpl: async (input, init) => {
    requested.push(String(input));
    expect(init?.redirect).toBe("manual");
    if (requested.length === 1) return new Response(null, { status: 302, headers: { Location: "/attachments/123/456/final.bin" } });
    return new Response(bytes);
  } });
  try {
    expect(requested).toEqual([
      attachment.url,
      "https://cdn.discordapp.com/attachments/123/456/final.bin",
    ]);
  } finally { await stage.cleanup(); }

  for (const location of [
    "http://cdn.discordapp.com/file",
    "https://evil.example/file",
    "https://cdn.discordapp.com.evil.example/file",
    "https://user@cdn.discordapp.com/file",
    "https://cdn.discordapp.com:443/file",
    "https://%63dn.discordapp.com/file",
    "https://сdn.discordapp.com/file",
    "https://cdn.discordapp.com./file",
  ]) {
    let requests = 0;
    await expect(stageInput([attachment], { fetchImpl: async () => {
      requests++;
      return new Response(null, { status: 302, headers: { Location: location } });
    } })).rejects.toThrow();
    expect(requests).toBe(1);
  }

  let hop = 0;
  await expect(stageInput([attachment], { fetchImpl: async () => {
    hop++;
    return new Response(null, {
      status: 302,
      headers: { Location: hop === 1 ? "https://media.discordapp.net/trusted-hop" : "https://evil.example/final" },
    });
  } })).rejects.toThrow();
  expect(hop).toBe(2);
});

test("redirect limit and final response URL policy are enforced", async () => {
  let redirects = 0;
  await expect(stageInput([attachment], { fetchImpl: async () => {
    redirects++;
    return new Response(null, { status: 302, headers: { Location: `/hop-${redirects}` } });
  } })).rejects.toThrow();
  expect(redirects).toBe(MAX_DISCORD_ATTACHMENT_REDIRECTS + 1);

  const untrustedFinal = new Response(bytes);
  Object.defineProperty(untrustedFinal, "url", { value: "https://evil.example/final" });
  await expect(stageInput([attachment], { fetchImpl: async () => untrustedFinal })).rejects.toThrow();
});

test("mismatched sizes and oversized downloads cannot become input files", async () => {
  await expect(stageInput([{ ...attachment, size: 3 }], { fetchImpl: async () => new Response(bytes) })).rejects.toThrow();
  let requests = 0;
  await expect(stageInput([{ ...attachment, size: 25 * 1024 * 1024 + 1 }], { fetchImpl: async () => { requests++; return new Response(bytes); } })).rejects.toThrow();
  expect(requests).toBe(0);
});

test("MAX_ARTIFACTS counts every presented entry and overflow rejects the complete message", async () => {
  expect(MAX_ARTIFACTS).toBe(10);
  let requests = 0;
  const fetchImpl: typeof fetch = async () => { requests++; return new Response(bytes); };
  const tenDuplicates = Array.from({ length: MAX_ARTIFACTS }, (_, index) => ({ ...attachment, filename: `duplicate-${index}.bin` }));
  const stage = await stageInput(tenDuplicates, { fetchImpl });
  try { expect(stage.files).toHaveLength(10); } finally { await stage.cleanup(); }
  expect(requests).toBe(10);

  requests = 0;
  await expect(stageInput([...tenDuplicates, attachment], { fetchImpl })).rejects.toThrow("Invalid Discord attachment count");
  expect(requests).toBe(0);

  const invalidAmongTen = [...tenDuplicates.slice(0, 9), null];
  await expect(stageInput(invalidAmongTen, { fetchImpl })).rejects.toThrow("Invalid Discord attachment");
  await expect(stageInput([...invalidAmongTen, attachment], { fetchImpl })).rejects.toThrow("Invalid Discord attachment count");
  expect(requests).toBe(0);
});

test("declared aggregate limits are enforced before downloading", async () => {
  let requests = 0;
  const fetchImpl: typeof fetch = async () => { requests++; return new Response(bytes); };
  const large = { ...attachment, size: 25 * 1024 * 1024 };
  await expect(stageInput([large, large, attachment], { fetchImpl })).rejects.toThrow();
  expect(requests).toBe(0);
});
