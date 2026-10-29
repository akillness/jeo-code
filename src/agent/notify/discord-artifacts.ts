import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { notifySessionsDir } from "./paths";
import * as path from "node:path";

const MAX_FILES = 4;
const MAX_BYTES = 8 * 1024 * 1024;

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function privateDirectory(directory: string): Promise<void> {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("Invalid private artifact directory");
  if (await fs.realpath(directory) !== directory) throw new Error("Artifact directory contains a link");
}

export async function prepareDiscordArtifactRoot(sessionId: string): Promise<string> {
  if (!SESSION_ID.test(sessionId)) throw new Error("Invalid session ID");
  await fs.mkdir(notifySessionsDir(), { recursive: true, mode: 0o700 });
  const sessions = await fs.realpath(notifySessionsDir());
  const base = path.join(sessions, "discord-artifacts");
  await fs.mkdir(base, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  await privateDirectory(base);
  const root = path.join(base, sessionId);
  await fs.mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  await privateDirectory(root);
  return root;
}

export interface DiscordArtifactPaths { output: string; input?: string }

export async function resolveDiscordArtifactStage(sessionId: string, requestId: string): Promise<DiscordArtifactPaths> {
  if (!SESSION_ID.test(sessionId) || !REQUEST_ID.test(requestId)) throw new Error("Invalid artifact request ID");
  const sessions = await fs.realpath(notifySessionsDir());
  const base = path.join(sessions, "discord-artifacts");
  const root = path.join(base, sessionId);
  const request = path.join(root, requestId);
  const output = path.join(request, "output");
  for (const directory of [base, root, request, output]) await privateDirectory(directory);
  const input = path.join(request, "input");
  try { await privateDirectory(input); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { output }; throw error; }
  const names = await fs.readdir(input);
  if (names.length > 10) throw new Error("Too many input files");
  let total = 0;
  for (const name of names) {
    if (name.startsWith(".") || /[\x00-\x1f\x7f]/.test(name)) throw new Error("Invalid input filename");
    const info = await fs.lstat(path.join(input, name));
    if (!info.isFile() || info.nlink !== 1 || info.size > 25 * 1024 * 1024) throw new Error("Invalid input file");
    total += info.size;
    if (total > 50 * 1024 * 1024) throw new Error("Input files exceed size limit");
  }
  return { output, input };
}

export interface DiscordArtifactStage {
  directory: string;
  requestDirectory: string;
  collect(): Promise<Array<{ name: string; data: Uint8Array }>>;
  cleanup(): Promise<void>;
}

/** A private, per-request output directory; never upload arbitrary session paths. */
export async function createDiscordArtifactStage(sessionId: string, requestId: string): Promise<DiscordArtifactStage> {
  if (!REQUEST_ID.test(requestId)) throw new Error("Invalid artifact request ID");
  const root = await prepareDiscordArtifactRoot(sessionId);
  const requestDirectory = path.join(root, requestId);
  await fs.mkdir(requestDirectory, { mode: 0o700 });
  const requestInitial = await fs.lstat(requestDirectory);
  const directory = path.join(requestDirectory, "output");
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { await fs.rm(requestDirectory, { recursive: true, force: true }); throw error; }
  const initial = await fs.lstat(directory);
  async function checkDirectory(): Promise<void> {
    if ((await resolveDiscordArtifactStage(sessionId, requestId)).output !== directory) throw new Error("Artifact staging path changed");
    const current = await fs.lstat(directory);
    if (!current.isDirectory() || current.dev !== initial.dev || current.ino !== initial.ino) throw new Error("Artifact staging directory changed");
  }
  return {
    directory,
    requestDirectory,
    async collect() {
      await checkDirectory();
      const names = await fs.readdir(directory);
      if (names.length > MAX_FILES) throw new Error("Too many output files (maximum 4)");
      const result: Array<{ name: string; data: Uint8Array }> = [];
      let total = 0;
      for (const name of names) {
        if (name.startsWith(".") || /[\x00-\x1f\x7f]/.test(name)) throw new Error("Invalid output filename");
        await checkDirectory();
        const file = path.join(directory, name);
        const before = await fs.lstat(file);
        if (!before.isFile() || before.nlink !== 1) throw new Error("Output must be a regular file, not a link or directory");
        if (before.size > MAX_BYTES - total) throw new Error("Output files exceed 8 MiB total");
        const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error("Output file changed during collection");
          const data = new Uint8Array(opened.size);
          let offset = 0;
          while (offset < data.length) {
            const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
            if (!bytesRead) throw new Error("Output file changed during collection");
            offset += bytesRead;
          }
          const after = await handle.stat();
          if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.nlink !== 1) throw new Error("Output file changed during collection");
          await checkDirectory();
          total += data.length;
          result.push({ name, data });
        } finally {
          await handle.close();
        }
      }
      return result;
    },
    async cleanup() {
      await privateDirectory(root);
      await privateDirectory(requestDirectory);
      const current = await fs.lstat(requestDirectory);
      if (current.dev !== requestInitial.dev || current.ino !== requestInitial.ino) throw new Error("Artifact request directory changed");
      await fs.rm(requestDirectory, { recursive: true, force: true });
    },
  };
}
