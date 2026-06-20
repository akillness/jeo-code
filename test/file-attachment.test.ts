import { test, expect } from "bun:test";
import {
  imageMediaTypeFromBytes,
  attachmentFromImageBytes,
  decodeDroppedPath,
  findImagePathTokens,
  attachImagePaths,
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
