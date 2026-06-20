/**
 * File ATTACHMENT support for the REPL input box.
 *
 * Terminals deliver a dragged-and-dropped file as *text* on stdin: the emulator
 * inserts the file's path (often shell-quoted or with backslash-escaped spaces)
 * at the caret, exactly as if the user typed it. So "attach a file by dropping it
 * into the box" reduces to: recognise an image path inside the submitted text,
 * read the bytes, and turn it into an {@link ImageAttachment} — replacing the raw
 * path token with the same `[image #N]` tag the Ctrl+V clipboard path uses, so the
 * model receives one consistent reference scheme regardless of how the image got
 * attached.
 *
 * Only paths with a known image extension are considered, so ordinary prose is
 * never mistaken for a file. Non-image / unreadable paths are left untouched.
 */
import { readFile } from "node:fs/promises";
import type { ImageAttachment } from "../ai/types";

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp)$/i;

/** Detect an image media type from magic bytes, or null when the bytes are not a
 *  recognised image. Used as the authoritative check (extension only gates the
 *  candidate scan; the bytes decide). */
export function imageMediaTypeFromBytes(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return "image/webp";
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  return null;
}

/** Build an {@link ImageAttachment} from raw image bytes, or null when the bytes
 *  are not a recognised image format. */
export function attachmentFromImageBytes(bytes: Uint8Array): ImageAttachment | null {
  const mediaType = imageMediaTypeFromBytes(bytes);
  if (!mediaType) return null;
  return { mediaType, data: Buffer.from(bytes).toString("base64") };
}


/**
 * Decode one drag-and-drop path token into a usable filesystem path:
 *  - strips matching single/double quotes,
 *  - unescapes backslash-escaped characters (macOS escapes spaces as `\ `),
 *  - resolves a `file://` URI (with percent-decoding).
 * Returns the cleaned path.
 */
export function decodeDroppedPath(token: string): string {
  let s = token.trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  if (s.startsWith("file://")) {
    let rest = s.slice("file://".length);
    // file://host/path — drop an (almost always empty / "localhost") authority.
    if (rest.startsWith("/") === false && rest.includes("/")) rest = rest.slice(rest.indexOf("/"));
    try { return decodeURIComponent(rest); } catch { return rest; }
  }
  // Bare token: unescape `\<char>` (shell-style drag escaping).
  return s.replace(/\\(.)/g, "$1");
}

export interface PathToken {
  /** The exact substring matched in the source text (used for replacement). */
  raw: string;
  /** The decoded filesystem path. */
  path: string;
  start: number;
  end: number;
}

/**
 * Scan `text` for image-file path tokens (quoted, `file://`, or bare with
 * backslash-escaped spaces). Only tokens whose decoded path ends in a known image
 * extension are returned, so normal prose never matches. Tokens are returned in
 * source order with their `[start, end)` offsets for in-place replacement.
 */
export function findImagePathTokens(text: string): PathToken[] {
  const tokens: PathToken[] = [];
  // Order matters: quoted forms first (so an inner space is kept), then file://
  // URIs, then a bare run that allows backslash-escaped characters.
  const re = /'[^']*'|"[^"]*"|file:\/\/\S+|(?:\\.|\S)+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const decoded = decodeDroppedPath(raw);
    if (IMAGE_EXT_RE.test(decoded)) {
      tokens.push({ raw, path: decoded, start: m.index, end: m.index + raw.length });
    }
  }
  return tokens;
}

/** Reads a file's bytes, or null when it cannot be read. Injectable for tests. */
export type FileReader = (path: string) => Promise<Uint8Array | null>;

const defaultReader: FileReader = async (p) => {
  try {
    return new Uint8Array(await readFile(p));
  } catch {
    return null;
  }
};

export interface AttachResult {
  /** The input text with every successfully-attached image path replaced by its
   *  `[image #N]` tag; unmatched / unreadable paths are left verbatim. */
  text: string;
  /** The newly-read image attachments, in source order. */
  images: ImageAttachment[];
}

/**
 * Resolve image file paths dropped into `text` into attachments.
 *
 * @param text         the submitted input line
 * @param startNumber  the next `[image #N]` number to assign (1-based; pass
 *                     `existingImages.length + 1` so dropped files continue the
 *                     numbering started by Ctrl+V clipboard images)
 * @param read         file reader (defaults to the real filesystem)
 */
export async function attachImagePaths(
  text: string,
  startNumber = 1,
  read: FileReader = defaultReader,
): Promise<AttachResult> {
  const tokens = findImagePathTokens(text);
  if (tokens.length === 0) return { text, images: [] };

  const reads = await Promise.all(
    tokens.map(async (t) => {
      const bytes = await read(t.path);
      return bytes ? attachmentFromImageBytes(bytes) : null;
    }),
  );

  const images: ImageAttachment[] = [];
  let out = "";
  let cursor = 0;
  let n = startNumber;
  for (let i = 0; i < tokens.length; i++) {
    const att = reads[i];
    if (!att) continue; // not a real image / unreadable → leave the text as-is
    const t = tokens[i]!;
    out += text.slice(cursor, t.start) + `[image #${n}]`;
    cursor = t.end;
    images.push(att);
    n += 1;
  }
  out += text.slice(cursor);
  return { text: out, images };
}
