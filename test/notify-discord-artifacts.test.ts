import { expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDiscordArtifactStage, resolveDiscordArtifactStage } from "../src/agent/notify/discord-artifacts";
import { DiscordApi } from "../src/agent/notify/discord-api";

let configDir: string;
let previousConfigDir: string | undefined;
beforeEach(async () => {
  previousConfigDir = process.env.JEO_CONFIG_DIR;
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-artifact-tests-"));
  process.env.JEO_CONFIG_DIR = configDir;
});
afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = previousConfigDir;
  await fs.rm(configDir, { recursive: true, force: true });
});
function makeStage() { return createDiscordArtifactStage("session", crypto.randomUUID()); }

test("staged output preserves file names and bytes without crossing request boundaries", async () => {
  const firstId = crypto.randomUUID();
  const secondId = crypto.randomUUID();
  const first = await createDiscordArtifactStage("alpha", firstId);
  const second = await createDiscordArtifactStage("beta", secondId);
  let firstCleaned = false;
  try {
    const bytes = Uint8Array.from([0, 255, 13, 10, 65]);
    await fs.writeFile(path.join(first.directory, "result.bin"), bytes);
    await fs.writeFile(path.join(second.directory, "other.txt"), "second session");
    expect(await resolveDiscordArtifactStage("alpha", firstId)).toEqual({ output: first.directory });
    await expect(resolveDiscordArtifactStage("beta", firstId)).rejects.toThrow();
    await expect(resolveDiscordArtifactStage("alpha", secondId)).rejects.toThrow();
    expect(await first.collect()).toEqual([{ name: "result.bin", data: bytes }]);
    expect(await second.collect()).toEqual([{ name: "other.txt", data: new TextEncoder().encode("second session") }]);
    await first.cleanup();
    firstCleaned = true;
    await expect(fs.stat(first.directory)).rejects.toThrow();
    expect(await second.collect()).toEqual([{ name: "other.txt", data: new TextEncoder().encode("second session") }]);
  } finally {
    if (!firstCleaned) await first.cleanup();
    await second.cleanup();
  }
});

test("staged output rejects links and nested paths rather than exporting outside files", async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-artifact-outside-"));
  try {
    const secret = path.join(outside, "secret.txt");
    await fs.writeFile(secret, "private data");
    for (const kind of ["symlink", "hardlink", "directory"] as const) {
      const stage = await makeStage();
      try {
        const entry = path.join(stage.directory, "entry");
        if (kind === "symlink") await fs.symlink(secret, entry);
        else if (kind === "hardlink") await fs.link(secret, entry);
        else { await fs.mkdir(entry); await fs.writeFile(path.join(entry, "nested.txt"), "nested"); }
        await expect(stage.collect()).rejects.toThrow();
        expect(await fs.readFile(secret, "utf8")).toBe("private data");
      } finally { await stage.cleanup(); }
    }
  } finally { await fs.rm(outside, { recursive: true, force: true }); }
});

test("hidden and control-character filenames cannot be exported", async () => {
  for (const name of [".env", "bad\nname.txt"]) {
    const stage = await makeStage();
    try {
      await fs.writeFile(path.join(stage.directory, name), "sensitive");
      await expect(stage.collect()).rejects.toThrow();
    } finally { await stage.cleanup(); }
  }
});

test("staged output fails closed when count or byte limits are exceeded", async () => {
  const count = await makeStage();
  const size = await makeStage();
  const total = await makeStage();
  try {
    for (let i = 0; i < 5; i++) await fs.writeFile(path.join(count.directory, `${i}.txt`), "x");
    await expect(count.collect()).rejects.toThrow();
    await fs.writeFile(path.join(size.directory, "large.bin"), new Uint8Array(8 * 1024 * 1024 + 1));
    await expect(size.collect()).rejects.toThrow();
    await fs.writeFile(path.join(total.directory, "one.bin"), new Uint8Array(4 * 1024 * 1024 + 1));
    await fs.writeFile(path.join(total.directory, "two.bin"), new Uint8Array(4 * 1024 * 1024));
    await expect(total.collect()).rejects.toThrow();
  } finally {
    await count.cleanup();
    await size.cleanup();
    await total.cleanup();
  }
});

test("Discord upload sends the exact binary artifact to the selected channel without mentions", async () => {
  const sent: { url: string; body: FormData }[] = [];
  const api = new DiscordApi("offline-test-token", { fetchImpl: async (url, init) => {
    sent.push({ url: String(url), body: init!.body as FormData });
    return Response.json({ id: "123" });
  } });
  try {
    const stage = await makeStage();
    try {
      const bytes = Uint8Array.from([0, 42, 255, 10]);
      await fs.writeFile(path.join(stage.directory, "report.bin"), bytes);
      const [artifact] = await stage.collect();
      expect(await api.sendFile("123456789", artifact!.name, artifact!.data)).toEqual([{ id: "123" }]);
      expect(sent.map(request => request.url)).toEqual(["https://discord.com/api/v10/channels/123456789/messages"]);
      const file = sent[0]!.body.get("files[0]") as File;
      expect(file.name).toBe("report.bin");
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
      expect(JSON.parse(String(sent[0]!.body.get("payload_json")))).toEqual({ allowed_mentions: { parse: [], replied_user: false } });
    } finally { await stage.cleanup(); }
  } finally { api.stop(); }
});

test("Discord rejects ineligible or invalid artifact delivery before transmitting data", async () => {
  let deliveries = 0;
  const api = new DiscordApi("offline-test-token", { fetchImpl: async () => {
    deliveries++;
    return Response.json({ id: "123" });
  } });
  try {
    await expect(api.sendFile("123", "report.txt", new Uint8Array([1]), () => false)).rejects.toThrow();
    expect(() => api.sendFile("123", "../secret", new Uint8Array([1]))).toThrow();
    expect(() => api.sendFile("123", "large.bin", new Uint8Array(8 * 1024 * 1024 + 1))).toThrow();
    expect(deliveries).toBe(0);
  } finally { api.stop(); }
});

test("replacing the staging directory with a symlink cannot export or delete outside files", async () => {
  const stage = await makeStage();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-artifact-replacement-"));
  const moved = `${stage.directory}-moved`;
  try {
    await fs.writeFile(path.join(outside, "private.txt"), "secret");
    await fs.rename(stage.directory, moved);
    await fs.symlink(outside, stage.directory);
    await expect(stage.collect()).rejects.toThrow();
    await stage.cleanup();
    await expect(fs.stat(stage.requestDirectory)).rejects.toThrow();
    expect(await fs.readFile(path.join(outside, "private.txt"), "utf8")).toBe("secret");
  } finally {
    await fs.unlink(stage.directory).catch(() => {});
    await fs.rm(moved, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("cleanup removes the private request after the output directory is deleted or renamed", async () => {
  for (const action of ["delete", "rename"] as const) {
    const stage = await makeStage();
    if (action === "delete") await fs.rm(stage.directory, { recursive: true });
    else await fs.rename(stage.directory, path.join(stage.requestDirectory, "renamed"));
    await expect(stage.collect()).rejects.toThrow();
    await stage.cleanup();
    await expect(fs.stat(stage.requestDirectory)).rejects.toThrow();
  }
});
