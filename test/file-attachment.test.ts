import { test, expect } from "bun:test";
import {
  imageMediaTypeFromBytes,
  attachmentFromImageBytes,
  decodeDroppedPath,
  findImagePathTokens,
  attachImagePaths,
  normalizeImageTags,
  caretAfterTag,
  insertImageTag,
} from "../src/util/file-attachment";


const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const BMP = new Uint8Array([0x42, 0x4d, 0, 0, 0, 0]);

test("imageMediaTypeFromBytes: detects each supported format by magic bytes", () => {
  expect(imageMediaTypeFromBytes(PNG)).toBe("image/png");
  expect(imageMediaTypeFromBytes(JPEG)).toBe("image/jpeg");
  expect(imageMediaTypeFromBytes(GIF)).toBe("image/gif");
  expect(imageMediaTypeFromBytes(WEBP)).toBe("image/webp");
  expect(imageMediaTypeFromBytes(BMP)).toBe("image/bmp");
  expect(imageMediaTypeFromBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
  expect(imageMediaTypeFromBytes(new Uint8Array([0x89]))).toBeNull(); // too short for PNG magic
});

test("attachmentFromImageBytes: builds a base64 attachment or null for non-images", () => {
  expect(attachmentFromImageBytes(PNG)).toEqual({ mediaType: "image/png", data: Buffer.from(PNG).toString("base64") });
  expect(attachmentFromImageBytes(new Uint8Array([0, 1, 2, 3]))).toBeNull();
});


test("decodeDroppedPath: strips quotes, unescapes spaces, resolves file:// URIs", () => {
  expect(decodeDroppedPath("'/Users/me/My Pic.png'")).toBe("/Users/me/My Pic.png");
  expect(decodeDroppedPath('"/tmp/a b.png"')).toBe("/tmp/a b.png");
  expect(decodeDroppedPath("/Users/me/My\\ Pic.png")).toBe("/Users/me/My Pic.png");
  expect(decodeDroppedPath("file:///tmp/a%20b.png")).toBe("/tmp/a b.png");
  expect(decodeDroppedPath("file://localhost/tmp/c.png")).toBe("/tmp/c.png");
  expect(decodeDroppedPath("/plain/path.png")).toBe("/plain/path.png");
});

test("findImagePathTokens: matches only image paths, leaving prose alone", () => {
  expect(findImagePathTokens("just some words here")).toEqual([]);
  const t = findImagePathTokens("look at /tmp/shot.png please");
  expect(t).toHaveLength(1);
  expect(t[0]!.path).toBe("/tmp/shot.png");
  expect(t[0]!.raw).toBe("/tmp/shot.png");

  const quoted = findImagePathTokens("'/a b/c.jpg'");
  expect(quoted).toHaveLength(1);
  expect(quoted[0]!.path).toBe("/a b/c.jpg");

  const escaped = findImagePathTokens("/Users/me/My\\ Pic.png and text");
  expect(escaped).toHaveLength(1);
  expect(escaped[0]!.path).toBe("/Users/me/My Pic.png");
  expect(escaped[0]!.raw).toBe("/Users/me/My\\ Pic.png");

  const multi = findImagePathTokens("/a.png /b.gif");
  expect(multi.map(x => x.path)).toEqual(["/a.png", "/b.gif"]);
});

test("attachImagePaths: replaces readable image paths with [image #N] tags and collects attachments", async () => {
  const fs: Record<string, Uint8Array> = { "/tmp/a.png": PNG, "/tmp/b.jpg": JPEG };
  const read = async (p: string) => fs[p] ?? null;

  const res = await attachImagePaths("here /tmp/a.png and /tmp/b.jpg ok", 1, read);
  expect(res.text).toBe("here [image #1] and [image #2] ok");
  expect(res.images).toEqual([
    { mediaType: "image/png", data: Buffer.from(PNG).toString("base64") },
    { mediaType: "image/jpeg", data: Buffer.from(JPEG).toString("base64") },
  ]);
});

test("attachImagePaths: continues numbering from startNumber for clipboard images already attached", async () => {
  const read = async () => PNG;
  const res = await attachImagePaths("see /tmp/x.png", 3, read);
  expect(res.text).toBe("see [image #3]");
  expect(res.images).toHaveLength(1);
});

test("attachImagePaths: leaves unreadable or non-image paths untouched", async () => {
  const read = async (p: string) => (p === "/real.png" ? PNG : p === "/fake.png" ? new Uint8Array([0, 1, 2, 3]) : null);
  const res = await attachImagePaths("/missing.png /fake.png /real.png", 1, read);
  // Only the real PNG is replaced/attached; the missing + non-image paths stay verbatim.
  expect(res.text).toBe("/missing.png /fake.png [image #1]");
  expect(res.images).toHaveLength(1);
});

test("attachImagePaths: no-op when the text holds no image paths", async () => {
  const res = await attachImagePaths("just a normal message", 1, async () => PNG);
  expect(res.text).toBe("just a normal message");
  expect(res.images).toEqual([]);
});
test("normalizeImageTags: collapses stray spaces around a tag to exactly one", () => {
  // The reported bug: a dropped path / Ctrl+V insert leaves several spaces so the
  // caret looks "pushed". Multiple spaces around the tag collapse to one each.
  expect(normalizeImageTags("see   [image #1]   here")).toBe("see [image #1] here");
  expect(normalizeImageTags("a[image #1]b")).toBe("a [image #1] b");
  expect(normalizeImageTags("hello  [image #1]")).toBe("hello [image #1]");
});

test("normalizeImageTags: trims edges and adds no trailing space for an end tag", () => {
  expect(normalizeImageTags("  [image #1]  ")).toBe("[image #1]");
  expect(normalizeImageTags("see [image #3]")).toBe("see [image #3]");
});

test("normalizeImageTags: is idempotent and keeps clean multi-tag text unchanged", () => {
  const clean = "here [image #1] and [image #2] ok";
  expect(normalizeImageTags(clean)).toBe(clean);
  expect(normalizeImageTags(normalizeImageTags("a[image #1][image #2]z"))).toBe(
    normalizeImageTags("a[image #1][image #2]z"),
  );
  expect(normalizeImageTags("a[image #1][image #2]z")).toBe("a [image #1] [image #2] z");
});

test("caretAfterTag: parks just past the tag and its single trailing space", () => {
  expect(caretAfterTag("[image #1] ", 1)).toBe(11); // after the trailing space
  expect(caretAfterTag("[image #1]", 1)).toBe(10); // no trailing space → after ]
  expect(caretAfterTag("hi [image #2] there", 2)).toBe(14); // after the space before "there"
  expect(caretAfterTag("no tag here", 1)).toBe("no tag here".length); // absent → end
});

test("insertImageTag: empty box gets one trailing space, caret right after it", () => {
  const r = insertImageTag("", 0, 1);
  expect(r.text).toBe("[image #1] ");
  expect(r.cursor).toBe(11); // ready to type the prompt — NOT pushed several columns
});

test("insertImageTag: inserts mid-text with exactly one space on each side", () => {
  // caret after "abc" (index 3): "abc| def" → tag lands between, single-spaced.
  const r = insertImageTag("abc def", 3, 2);
  expect(r.text).toBe("abc [image #2] def");
  expect(r.cursor).toBe("abc [image #2] ".length); // just after the tag's separating space
});

test("insertImageTag: never accumulates spaces when the caret already sits on whitespace", () => {
  // A box already ending in a space must not yield a double space before the tag.
  const r = insertImageTag("hi ", 3, 1);
  expect(r.text).toBe("hi [image #1] ");
  expect(r.cursor).toBe("hi [image #1] ".length);
});

test("attachImagePaths: normalizes terminal-added spacing around a dropped path and reports the caret", async () => {
  const read = async (p: string) => (p === "/tmp/shot.png" ? PNG : null);
  // A terminal pads a dropped path with extra spaces; the swapped tag must not inherit them.
  const res = await attachImagePaths("look   /tmp/shot.png  ", 1, read);
  expect(res.text).toBe("look [image #1]");
  expect(res.images).toHaveLength(1);
  expect(res.cursor).toBe("look [image #1]".length); // caret right after the tag, not past stray spaces
});

test("attachImagePaths: cursor falls back to text end when nothing is attached", async () => {
  const res = await attachImagePaths("plain text", 1, async () => null);
  expect(res.cursor).toBe("plain text".length);
  const none = await attachImagePaths("no paths here", 1, async () => PNG);
  expect(none.cursor).toBe("no paths here".length);
});