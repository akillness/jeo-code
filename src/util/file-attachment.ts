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
import * as os from "node:os";
import * as path from "node:path";
import { readFile, stat } from "node:fs/promises";
import type { ImageAttachment } from "../ai/types";

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp)$/i;

/** Reject a dropped/pasted image path bigger than this before reading it fully into
 *  memory (gjc parity, #2658's "source size" bound in spirit — a scoped-down version
 *  for jeo's simpler single-read attach path, not the full symlink/TOCTOU/consent
 *  hardening that PR added for a materially different threat model: gjc validates
 *  arbitrary bracketed-paste text that may originate from an untrusted clipboard
 *  source, while this reads a path the user directly typed/dropped into their own
 *  composer). Without a cap, a stray path to a multi-GB file — a typo, or a dropped
 *  huge video misidentified by extension — would be read ENTIRELY into memory before
 *  the magic-byte check below ever gets to reject it. 25 MiB comfortably covers any
 *  real photo/screenshot while bounding the worst case. */
export const MAX_ATTACH_IMAGE_BYTES = 25 * 1024 * 1024;


/**
 * Normalize the whitespace around every `[image #N]` tag to a single space:
 *  - one space before a tag that follows other text (none at line start),
 *  - one space after a tag that is followed by more text,
 *  - any run of spaces/tabs collapsed to one, and the whole string trimmed.
 *
 * A tag at the very end keeps NO trailing space (callers that want the caret to sit
 * past it add exactly one). Terminals pad a dragged-and-dropped path with their own
 * spacing and the Ctrl+V insert adds a separator, so without this the caret parks
 * several columns past the tag — the "input point looks pushed by a few spaces" bug.
 * Idempotent: re-normalizing already-clean text is a no-op.
 */
export function normalizeImageTags(text: string): string {
  return text
    .replace(/[ \t]*(\[image #\d+\])[ \t]*/g, (m, tag: string, off: number, s: string) =>
      (off > 0 ? " " : "") + tag + (off + m.length < s.length ? " " : ""),
    )
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Caret offset just past the `[image #n]` tag in `text` (and its single trailing
 *  space when present); falls back to end-of-text when the tag is absent. */
export function caretAfterTag(text: string, n: number): number {
  const tag = `[image #${n}]`;
  const idx = text.indexOf(tag);
  if (idx < 0) return text.length;
  let end = idx + tag.length;
  if (text[end] === " ") end += 1; // sit after the separating space, not on it
  return end;
}

/**
 * Insert an `[image #n]` tag at `cursor` within `line` (the Ctrl+V clipboard-image
 * path), normalizing surrounding whitespace so the tag is flanked by exactly one
 * space. A tag landing at end-of-line gets one trailing space so the user can keep
 * typing; the returned caret sits right after the tag (and that space).
 */
export function insertImageTag(line: string, cursor: number, n: number): { text: string; cursor: number } {
  const at = Math.max(0, Math.min(cursor, line.length));
  const tag = `[image #${n}]`;
  let text = normalizeImageTags(line.slice(0, at) + tag + line.slice(at));
  const idx = text.indexOf(tag);
  if (idx >= 0 && idx + tag.length >= text.length) text += " "; // trailing space at EOL for typing
  return { text, cursor: caretAfterTag(text, n) };
}

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
 *  - resolves a `file://` URI (with percent-decoding),
 *  - expands a leading `~` / `~/` to the home directory (gjc parity: a TYPED or
 *    shell-copied `~/Downloads/shot.png` is a real, attachable path — without this it
 *    silently failed to resolve and the raw text was sent to the model instead).
 * Returns the cleaned path.
 */
export function decodeDroppedPath(token: string, home: string = os.homedir()): string {
  let s = token.trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return expandHomePath(s.slice(1, -1), home);
  }
  if (s.startsWith("file://")) {
    let rest = s.slice("file://".length);
    // file://host/path — drop an (almost always empty / "localhost") authority.
    if (rest.startsWith("/") === false && rest.includes("/")) rest = rest.slice(rest.indexOf("/"));
    try { return decodeURIComponent(rest); } catch { return rest; }
  }
  // Bare token: unescape `\<char>` (shell-style drag escaping).
  return expandHomePath(s.replace(/\\(.)/g, "$1"), home);
}

/** `~` / `~/rest` → the home directory. A bare `~user` form is left alone (jeo cannot
 *  resolve another account's home portably). */
function expandHomePath(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
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
    const st = await stat(p);
    if (!st.isFile() || st.size > MAX_ATTACH_IMAGE_BYTES) return null;
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
  /** Caret offset to park after the swap: just past the trailing space of the LAST
   *  inserted tag (so the live box places the cursor right after the attachment,
   *  ready for the user's prompt). Equals `text.length` when nothing was attached. */
  cursor: number;
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
  if (tokens.length === 0) return { text, images: [], cursor: text.length };

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
  if (images.length === 0) return { text: out, images, cursor: out.length };
  // Collapse the spacing terminals add around a dropped path so the swapped-in tag
  // (and the caret parked after it) is not pushed several columns to the right, then
  // guarantee EXACTLY ONE trailing space when the last tag ends the draft — identical
  // to `insertImageTag`'s Ctrl+V contract. Without it `normalizeImageTags`'s trim left
  // the caret hard against `]` and the next typed word glued onto the tag
  // ("[image #1]please"); with it, both attach paths behave the same.
  let normalized = normalizeImageTags(out);
  const lastTag = `[image #${n - 1}]`;
  const lastIdx = normalized.indexOf(lastTag);
  if (lastIdx >= 0 && lastIdx + lastTag.length >= normalized.length) normalized += " ";
  return { text: normalized, images, cursor: caretAfterTag(normalized, n - 1) };
}
