import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** Limit enforced on presented attachment entries, before validation or deduplication. */
export const MAX_ARTIFACTS = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const DISCORD_ATTACHMENT_CDN_HOSTS = ["cdn.discordapp.com", "media.discordapp.net"] as const;
export const MAX_DISCORD_ATTACHMENT_REDIRECTS = 5;

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

/**
 * Parse and validate one Discord CDN URL without accepting normalization that
 * could conceal an ambiguous authority. Host matching is exact after URL's
 * ASCII/case normalization; Unicode, percent-encoded authorities, trailing
 * dots, user-info, and explicit ports are rejected.
 */
export function validateDiscordAttachmentUrl(value: string): URL {
  if (typeof value !== "string") throw new Error("Untrusted Discord attachment URL");
  const authority = value.match(/^https:\/\/([^/?#]*)/i)?.[1];
  if (!authority || /[^\x00-\x7f]/.test(authority) || authority.includes("%") || authority.endsWith(".")) {
    throw new Error("Untrusted Discord attachment URL");
  }
  if (authority.includes("@") || authority.includes(":")) throw new Error("Untrusted Discord attachment URL");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid Discord attachment URL"); }
  if (url.protocol !== "https:" ||
      !(DISCORD_ATTACHMENT_CDN_HOSTS as readonly string[]).includes(url.hostname) ||
      url.username || url.password || url.port) {
    throw new Error("Untrusted Discord attachment URL");
  }
  return url;
}

async function fetchTrustedAttachment(
  initialUrl: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<Response> {
  let current = validateDiscordAttachmentUrl(initialUrl);
  for (let redirects = 0; ; redirects++) {
    const response = await fetchImpl(current.href, { redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location || redirects >= MAX_DISCORD_ATTACHMENT_REDIRECTS) throw new Error("Discord attachment redirect rejected");
      // Validate an authority-bearing Location before URL resolution can erase
      // percent-encoding, IDNA, case, or default-port evidence.
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(location)) validateDiscordAttachmentUrl(location);
      else if (location.startsWith("//")) validateDiscordAttachmentUrl(`${current.protocol}${location}`);
      current = validateDiscordAttachmentUrl(new URL(location, current).href);
      continue;
    }
    // Native fetch exposes the final URL. Test doubles commonly leave it blank.
    if (response.url) validateDiscordAttachmentUrl(response.url);
    return response;
  }
}

/** Staged files are private and must be removed with cleanup after the request finishes. */
export async function stageDiscordAttachments(
  attachments: unknown[],
  options: DiscordAttachmentOptions,
): Promise<DiscordAttachmentStage> {
  // Every presented entry consumes the limit, including duplicates and entries
  // that would later fail metadata validation. Overflow rejects the whole input.
  if (!Array.isArray(attachments) || attachments.length > MAX_ARTIFACTS) throw new Error("Invalid Discord attachment count");
  const validated: Attachment[] = [];
  let declaredTotal = 0;
  for (const value of attachments) {
    if (!value || typeof value !== "object") throw new Error("Invalid Discord attachment");
    const item = value as Record<string, unknown>;
    if (typeof item.filename !== "string" || !item.filename || typeof item.url !== "string" ||
        !Number.isSafeInteger(item.size) || (item.size as number) < 0 || (item.size as number) > MAX_FILE_BYTES) {
      throw new Error("Invalid Discord attachment metadata");
    }
    const url = validateDiscordAttachmentUrl(item.url);
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
        response = await fetchTrustedAttachment(item.url, options.fetchImpl ?? fetch, signal);
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
