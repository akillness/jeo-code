import { test, expect } from "bun:test";
import {
  ImageProtocol,
  detectImageProtocol,
  imagePreviewDisabled,
  getCellPixelSize,
  setCellPixelSizeForTest,
  getPngDimensions,
  getJpegDimensions,
  getGifDimensions,
  getWebpDimensions,
  getBmpDimensions,
  getImageDimensions,
  fitImageToCells,
  encodeKittyImage,
  encodeIterm2Image,
  isImageEscapeLine,
  imageCaption,
  renderInlineImage,
} from "../src/tui/terminal-image";

// Minimal-but-real per-format fixtures carrying an actual dimension header (not just
// magic bytes) — verified against each parser during development.
const PNG_1920x1080 = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,7,128,0,0,4,56,8,6,0,0,0,0,0,0,0]);
const JPEG_640x480 = new Uint8Array([255,216,255,224,0,16,74,70,73,70,0,1,1,0,0,1,0,1,0,0,255,192,0,17,8,1,224,2,128,3,1,34,0,2,17,1,3,17,1]);
const GIF_320x240 = new Uint8Array([71,73,70,56,57,97,64,1,240,0,0,0,0]);
const WEBP_800x600 = new Uint8Array([82,73,70,70,0,0,0,0,87,69,66,80,86,80,56,88,10,0,0,0,0,0,0,0,31,3,0,87,2,0]);
const BMP_100x50 = new Uint8Array([66,77,0,0,0,0,0,0,0,0,0,0,0,0,40,0,0,0,100,0,0,0,50,0,0,0]);
const PNG_B64 = Buffer.from(PNG_1920x1080).toString("base64");

test("detectImageProtocol: JEO_NO_IMAGE_PREVIEW disables regardless of terminal signals", () => {
  expect(detectImageProtocol({ JEO_NO_IMAGE_PREVIEW: "1", KITTY_WINDOW_ID: "1" }, true)).toBe(ImageProtocol.None);
  expect(imagePreviewDisabled({ JEO_NO_IMAGE_PREVIEW: "1" })).toBe(true);
  expect(imagePreviewDisabled({ JEO_NO_IMAGE_PREVIEW: "0" })).toBe(false);
  expect(imagePreviewDisabled({})).toBe(false);
});

test("detectImageProtocol: JEO_IMAGE_PROTOCOL forces a protocol over auto-detection", () => {
  expect(detectImageProtocol({ JEO_IMAGE_PROTOCOL: "kitty" }, false)).toBe(ImageProtocol.Kitty);
  expect(detectImageProtocol({ JEO_IMAGE_PROTOCOL: "iterm2" }, false)).toBe(ImageProtocol.Iterm2);
  expect(detectImageProtocol({ JEO_IMAGE_PROTOCOL: "iterm" }, false)).toBe(ImageProtocol.Iterm2);
  expect(detectImageProtocol({ JEO_IMAGE_PROTOCOL: "none", KITTY_WINDOW_ID: "1" }, true)).toBe(ImageProtocol.None);
  // Unrecognized value falls through to detection instead of silently disabling.
  expect(detectImageProtocol({ JEO_IMAGE_PROTOCOL: "bogus", KITTY_WINDOW_ID: "1" }, true)).toBe(ImageProtocol.Kitty);
});

test("detectImageProtocol: non-TTY always resolves to None (no forced/disabled override)", () => {
  expect(detectImageProtocol({ KITTY_WINDOW_ID: "1" }, false)).toBe(ImageProtocol.None);
  expect(detectImageProtocol({}, false)).toBe(ImageProtocol.None);
});

test("detectImageProtocol: recognizes kitty, ghostty, wezterm (all kitty-protocol) and iTerm2 by env signal", () => {
  expect(detectImageProtocol({ KITTY_WINDOW_ID: "1" }, true)).toBe(ImageProtocol.Kitty);
  expect(detectImageProtocol({ GHOSTTY_RESOURCES_DIR: "/x" }, true)).toBe(ImageProtocol.Kitty);
  expect(detectImageProtocol({ WEZTERM_PANE: "0" }, true)).toBe(ImageProtocol.Kitty);
  expect(detectImageProtocol({ ITERM_SESSION_ID: "w0t0p0" }, true)).toBe(ImageProtocol.Iterm2);
  expect(detectImageProtocol({ TERM_PROGRAM: "iTerm.app" }, true)).toBe(ImageProtocol.Iterm2);
  expect(detectImageProtocol({ TERM_PROGRAM: "WezTerm" }, true)).toBe(ImageProtocol.Kitty);
  expect(detectImageProtocol({ TERM_PROGRAM: "ghostty" }, true)).toBe(ImageProtocol.Kitty);
});

