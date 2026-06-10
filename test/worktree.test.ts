import { test, expect } from "bun:test";
import { dispatch } from "../src/cli/runner";
import { runLaunchCommand } from "../src/commands/launch";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const CTX = { appName: "joc", version: "9.9.9" };

function captureLog<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const original = console.log;
  let out = "";
  console.log = (...args: unknown[]) => {
    out += args.join(" ") + "\n";
  };
  return fn()
    .then(result => ({ result, out }))
    .finally(() => {
      console.log = original;
    });
}

test("dispatch routes a bare leading --flag to launch (not 'unknown command')", async () => {
  const originalCwd = process.cwd();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "joc-wt-route-"));
  try {
    process.chdir(dir);
    // `--list` is a launch flag: a leading global flag must route to launch,
    // which then prints the empty-session notice — never "Unknown command".
    const { result, out } = await captureLog(() => dispatch(["--list"], CTX));
    expect(result).toBe(0);
    expect(out).not.toContain("Unknown command");
    expect(out).toContain("No saved sessions");
  } finally {
    process.chdir(originalCwd);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("dispatch still handles --version without routing to launch", async () => {
  const { result, out } = await captureLog(() => dispatch(["--version"], CTX));
  expect(result).toBe(0);
  expect(out).toContain("joc v9.9.9");
});

test("dispatch reports unknown subcommands (non-flag) as before", async () => {
  const { result, out } = await captureLog(() => dispatch(["definitely-not-a-cmd"], CTX));
  expect(result).toBe(1);
  expect(out).toContain("Unknown command");
});

test("--worktree reuses an existing directory and chdirs into it", async () => {
  const originalCwd = process.cwd();
  const wt = await fsp.mkdtemp(path.join(os.tmpdir(), "joc-wt-existing-"));
  try {
    const { out } = await captureLog(() =>
      runLaunchCommand(["--worktree", wt, "--list"]),
    );
    expect(out).toContain("Using worktree");
    // chdir resolves symlinks (macOS /var → /private/var), so compare realpaths.
    expect(fs.realpathSync(process.cwd())).toBe(fs.realpathSync(wt));
  } finally {
    process.chdir(originalCwd);
    await fsp.rm(wt, { recursive: true, force: true });
  }
});

test("--worktree creates a git worktree when the path does not exist", async () => {
  const originalCwd = process.cwd();
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "joc-wt-repo-"));
  try {
    // Minimal git repo with one commit so `git worktree add` succeeds.
    const run = (cmd: string[]) =>
      Bun.spawnSync(cmd, { cwd: repo, stdout: "ignore", stderr: "ignore" });
    run(["git", "init", "-q"]);
    run(["git", "config", "user.email", "t@t.t"]);
    run(["git", "config", "user.name", "t"]);
    await fsp.writeFile(path.join(repo, "README.md"), "# t\n");
    run(["git", "add", "-A"]);
    run(["git", "commit", "-qm", "init"]);

    process.chdir(repo);
    const wtPath = path.join(repo, "feature-wt");
    expect(fs.existsSync(wtPath)).toBe(false);

    await captureLog(() => runLaunchCommand(["--worktree", wtPath, "--list"]));

    // The worktree directory was created and we are now inside it.
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(fs.realpathSync(process.cwd())).toBe(fs.realpathSync(wtPath));
    // It is a real linked worktree of the repo.
    const list = Bun.spawnSync(["git", "worktree", "list"], { cwd: repo, stdout: "pipe", stderr: "ignore" });
    expect(list.stdout.toString()).toContain("feature-wt");
  } finally {
    process.chdir(originalCwd);
    await fsp.rm(repo, { recursive: true, force: true });
  }
});
