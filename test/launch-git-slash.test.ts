import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleUndoSlash } from "../src/commands/launch/git-slash";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jeo-gitslash-"));
}

function initRepo(dir: string): (...a: string[]) => void {
  const run = (...a: string[]) => Bun.spawnSync(a, { cwd: dir, stdout: "pipe", stderr: "pipe" });
  run("git", "init", "-q");
  run("git", "config", "user.email", "t@t.t");
  run("git", "config", "user.name", "t");
  run("git", "config", "commit.gpgsign", "false");
  return run;
}

test("handleUndoSlash: non-git directory reports it could not read the log", () => {
  const lines = handleUndoSlash(tmpDir());
  expect(lines).toEqual(["! undo failed: could not read git log (not a git repo?)"]);
});

test("handleUndoSlash: refuses to revert a commit jeo did not author", () => {
  const dir = tmpDir();
  const run = initRepo(dir);
  fs.writeFileSync(path.join(dir, "f.txt"), "one\n");
  run("git", "add", "-A");
  run("git", "commit", "-qm", "human commit");

  const lines = handleUndoSlash(dir);
  expect(lines).toEqual([
    "! the last commit was not made by jeo (no '[jeo] auto-commit:' prefix). Use git manually to revert.",
  ]);
  // working tree + commit untouched
  expect(fs.existsSync(path.join(dir, "f.txt"))).toBe(true);
});

test("handleUndoSlash: reverts a jeo auto-commit and restores the prior tree", () => {
  const dir = tmpDir();
  const run = initRepo(dir);
  fs.writeFileSync(path.join(dir, "f.txt"), "base\n");
  run("git", "add", "-A");
  run("git", "commit", "-qm", "base");
  // jeo-authored follow-up commit that adds a file
  fs.writeFileSync(path.join(dir, "g.txt"), "added by jeo\n");
  run("git", "add", "-A");
  run("git", "commit", "-qm", "[jeo] auto-commit: tweak");

  expect(fs.existsSync(path.join(dir, "g.txt"))).toBe(true);
  const lines = handleUndoSlash(dir);
  expect(lines).toEqual(["(undid the last jeo auto-commit and restored the working tree)"]);
  // hard reset rolled the working tree back to the base commit
  expect(fs.existsSync(path.join(dir, "g.txt"))).toBe(false);
  const head = Bun.spawnSync(["git", "log", "-1", "--pretty=%s"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  expect(head.stdout.toString().trim()).toBe("base");
});
