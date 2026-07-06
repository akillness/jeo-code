/**
 * Inline terminal image protocols (gjc TUI-parity): detect whether the attached
 * terminal can render a real bitmap inline, and encode `ImageAttachment` bytes into
 * the matching escape sequence — Kitty graphics protocol (also implemented by
 * Ghostty and WezTerm) or iTerm2's OSC 1337 inline-image protocol. Sixel is
 * intentionally NOT implemented: producing a sixel stream from arbitrary PNG/JPEG
 * bytes needs a pixel quantizer, which would be jeo's first native/binary
 * dependency — every terminal jeo targets (kitty/ghostty/wezterm/iTerm2) already
 * speaks one of the two protocols below, so a text caption is the correct fallback
 * everywhere else (Terminal.app, most Linux console/VTE terminals, CI/non-TTY).
 *
 * Callers never need to know which protocol was chosen: {@link renderInlineImage}
 * returns either a ready-to-write escape block or `null` (caller shows the caption).
 */
// Inlined (not imported from `./terminal`) to keep this module free to be imported
// FROM `./components/width` (see `isImageEscapeLine` below) without a cycle:
// `./terminal` itself imports `truncateToWidth` from `./components/width`.
function cursorUp(n: number): string {
  return n > 0 ? `\x1b[${n}A` : "";
}

export enum ImageProtocol {
  Kitty = "kitty",
  Iterm2 = "iterm2",
  None = "none",
}

export type EnvLike = Record<string, string | undefined>;

export interface PixelDimensions {
  widthPx: number;
  heightPx: number;
}

export interface CellPixelSize {
  widthPx: number;
  heightPx: number;
}

/** `JEO_IMAGE_PROTOCOL=kitty|iterm2|none` forces the protocol regardless of
 *  detection — the escape hatch for a misdetected terminal or a multiplexer that
 *  doesn't forward `TERM_PROGRAM`. Unrecognized values are ignored (fall through
 *  to detection) rather than silently disabling images. */
function forcedProtocol(env: EnvLike): ImageProtocol | undefined {
  const raw = env.JEO_IMAGE_PROTOCOL?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "kitty") return ImageProtocol.Kitty;
  if (raw === "iterm2" || raw === "iterm") return ImageProtocol.Iterm2;
  if (raw === "none" || raw === "off" || raw === "0" || raw === "false") return ImageProtocol.None;
  return undefined;
}

/** `JEO_NO_IMAGE_PREVIEW=1` disables inline image rendering outright (same shape
 *  as `JEO_NO_MULTILINE`/`JEO_NO_MEMORY`) — every attachment falls back to its text
 *  caption. Distinct from `JEO_IMAGE_PROTOCOL=none` only in intent/discoverability;
 *  both end at {@link ImageProtocol.None}. */
export function imagePreviewDisabled(env: EnvLike = process.env): boolean {
  const v = env.JEO_NO_IMAGE_PREVIEW;
  return v === "1" || v === "true";
}

/**
 * Detect the inline-image protocol the attached terminal speaks, from environment
 * signals alone (no terminal query round-trip — keeps startup synchronous and
 * side-effect-free, matching how `detectColorLevel` works). `env`/`isTty` are
 * injectable for tests.
 */
export function detectImageProtocol(env: EnvLike = process.env, isTty = false): ImageProtocol {
  if (imagePreviewDisabled(env)) return ImageProtocol.None;
  const forced = forcedProtocol(env);
  if (forced !== undefined) return forced;
  if (!isTty) return ImageProtocol.None;

  if (env.KITTY_WINDOW_ID) return ImageProtocol.Kitty;
  if (env.GHOSTTY_RESOURCES_DIR) return ImageProtocol.Kitty; // Ghostty speaks the kitty graphics protocol
  if (env.WEZTERM_PANE) return ImageProtocol.Kitty; // WezTerm speaks the kitty graphics protocol
  if (env.ITERM_SESSION_ID) return ImageProtocol.Iterm2;

  const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
  if (termProgram === "kitty") return ImageProtocol.Kitty;
  if (termProgram === "ghostty" || termProgram === "wezterm") return ImageProtocol.Kitty;
  if (termProgram === "iterm.app") return ImageProtocol.Iterm2;

  // tmux/screen strip TERM_PROGRAM but usually preserve $TERM as "tmux-256color" /
  // "screen.xterm-kitty" etc. — fall back to sniffing $TERM for a kitty signature
  // (gjc parity: the same fallback it applies for tmux-wrapped kitty sessions).
  const term = (env.TERM ?? "").toLowerCase();
  if (term.includes("kitty")) return ImageProtocol.Kitty;
  if ((term.startsWith("tmux") || term.startsWith("screen")) && env.KITTY_LISTEN_ON) return ImageProtocol.Kitty;

  return ImageProtocol.None;
}

