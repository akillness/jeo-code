import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { jeoHomeDir } from "../notify/paths";
import { ensurePrivateSandboxDirectory } from "./authority";
import source from "./hands-source.text";

/** The text asset is embedded by Bun's standalone compiler, not read from a release source tree. */
export async function prepareHandsBundle(): Promise<string> {
  const directory = await ensurePrivateSandboxDirectory(path.join(jeoHomeDir(), "sandbox", "runtime"));
  const digest = new Bun.CryptoHasher("sha256").update(source).digest("hex");
  const file = path.join(await fs.realpath(directory), `${digest}.js`);
  let existing: FileHandle;
  try { existing = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const staging = await fs.mkdtemp(path.join(directory, ".bundle-"));
    const temporary = path.join(staging, "hands.js");
    try {
      const output = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await output.writeFile(source);
        await output.sync();
        if (process.platform !== "win32") await output.chmod(0o400);
      } finally { await output.close(); }
      try { await fs.link(temporary, file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
    existing = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  }
  try {
    const stat = await existing.stat();
    if (!stat.isFile() || (process.platform !== "win32" && ((stat.mode & 0o022) !== 0 || stat.uid !== process.getuid?.())) ||
        new Bun.CryptoHasher("sha256").update(await existing.readFile()).digest("hex") !== digest) {
      throw new Error("SANDBOX_BUNDLE: trusted runtime content or ownership changed");
    }
  } finally { await existing.close(); }
  return file;
}
