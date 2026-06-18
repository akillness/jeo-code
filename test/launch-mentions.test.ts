import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { mentionPaths, currentAtLabel } from "../src/commands/launch/mentions";

function tmpTree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeo-mentions-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "src", "agent"));
  fs.writeFileSync(path.join(dir, "src", "loop.ts"), "x");
  fs.writeFileSync(path.join(dir, "README.md"), "x");
  fs.writeFileSync(path.join(dir, ".hidden"), "x");
  return dir;
}

test("mentionPaths: lists cwd children, directories first with trailing slash, hidden dropped", () => {
  const dir = tmpTree();
  try {
    const out = mentionPaths(dir, "");
    expect(out).toEqual(["src/", "README.md"]);
    expect(out).not.toContain(".hidden");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mentionPaths: trailing slash descends into a directory", () => {
  const dir = tmpTree();
  try {
    const out = mentionPaths(dir, "src/");
    expect(out).toEqual(["src/agent/", "src/loop.ts"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mentionPaths: basename fragment filters case-insensitively", () => {
  const dir = tmpTree();
  try {
    expect(mentionPaths(dir, "src/LO")).toEqual(["src/loop.ts"]);
    expect(mentionPaths(dir, "RE")).toEqual(["README.md"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mentionPaths: unreadable directory yields no matches (never throws)", () => {
  expect(mentionPaths("/no/such/place/at/all", "x")).toEqual([]);
});

test("currentAtLabel: returns the @dir label for the last mention token, undefined when none", () => {
  expect(currentAtLabel("hello world")).toBeUndefined();
  expect(currentAtLabel("see @")).toBe("@ .");
  expect(currentAtLabel("see @src/")).toBe("@ src");
  expect(currentAtLabel("see @src/loop.ts")).toBe("@ src");
  expect(currentAtLabel("@a/b @src/loop.ts")).toBe("@ src");
});
