import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const MAX_FILES = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const CDN_HOSTS = ["cdn.discordapp.com", "media.discordapp.net"];

interface Attachment {
  filename: string;
  url: string;
  size: number;
}

export interface DiscordAttachmentOptions {
  directory: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface DiscordAttachmentStage {
  files: string[];
  cleanup: () => Promise<void>;
}

/** Staged files are private and must be removed with cleanup after the request finishes. */
export async function stageDiscordAttachments(
  attachments: unknown[],
  options: DiscordAttachmentOptions,
): Promise<DiscordAttachmentStage> {
  if (!Array.isArray(attachments) || attachments.length > MAX_FILES) throw new Error("Invalid Discord attachment count");
  const validated: Attachment[] = [];
  let declaredTotal = 0;
  for (const value of attachments) {
    if (!value || typeof value !== "object") throw new Error("Invalid Discord attachment");
    const item = value as Record<string, unknown>;
    if (typeof item.filename !== "string" || !item.filename || typeof item.url !== "string" ||
        !Number.isSafeInteger(item.size) || (item.size as number) < 0 || (item.size as number) > MAX_FILE_BYTES) {
      throw new Error("Invalid Discord attachment metadata");
    }
    let url: URL;
    try { url = new URL(item.url); } catch { throw new Error("Invalid Discord attachment URL"); }
    if (url.protocol !== "https:" || !CDN_HOSTS.includes(url.hostname) || url.username || url.password || url.port) {
      throw new Error("Untrusted Discord attachment URL");
    }
    declaredTotal += item.size as number;
    if (declaredTotal > MAX_TOTAL_BYTES) throw new Error("Discord attachments exceed total size limit");
    validated.push({ filename: item.filename, url: url.href, size: item.size as number });
  }
  if (options.signal?.aborted) throw new Error("Discord attachment download aborted");
  const directory = options.directory;
  if (typeof directory !== "string" || !isAbsolute(directory) || resolve(directory) !== directory || basename(directory) !== "input") {
    throw new Error("Invalid Discord attachment staging directory");
  }
  const parent = dirname(directory);
  const info = await lstat(parent);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid()) || await realpath(parent) !== parent) {
    throw new Error("Untrusted Discord attachment staging directory");
  }
  await mkdir(directory, { mode: 0o700 });
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const files: string[] = [];
    let total = 0;
    for (const [index, item] of validated.entries()) {
      const name = item.filename.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 180) || "attachment";
      const path = join(directory, `${index + 1}-${name}`);
      const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(30_000)]);
      let response: Response;
      try {
        response = await (options.fetchImpl ?? fetch)(item.url, { redirect: "error", signal });
      } catch {
        throw new Error("Discord attachment download failed or aborted");
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw new Error("Discord attachment download failed");
      }
      const file = await open(path, "wx", 0o600).catch(async () => {
        await response.body?.cancel().catch(() => {});
        throw new Error("Discord attachment staging failed");
      });
      const reader = response.body.getReader();
      let size = 0;
      try {
        for (;;) {
          if (signal.aborted) throw new Error("Discord attachment download aborted");
          const { done, value } = await reader.read().catch(() => { throw new Error("Discord attachment download failed or aborted"); });
          if (signal.aborted) throw new Error("Discord attachment download aborted");
          if (done) break;
          size += value.byteLength;
          total += value.byteLength;
          if (size > MAX_FILE_BYTES || size > item.size || total > MAX_TOTAL_BYTES) throw new Error("Discord attachment exceeds size limit");
          let offset = 0;
          while (offset < value.byteLength) {
            if (signal.aborted) throw new Error("Discord attachment download aborted");
            const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
            if (!bytesWritten) throw new Error("Discord attachment write failed");
            offset += bytesWritten;
          }
        }
        if (size !== item.size) throw new Error("Discord attachment size mismatch");
      } finally {
        await reader.cancel().catch(() => {});
        await file.close();
      }
      files.push(path);
    }
    if (options.signal?.aborted) throw new Error("Discord attachment download aborted");
    return { files, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