test("detectImageProtocol: falls back to $TERM sniffing for tmux/screen-wrapped kitty sessions", () => {
  expect(detectImageProtocol({ TERM: "xterm-kitty" }, true)).toBe(ImageProtocol.Kitty);
  expect(detectImageProtocol({ TERM: "tmux-256color", KITTY_LISTEN_ON: "unix:@x" }, true)).toBe(ImageProtocol.Kitty);
  expect(detectImageProtocol({ TERM: "screen", KITTY_LISTEN_ON: "unix:@x" }, true)).toBe(ImageProtocol.Kitty);
  // Plain tmux/screen with no kitty signal at all -> unsupported (Terminal.app, etc.)
  expect(detectImageProtocol({ TERM: "tmux-256color" }, true)).toBe(ImageProtocol.None);
});

test("detectImageProtocol: unrecognized terminal (Terminal.app, plain xterm) resolves to None", () => {
  expect(detectImageProtocol({ TERM_PROGRAM: "Apple_Terminal" }, true)).toBe(ImageProtocol.None);
  expect(detectImageProtocol({ TERM: "xterm-256color" }, true)).toBe(ImageProtocol.None);
});

test("getCellPixelSize: defaults to 9x18, overridable via env, and via test setter", () => {
  expect(getCellPixelSize({})).toEqual({ widthPx: 9, heightPx: 18 });
  expect(getCellPixelSize({ JEO_CELL_WIDTH_PX: "10", JEO_CELL_HEIGHT_PX: "20" })).toEqual({ widthPx: 10, heightPx: 20 });
  expect(getCellPixelSize({ JEO_CELL_WIDTH_PX: "not-a-number" })).toEqual({ widthPx: 9, heightPx: 18 });
  setCellPixelSizeForTest({ widthPx: 1, heightPx: 1 });
  expect(getCellPixelSize({ JEO_CELL_WIDTH_PX: "99" })).toEqual({ widthPx: 1, heightPx: 1 }); // override wins over env
  setCellPixelSizeForTest(undefined);
  expect(getCellPixelSize({})).toEqual({ widthPx: 9, heightPx: 18 }); // cleared
});

test("dimension parsers: read real width/height from each supported format's header", () => {
  expect(getPngDimensions(PNG_1920x1080)).toEqual({ widthPx: 1920, heightPx: 1080 });
  expect(getJpegDimensions(JPEG_640x480)).toEqual({ widthPx: 640, heightPx: 480 });
  expect(getGifDimensions(GIF_320x240)).toEqual({ widthPx: 320, heightPx: 240 });
  expect(getWebpDimensions(WEBP_800x600)).toEqual({ widthPx: 800, heightPx: 600 });
  expect(getBmpDimensions(BMP_100x50)).toEqual({ widthPx: 100, heightPx: 50 });
});

test("dimension parsers: reject too-short or wrong-signature bytes instead of reading garbage", () => {
  expect(getPngDimensions(new Uint8Array([0x89, 0x50]))).toBeNull();
  expect(getPngDimensions(new Uint8Array(24).fill(0))).toBeNull(); // right length, wrong signature
  expect(getJpegDimensions(new Uint8Array([0, 0]))).toBeNull();
  expect(getGifDimensions(new Uint8Array([0x47, 0x49, 0x46, 0x37, 0x37, 0x61, 0, 0, 0, 0]))).toBeNull(); // "GIF77a"
  expect(getWebpDimensions(new Uint8Array(30))).toBeNull(); // zeroed, no RIFF/WEBP signature
  expect(getBmpDimensions(new Uint8Array([0x42, 0x4d]))).toBeNull(); // too short for a header
});

