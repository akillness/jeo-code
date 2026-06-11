/**
 * Cross-platform clipboard IMAGE reader for the REPL's Ctrl+V image paste.
 *
 * Terminals only deliver *text* paste through stdin, so pasting a copied
 * image (screenshot, browser right-click copy, …) needs an explicit OS
 * clipboard query. Strategy per platform, all via short-lived subprocesses:
 *  - macOS: `pngpaste -` when installed (fast), else an `osascript` fallback
 *    that writes the clipboard's «class PNGf» data to a temp file.
 *  - Linux: `wl-paste -t image/png` (Wayland), else `xclip -t image/png -o` (X11).
 *  - Windows: PowerShell `[Windows.Forms.Clipboard]::GetImage()` → temp PNG.
 *
 * Returns null when the clipboard holds no image (or no tool is available) —
 * callers treat null as "not an image paste" and fall through silently.
 */
import * as os from "node:os";
import * as path from "node:path";
import { unlink, readFile } from "node:fs/promises";
import type { ImageAttachment } from "../ai/types";

/** PNG magic bytes — every backend below produces PNG. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

export function looksLikePng(buf: Uint8Array): boolean {
  return buf.length > 8 && Buffer.from(buf.slice(0, 4)).equals(PNG_MAGIC);
}

/** Build the attachment from raw image bytes; null when the bytes are not a PNG. */
export function attachmentFromBytes(bytes: Uint8Array): ImageAttachment | null {
  if (!looksLikePng(bytes)) return null;
  return { mediaType: "image/png", data: Buffer.from(bytes).toString("base64") };
}

async function runCapture(cmd: string[], timeoutMs = 4000): Promise<Uint8Array | null> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    const code = await proc.exited;
    clearTimeout(timer);
    return code === 0 && bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

async function macClipboardImage(): Promise<Uint8Array | null> {
  // Fast path: pngpaste (brew install pngpaste) streams PNG to stdout.
  if (Bun.which("pngpaste")) {
    const bytes = await runCapture(["pngpaste", "-"]);
    if (bytes) return bytes;
  }
  if (!Bun.which("osascript")) return null;
  // Fallback: AppleScript writes «class PNGf» clipboard data to a temp file.
  const tmp = path.join(os.tmpdir(), `jeo-paste-${Date.now()}-${process.pid}.png`);
  const script =
    `set pngData to the clipboard as «class PNGf»\n` +
    `set f to open for access POSIX file ${JSON.stringify(tmp)} with write permission\n` +
    `write pngData to f\nclose access f`;
  try {
    const proc = Bun.spawn(["osascript", "-e", script], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), 4000);
    const code = await proc.exited;
    clearTimeout(timer);
    if (code !== 0) return null;
    return new Uint8Array(await readFile(tmp));
  } catch {
    return null;
  } finally {
    unlink(tmp).catch(() => {});
  }
}

async function linuxClipboardImage(): Promise<Uint8Array | null> {
  if (process.env.WAYLAND_DISPLAY && Bun.which("wl-paste")) {
    const bytes = await runCapture(["wl-paste", "-t", "image/png"]);
    if (bytes) return bytes;
  }
  if (Bun.which("xclip")) {
    return runCapture(["xclip", "-selection", "clipboard", "-t", "image/png", "-o"]);
  }
  return null;
}

async function windowsClipboardImage(): Promise<Uint8Array | null> {
  if (!Bun.which("powershell.exe") && !Bun.which("powershell")) return null;
  const tmp = path.join(os.tmpdir(), `jeo-paste-${Date.now()}-${process.pid}.png`);
  const ps =
    `Add-Type -AssemblyName System.Windows.Forms; ` +
    `$img = [System.Windows.Forms.Clipboard]::GetImage(); ` +
    `if ($img -eq $null) { exit 1 }; ` +
    `$img.Save('${tmp.replace(/\\/g, "\\\\").replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`;
  try {
    const exe = Bun.which("powershell.exe") ? "powershell.exe" : "powershell";
    const proc = Bun.spawn([exe, "-NoProfile", "-STA", "-Command", ps], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), 6000);
    const code = await proc.exited;
    clearTimeout(timer);
    if (code !== 0) return null;
    return new Uint8Array(await readFile(tmp));
  } catch {
    return null;
  } finally {
    unlink(tmp).catch(() => {});
  }
}

/**
 * Read an image from the system clipboard, or null when none is present.
 * Never throws; never blocks longer than a few seconds.
 */
export async function readClipboardImage(): Promise<ImageAttachment | null> {
  const bytes =
    process.platform === "darwin" ? await macClipboardImage()
    : process.platform === "win32" ? await windowsClipboardImage()
    : await linuxClipboardImage();
  if (!bytes) return null;
  return attachmentFromBytes(bytes);
}
