import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readUpdateCache, writeUpdateCache } from "../src/util/update-check";

const made: string[] = [];
async function withCacheDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jeo-update-cache-"));
  made.push(dir);
  process.env.JEO_CONFIG_DIR = dir;
  return dir;
}

afterEach(async () => {
  delete process.env.JEO_CONFIG_DIR;
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
});

test("readUpdateCache returns null when no cache file exists", async () => {
  await withCacheDir();
  expect(await readUpdateCache("0.4.5")).toBeNull();
});

test("writeUpdateCache then readUpdateCache reports updateAvailable against current", async () => {
  await withCacheDir();
  await writeUpdateCache("0.4.6");
  expect(await readUpdateCache("0.4.5")).toEqual({
    current: "0.4.5",
    latest: "0.4.6",
    updateAvailable: true,
  });
});

test("readUpdateCache clears the banner once the local version catches up", async () => {
  await withCacheDir();
  await writeUpdateCache("0.4.6");
  expect((await readUpdateCache("0.4.6"))?.updateAvailable).toBe(false);
  // A local version newer than the cached latest is also not an update.
  expect((await readUpdateCache("0.5.0"))?.updateAvailable).toBe(false);
});

test("writeUpdateCache ignores empty input and readUpdateCache tolerates a missing local version", async () => {
  await withCacheDir();
  await writeUpdateCache(""); // no-op
  expect(await readUpdateCache("0.4.5")).toBeNull();
  await writeUpdateCache("0.4.6");
  expect(await readUpdateCache("")).toBeNull();
});