test("getImageDimensions: dispatches by IANA media type and returns null for unknown types", () => {
  expect(getImageDimensions(PNG_1920x1080, "image/png")).toEqual({ widthPx: 1920, heightPx: 1080 });
  expect(getImageDimensions(JPEG_640x480, "image/jpeg")).toEqual({ widthPx: 640, heightPx: 480 });
  expect(getImageDimensions(GIF_320x240, "image/gif")).toEqual({ widthPx: 320, heightPx: 240 });
  expect(getImageDimensions(WEBP_800x600, "image/webp")).toEqual({ widthPx: 800, heightPx: 600 });
  expect(getImageDimensions(BMP_100x50, "image/bmp")).toEqual({ widthPx: 100, heightPx: 50 });
  expect(getImageDimensions(PNG_1920x1080, "application/pdf")).toBeNull();
});

test("fitImageToCells: scales down preserving aspect ratio, never upscales, clamps to the box", () => {
  const cell = { widthPx: 9, heightPx: 18 };
  // 1920x1080 (16:9) into 60x20 cells: width-bound (0.28125 < 0.3333) -> columns=60, rows=17
  expect(fitImageToCells({ widthPx: 1920, heightPx: 1080 }, 60, 20, cell)).toEqual({ columns: 60, rows: 17 });
  // A 10x10 image easily fits in 60x20 cells (90x90px < 540x360px) -> never upscaled past its 1:1 cell footprint
  expect(fitImageToCells({ widthPx: 10, heightPx: 10 }, 60, 20, cell)).toEqual({ columns: 1, rows: 1 });
  // Unknown dimensions (parser miss) fall back to filling the whole box instead of crashing
  expect(fitImageToCells(null, 60, 20, cell)).toEqual({ columns: 60, rows: 20 });
  // Zero/negative reported dimensions treated the same as unknown
  expect(fitImageToCells({ widthPx: 0, heightPx: 100 }, 60, 20, cell)).toEqual({ columns: 60, rows: 20 });
});

test("encodeKittyImage: single-chunk payload under 4096 bytes emits one APC sequence", () => {
  const seq = encodeKittyImage("QQ==", { columns: 5, rows: 3 });
  expect(seq).toBe("\x1b_Ga=T,f=100,q=2,c=5,r=3;QQ==\x1b\\");
});

test("encodeKittyImage: payload over 4096 base64 bytes splits into m=1...m=0 chunks", () => {
  const big = "A".repeat(5000);
  const seq = encodeKittyImage(big, { columns: 10, rows: 5 });
  expect((seq.match(/\x1b_G/g) ?? []).length).toBe(2); // exactly 2 APC transmissions for a 5000-byte payload at 4096/chunk
  expect(seq).toContain("m=1"); // first chunk continues
  expect(seq).toContain("m=0"); // final chunk terminates
  expect(seq.startsWith("\x1b_Ga=T,f=100,q=2,c=10,r=5,m=1;")).toBe(true); // params only on the FIRST chunk
});

test("encodeIterm2Image: cell-based width/height (never 'auto') so jeo's fit math matches the terminal's render", () => {
  const seq = encodeIterm2Image("QQ==", { columns: 5, rows: 3 }, "shot.png");
  expect(seq).toContain("width=5");
  expect(seq).toContain("height=3");
  expect(seq).toContain("inline=1");
  expect(seq.startsWith("\x1b]1337;File=")).toBe(true);
  expect(seq.endsWith(":QQ==\x07")).toBe(true);
  expect(seq).toContain(`name=${Buffer.from("shot.png").toString("base64")}`);
});

test("isImageEscapeLine: detects both protocols (with or without a leading cursor-move prefix), never plain text or SGR color", () => {
  const kittySeq = encodeKittyImage("QQ==", { columns: 5, rows: 3 });
  const iterm2Seq = encodeIterm2Image("QQ==", { columns: 5, rows: 3 });
  expect(isImageEscapeLine(kittySeq)).toBe(true);
  expect(isImageEscapeLine(iterm2Seq)).toBe(true);
  expect(isImageEscapeLine("\x1b[2A" + kittySeq)).toBe(true); // renderInlineImage's leading cursorUp prefix
  expect(isImageEscapeLine("hello world")).toBe(false);
  expect(isImageEscapeLine("\x1b[31mred\x1b[0m")).toBe(false);
  expect(isImageEscapeLine("")).toBe(false);
});

