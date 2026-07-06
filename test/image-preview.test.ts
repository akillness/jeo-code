import { test, expect } from "bun:test";
import { renderImageAttachments } from "../src/tui/components/image-preview";
import { ImageProtocol } from "../src/tui/terminal-image";
import type { ImageAttachment } from "../src/ai/types";

const PNG_1920x1080 = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,7,128,0,0,4,56,8,6,0,0,0,0,0,0,0]);
const JPEG_640x480 = new Uint8Array([255,216,255,224,0,16,74,70,73,70,0,1,1,0,0,1,0,1,0,0,255,192,0,17,8,1,224,2,128,3,1,34,0,2,17,1,3,17,1]);
const png: ImageAttachment = { mediaType: "image/png", data: Buffer.from(PNG_1920x1080).toString("base64") };
const jpeg: ImageAttachment = { mediaType: "image/jpeg", data: Buffer.from(JPEG_640x480).toString("base64") };

test("renderImageAttachments: empty input returns no lines", () => {
  expect(renderImageAttachments([], { cols: 80 })).toEqual([]);
});

test("renderImageAttachments: unsupported protocol renders every attachment as a muted caption", () => {
  const muted = (s: string) => `[MUTED]${s}[/MUTED]`;
  const lines = renderImageAttachments([png], { cols: 80, protocol: ImageProtocol.None, muted });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toBe("[MUTED]⧉ [image/png] 1920x1080[/MUTED]");
});

test("renderImageAttachments: Kitty protocol renders a real PNG inline (not a caption)", () => {
  const lines = renderImageAttachments([png], { cols: 80, protocol: ImageProtocol.Kitty });
  // At least the last line carries the kitty APC image sequence.
  expect(lines.some(l => l.includes("\x1b_G"))).toBe(true);
  expect(lines.some(l => l.includes("⧉"))).toBe(false); // no caption text when it rendered
});

test("renderImageAttachments: Kitty protocol falls back to a caption for a non-PNG attachment", () => {
  const muted = (s: string) => `<${s}>`;
  const lines = renderImageAttachments([jpeg], { cols: 80, protocol: ImageProtocol.Kitty, muted });
  expect(lines).toEqual(["<⧉ [image/jpeg] 640x480>"]);
});

test("renderImageAttachments: iTerm2 protocol renders both PNG and JPEG inline", () => {
  const linesPng = renderImageAttachments([png], { cols: 80, protocol: ImageProtocol.Iterm2 });
  const linesJpeg = renderImageAttachments([jpeg], { cols: 80, protocol: ImageProtocol.Iterm2 });
  expect(linesPng.some(l => l.includes("\x1b]1337;File="))).toBe(true);
  expect(linesJpeg.some(l => l.includes("\x1b]1337;File="))).toBe(true);
});

test("renderImageAttachments: multiple attachments stack — each keeps its own row block", () => {
  const lines = renderImageAttachments([png, jpeg], { cols: 80, protocol: ImageProtocol.Iterm2 });
  const imageLines = lines.filter(l => l.includes("\x1b]1337;File="));
  expect(imageLines).toHaveLength(2); // one image escape row per attachment
});

test("renderImageAttachments: mixed support — a PNG renders inline while a JPEG on Kitty falls back, in the same call", () => {
  const muted = (s: string) => s;
  const lines = renderImageAttachments([png, jpeg], { cols: 80, protocol: ImageProtocol.Kitty, muted });
  expect(lines.some(l => l.includes("\x1b_G"))).toBe(true); // the PNG rendered
  expect(lines.some(l => l.includes("⧉ [image/jpeg]"))).toBe(true); // the JPEG fell back to caption
});

test("renderImageAttachments: maxColumns is derived from cols, clamped to [10,60], leaving margin", () => {
  // A very narrow terminal still gets a usable minimum box instead of crashing/degenerating.
  const narrow = renderImageAttachments([png], { cols: 5, protocol: ImageProtocol.Kitty });
  expect(narrow.some(l => l.includes("\x1b_G"))).toBe(true);
  expect(narrow.some(l => l.includes("c=10"))).toBe(true); // clamped to the 10-column floor
});

test("renderImageAttachments: default protocol resolution defers to detectImageProtocol (env/TTY) when not overridden", () => {
  // No protocol override + no TTY signal in a test process -> None -> caption, never throws.
  const lines = renderImageAttachments([png], { cols: 80 });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("⧉");
});
