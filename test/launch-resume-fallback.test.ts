import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createSession, appendMessage } from "../src/agent/session";

// Regression test for a real bug found while verifying "/resume screen
// reproduction" live: the bare `--resume`/`-r` (no value) cold-startup path,
// when there is no TTY (so the interactive picker can't run), used to create
// a fresh EMPTY placeholder session BEFORE asking `latestSessionId(cwd)` which
// session to resume. Since that placeholder is always the newest file by
// mtime, `latestSessionId` always returned the just-created placeholder
// instead of the real prior session — so this fallback "resumed" an empty
// session every single time, never the actual prior work. Fixed in
// src/commands/launch.ts by resolving `latestSessionId` BEFORE creating any
// placeholder, mirroring `--resume <id>`/`--continue`'s existing (correct)
// ordering.

const CLI = path.resolve(import.meta.dir, "../src/cli.ts");
const CRED_ENV = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY", "KIMI_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_OAUTH_TOKEN", "GEMINI_OAUTH_TOKEN",
  "JEO_DEFAULT_MODEL", "JEO_GEMINI_CREDS_PATH",
];

const live: ReturnType<typeof Bun.spawn>[] = [];
afterEach(() => {
  for (const proc of live) { try { proc.kill(); } catch { /* already dead */ } }
  live.length = 0;
});

async function runBareResume(projectDir: string): Promise<{ stdout: string; exitCode: number }> {
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: "1", JEO_STATIC_MEMORY: "1" };
  for (const k of CRED_ENV) delete env[k];
  const proc = Bun.spawn([process.execPath, CLI, "--resume", "--no-tui"], {
    cwd: projectDir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  live.push(proc);
  proc.stdin.end(); // no TTY, no input — same as a piped/non-interactive invocation
  let out = "";
  void (async () => { for await (const chunk of proc.stdout) out += Buffer.from(chunk).toString("utf-8"); })();
  const exitCode = await proc.exited;
  return { stdout: out, exitCode };
}

test("bare --resume (no TTY): resumes the REAL prior session's content, not a fresh empty placeholder", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-resume-fallback-"));
  try {
    const { id } = await createSession(projectDir, undefined, "test-model");
    await appendMessage(id, { role: "user", content: "add a logout handler" }, projectDir);
    await appendMessage(id, { role: "assistant", content: JSON.stringify({ tool: "write", arguments: { filePath: "logout.ts", content: "export {}" } }) }, projectDir);
    await appendMessage(id, { role: "user", content: "Tool [write] result (ok):\nwrote logout.ts" }, projectDir);
    await appendMessage(id, { role: "assistant", content: JSON.stringify({ tool: "done", arguments: { reason: "Implemented the logout handler in logout.ts." } }) }, projectDir);

    const { stdout, exitCode } = await runBareResume(projectDir);
    expect(exitCode).toBe(0);

    // Resumes the SEEDED session (by id), not some other/fresh one.
    expect(stdout).toContain(`Resumed session ${id} (4 messages)`);
    // The prior work is actually reproduced on screen (gjc-style transcript ledger),
    // not just a bare message count.
    expect(stdout).toContain("add a logout handler");
    expect(stdout).toContain("Write logout.ts");
    expect(stdout).toContain("Implemented the logout handler in logout.ts.");

    // No extra placeholder session file was created — exactly the one we seeded.
    const files = await fs.readdir(path.join(projectDir, ".jeo", "sessions"));
    expect(files).toEqual([`${id}.jsonl`]);
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test("bare --resume (no TTY): with no prior session at all, falls back to a fresh empty one (no crash)", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-resume-fallback-empty-"));
  try {
    const { stdout, exitCode } = await runBareResume(projectDir);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("Resumed session");

    const files = await fs.readdir(path.join(projectDir, ".jeo", "sessions"));
    expect(files.length).toBe(1); // the safe-default fresh session
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});