test("imageCaption: formats filename, media type, and dimensions when available", () => {
  expect(imageCaption("image/png", { widthPx: 1920, heightPx: 1080 }, "screenshot.png")).toBe("⧉ screenshot.png [image/png] 1920x1080");
  expect(imageCaption("image/png", { widthPx: 1920, heightPx: 1080 })).toBe("⧉ [image/png] 1920x1080");
  expect(imageCaption("image/jpeg", null)).toBe("⧉ [image/jpeg]");
});

test("renderInlineImage: ImageProtocol.None always falls back to a 1-line caption", () => {
  const result = renderInlineImage({ mediaType: "image/png", data: PNG_B64 }, ImageProtocol.None, { maxColumns: 60, maxRows: 20 });
  expect(result.rendered).toBe(false);
  expect(result.lines).toEqual(["⧉ [image/png] 1920x1080"]);
});

test("renderInlineImage: Kitty rejects non-PNG (f=100 decodes PNG only) and falls back to a caption", () => {
  const jpegB64 = Buffer.from(JPEG_640x480).toString("base64");
  const result = renderInlineImage({ mediaType: "image/jpeg", data: jpegB64 }, ImageProtocol.Kitty, { maxColumns: 60, maxRows: 20 });
  expect(result.rendered).toBe(false);
  expect(result.lines).toEqual(["⧉ [image/jpeg] 640x480"]);
});

test("renderInlineImage: iTerm2 accepts JPEG (decodes any host-native format)", () => {
  const jpegB64 = Buffer.from(JPEG_640x480).toString("base64");
  const result = renderInlineImage({ mediaType: "image/jpeg", data: jpegB64 }, ImageProtocol.Iterm2, { maxColumns: 60, maxRows: 20 });
  expect(result.rendered).toBe(true);
  expect(result.lines[result.lines.length - 1]).toContain("\x1b]1337;File=");
});

test("renderInlineImage: an undecodable header (no format parser matched) falls back to caption for any protocol", () => {
  const garbage = Buffer.from(new Uint8Array([1, 2, 3, 4])).toString("base64");
  const result = renderInlineImage({ mediaType: "image/png", data: garbage }, ImageProtocol.Kitty, { maxColumns: 60, maxRows: 20 });
  expect(result.rendered).toBe(false);
  expect(result.lines).toEqual(["⧉ [image/png]"]); // no dimensions available
});

test("renderInlineImage: row bookkeeping — lines.length equals the image's terminal-row footprint for a multi-row fit", () => {
  // 1920x1080 into 10x3 cells @ 9x18px -> columns=10, rows=3 (verified against fitImageToCells above with the same box)
  const kitty = renderInlineImage({ mediaType: "image/png", data: PNG_B64 }, ImageProtocol.Kitty, { maxColumns: 10, maxRows: 3 });
  expect(kitty.rendered).toBe(true);
  expect(kitty.lines).toHaveLength(3);
  expect(kitty.lines[0]).toBe("");
  expect(kitty.lines[1]).toBe("");
  expect(kitty.lines[2]).toContain("\x1b[2A"); // rewind to the reserved block's top row before drawing
  expect(kitty.lines[2]).toContain("\x1b_G");
  expect(kitty.lines[2].endsWith("\x1b\\")).toBe(true); // APC terminator is the true last byte — no trailing correction for Kitty

  const iterm2 = renderInlineImage({ mediaType: "image/png", data: PNG_B64 }, ImageProtocol.Iterm2, { maxColumns: 10, maxRows: 3 });
  expect(iterm2.rendered).toBe(true);
  expect(iterm2.lines).toHaveLength(3);
  expect(iterm2.lines[2]).toContain("\x1b[2A");
  // iTerm2 auto-advances one row PAST the image; a synthetic cursorUp(1) cancels
  // that so both protocols leave the cursor at the same net offset (see the
  // function's doc comment in terminal-image.ts for the full row-math proof).
  expect(iterm2.lines[2].endsWith("\x1b[1A")).toBe(true);
});

test("renderInlineImage: a single-row fit needs no blank reservation or rewind", () => {
  const result = renderInlineImage({ mediaType: "image/png", data: PNG_B64 }, ImageProtocol.Kitty, { maxColumns: 1, maxRows: 1 });
  expect(result.rendered).toBe(true);
  expect(result.lines).toHaveLength(1);
  expect(result.lines[0]).not.toContain("\x1b["); // no cursorUp(0) noise — cursorUp(0) is the empty string
  expect(result.lines[0]).toContain("\x1b_G");
});