let cellPixelSizeOverride: CellPixelSize | undefined;

/** Cell pixel size used to convert a target column/row box into scaled pixels for
 *  the fit computation. jeo does not query the terminal for real font metrics (that
 *  needs a synchronous escape round-trip on startup, which risks hanging on a
 *  terminal that never answers) — 9x18 is the common monospace-at-default-size
 *  figure (matches gjc's default) and only affects the ASPECT-RATIO fit, not
 *  correctness: a wrong guess makes the preview a bit larger/smaller, never
 *  corrupts output. Overridable for unusually large/small fonts. */
export function getCellPixelSize(env: EnvLike = process.env): CellPixelSize {
  if (cellPixelSizeOverride) return cellPixelSizeOverride;
  const w = Number.parseInt(env.JEO_CELL_WIDTH_PX ?? "", 10);
  const h = Number.parseInt(env.JEO_CELL_HEIGHT_PX ?? "", 10);
  return {
    widthPx: Number.isFinite(w) && w > 0 ? w : 9,
    heightPx: Number.isFinite(h) && h > 0 ? h : 18,
  };
}

/** Test-only: pin the cell size so fit-math assertions don't depend on env parsing. */
export function setCellPixelSizeForTest(size: CellPixelSize | undefined): void {
  cellPixelSizeOverride = size;
}

/** PNG: 8-byte signature + 4-byte length + "IHDR" (4 bytes) precede a big-endian
 *  `{width, height}` u32 pair — the format's own spec, fixed offsets 16 and 20. */
export function getPngDimensions(bytes: Uint8Array): PixelDimensions | null {
  if (bytes.length < 24) return null;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { widthPx: buf.readUInt32BE(16), heightPx: buf.readUInt32BE(20) };
}

/** JPEG: scan markers for the first SOFn (0xC0-0xC3, 0xC5-0xC7, 0xC9-0xCB, 0xCD-0xCF —
 *  excludes 0xC4/0xC8/0xCC, which are DHT/JPG/DAC, not frame headers); height/width
 *  are big-endian u16 at offsets 5/7 into that marker's segment. */
export function getJpegDimensions(bytes: Uint8Array): PixelDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) { offset++; continue; }
    const marker = buf[offset + 1]!;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { heightPx: buf.readUInt16BE(offset + 5), widthPx: buf.readUInt16BE(offset + 7) };
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue; } // no-length markers
    const segLen = buf.readUInt16BE(offset + 2);
    if (segLen < 2) return null;
    offset += 2 + segLen;
  }
  return null;
}

/** GIF87a/89a: little-endian u16 width/height at fixed offsets 6/8 in the Logical
 *  Screen Descriptor, right after the 6-byte signature. */
export function getGifDimensions(bytes: Uint8Array): PixelDimensions | null {
  if (bytes.length < 10) return null;
  const sig = Buffer.from(bytes.slice(0, 6)).toString("ascii");
  if (sig !== "GIF87a" && sig !== "GIF89a") return null;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { widthPx: buf.readUInt16LE(6), heightPx: buf.readUInt16LE(8) };
}

/** WebP: RIFF container: dimensions live in the first sub-chunk, whose layout
 *  differs by codec — VP8 (lossy, 10-bit width/height at a fixed offset), VP8L
 *  (lossless, 14-bit packed into a little-endian u32), VP8X (extended, 24-bit
 *  little-endian triples, stored as size-1). */
export function getWebpDimensions(bytes: Uint8Array): PixelDimensions | null {
  if (bytes.length < 30) return null;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8 ") {
    return { widthPx: buf.readUInt16LE(26) & 0x3fff, heightPx: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (bytes.length < 25) return null;
    const bits = buf.readUInt32LE(21);
    return { widthPx: (bits & 0x3fff) + 1, heightPx: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    return {
      widthPx: (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)) + 1,
      heightPx: (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16)) + 1,
    };
  }
  return null;
}

/** BMP: "BM" signature, then a DIB header whose size (u32 at offset 14) picks the
 *  layout — the legacy 12-byte BITMAPCOREHEADER stores 16-bit dimensions at
 *  offset 18/20; every later header (BITMAPINFOHEADER=40 and newer) stores 32-bit
 *  signed dimensions at 18/22 (a negative height means top-down — take `abs`). */
export function getBmpDimensions(bytes: Uint8Array): PixelDimensions | null {
  if (bytes.length < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dibSize = buf.readUInt32LE(14);
  if (dibSize === 12) {
    if (bytes.length < 22) return null;
    return { widthPx: buf.readUInt16LE(18), heightPx: buf.readUInt16LE(20) };
  }
  if (bytes.length < 26) return null;
  return { widthPx: buf.readInt32LE(18), heightPx: Math.abs(buf.readInt32LE(22)) };
}

/** Dispatch to the matching parser by IANA media type; `null` when unrecognized or
 *  the bytes are too short/malformed to carry a header. */
export function getImageDimensions(bytes: Uint8Array, mediaType: string): PixelDimensions | null {
  switch (mediaType) {
    case "image/png": return getPngDimensions(bytes);
    case "image/jpeg": return getJpegDimensions(bytes);
    case "image/gif": return getGifDimensions(bytes);
    case "image/webp": return getWebpDimensions(bytes);
    case "image/bmp": return getBmpDimensions(bytes);
    default: return null;
  }
}

export interface ImageFit {
  columns: number;
  rows: number;
}

/**
 * Scale `dims` to fit within `maxColumns` x `maxRows` terminal cells, preserving
 * aspect ratio (letterboxed, never cropped/stretched). Falls back to a 1:1
 * guess (one column per ~1 cell-width of pixels) when `dims` is unknown so a
 * dimension-less image (parser miss) still gets a sane box instead of a crash.
 */
export function fitImageToCells(dims: PixelDimensions | null, maxColumns: number, maxRows: number, cell: CellPixelSize): ImageFit {
  const maxCols = Math.max(1, Math.floor(maxColumns));
  const maxRowsClamped = Math.max(1, Math.floor(maxRows));
  if (!dims || dims.widthPx <= 0 || dims.heightPx <= 0) {
    return { columns: maxCols, rows: maxRowsClamped };
  }
  const maxWidthPx = maxCols * cell.widthPx;
  const maxHeightPx = maxRowsClamped * cell.heightPx;
  const scale = Math.min(maxWidthPx / dims.widthPx, maxHeightPx / dims.heightPx, 1);
  const fittedWidthPx = dims.widthPx * scale;
  const fittedHeightPx = dims.heightPx * scale;
  return {
    columns: Math.max(1, Math.min(maxCols, Math.round(fittedWidthPx / cell.widthPx))),
    rows: Math.max(1, Math.min(maxRowsClamped, Math.ceil(fittedHeightPx / cell.heightPx))),
  };
}

const KITTY_CHUNK_SIZE = 4096;

/**
 * Encode PNG bytes (base64) as a kitty graphics protocol APC sequence, chunked at
 * 4096 base64 bytes per the spec (a payload above that MUST be split across
 * multiple `m=1`-continued transmissions, terminated by one `m=0`). `a=T`
 * (transmit-and-display in one step), `f=100` (PNG — the only compressed format
 * the protocol decodes itself), `q=2` (suppress the terminal's OK/error response,
 * which jeo never reads).
 */
export function encodeKittyImage(base64Png: string, fit: ImageFit): string {
  const params = `a=T,f=100,q=2,c=${fit.columns},r=${fit.rows}`;
  if (base64Png.length <= KITTY_CHUNK_SIZE) {
    return `\x1b_G${params};${base64Png}\x1b\\`;
  }
  const parts: string[] = [];
  for (let offset = 0; offset < base64Png.length; offset += KITTY_CHUNK_SIZE) {
    const chunk = base64Png.slice(offset, offset + KITTY_CHUNK_SIZE);
    const isFirst = offset === 0;
    const isLast = offset + KITTY_CHUNK_SIZE >= base64Png.length;
    const head = isFirst ? `${params},m=${isLast ? 0 : 1}` : `m=${isLast ? 0 : 1}`;
    parts.push(`\x1b_G${head};${chunk}\x1b\\`);
  }
  return parts.join("");
}

/**
 * Encode arbitrary image bytes (base64, any format iTerm2's host OS decodes —
 * PNG/JPEG/GIF all included) as an OSC 1337 inline-image sequence. `inline=1`
 * renders in place instead of downloading; `width`/`height` are given in CELLS
 * (not "auto") so iTerm2's own scaling always agrees with jeo's precomputed
 * {@link ImageFit} — the row-accounting in the caller depends on that agreement.
 */
export function encodeIterm2Image(base64Data: string, fit: ImageFit, name?: string): string {
  const params = [`inline=1`, `width=${fit.columns}`, `height=${fit.rows}`, "preserveAspectRatio=1"];
  if (name) params.push(`name=${Buffer.from(name).toString("base64")}`);
  return `\x1b]1337;File=${params.join(";")}:${base64Data}\x07`;
}

/** True when `line` contains an inline-image escape sequence (Kitty APC or
 *  iTerm2 OSC 1337) within its first 96 characters — a possible leading
 *  `cursorUp(...)` prefix (see {@link renderInlineImage}) means the marker is not
 *  always at offset 0. Callers that measure/truncate/wrap terminal lines by
 *  DISPLAY WIDTH (`visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi` in
 *  `components/width.ts`) MUST treat a line matching this as opaque and pass it
 *  through unchanged: the base64 payload is thousands of columns "wide" by a
 *  naive count, and slicing mid-sequence corrupts or hangs the terminal (an
 *  unterminated Kitty APC / OSC waits indefinitely for its `ESC \\` / BEL
 *  terminator). Not currently wired into `width.ts` — every current image call
 *  site (`insertAbove`) bypasses that pipeline entirely; exported so a future
 *  call site can opt in without re-deriving the detection. */
export function isImageEscapeLine(line: string): boolean {
  const head = line.slice(0, 96);
  return head.includes("\x1b_G") || head.includes("\x1b]1337;File=");
}

/** Human-readable stand-in for an attachment that can't be rendered inline
 *  (unsupported terminal, unsupported format for the detected protocol, or an
 *  undecodable dimension header). Mirrors the existing `⧉ N image(s) attached`
 *  wording style used elsewhere in the TUI. */
export function imageCaption(mediaType: string, dims: PixelDimensions | null, filename?: string): string {
  const parts = [filename, `[${mediaType}]`, dims ? `${dims.widthPx}x${dims.heightPx}` : undefined].filter(Boolean);
  return `⧉ ${parts.join(" ")}`;
}

export interface InlineImageResult {
  /** Lines to feed into `Renderer.insertAbove` (or join with "\n" for a plain
   *  `console.log`/pipe path). The array length equals the image's rendered
   *  terminal-row footprint — every element is one physical row — so a caller
   *  computing "rows written" from `lines.length` (as `insertAbove` does by
   *  splitting on "\n") gets the correct height. */
  lines: string[];
  /** True when `lines` is a real inline image; false when it is a 1-line text
   *  caption (unsupported terminal/format, or an unparsable header). */
  rendered: boolean;
}

/**
 * Build the escape sequence (or text caption) for one image attachment, sized to
 * fit `maxColumns` x `maxRows` cells.
 *
 * Row bookkeeping (why this shape, not just "the sequence + rows-1 blank lines"):
 * both protocols draw the image ANCHORED AT THE CURSOR'S ROW at the moment the
 * escape is processed and expand DOWNWARD — they do not retroactively fill rows
 * already scrolled past. So the cursor must already sit at the image's TOP row
 * before the escape is written. `lines` therefore reserves `fit.rows - 1` blank
 * rows FIRST (each later joined with "\n", which is what actually advances the
 * cursor down — matches every other multi-row block `insertAbove` is fed), then a
 * final row that rewinds the cursor back up to the reserved block's top
 * (`cursorUp(fit.rows - 1)`) immediately before the escape sequence.
 *
 * After drawing, Kitty/kitty-compatible terminals leave the REAL cursor
 * `fit.rows - 1` rows below the top (i.e. on the image's last row) — added to the
 * caller's mandatory trailing "\n" (one per `InlineImageResult`, not emitted
 * here), that lands the cursor exactly `fit.rows` rows below where it started,
 * matching a plain `fit.rows`-line block of text. iTerm2 instead auto-advances
 * PAST the image (`fit.rows` rows below the top), so a synthetic `cursorUp(1)`
 * is appended after its escape to cancel that extra row and reach the same
 * `fit.rows - 1` offset — keeping both protocols' net row math identical.
 */
export function renderInlineImage(
  attachment: { mediaType: string; data: string },
  protocol: ImageProtocol,
  opts: { maxColumns: number; maxRows: number; filename?: string } = { maxColumns: 60, maxRows: 20 },
): InlineImageResult {
  const bytes = Buffer.from(attachment.data, "base64");
  const dims = getImageDimensions(bytes, attachment.mediaType);
  const caption = () => ({ lines: [imageCaption(attachment.mediaType, dims, opts.filename)], rendered: false });

  if (protocol === ImageProtocol.None) return caption();
  if (protocol === ImageProtocol.Kitty && attachment.mediaType !== "image/png") return caption(); // f=100 decodes PNG only
  if (!dims) return caption(); // no protocol can size an image it can't measure

  const cell = getCellPixelSize();
  const fit = fitImageToCells(dims, opts.maxColumns, opts.maxRows, cell);
  const seq =
    protocol === ImageProtocol.Kitty
      ? encodeKittyImage(attachment.data, fit)
      : encodeIterm2Image(attachment.data, fit, opts.filename) + cursorUp(1); // cancel iTerm2's extra auto-advance row

  const blankRows = Math.max(0, fit.rows - 1);
  const lines = [...Array(blankRows).fill(""), cursorUp(blankRows) + seq];
  return { lines, rendered: true };
}
