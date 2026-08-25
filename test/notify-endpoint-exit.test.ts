import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const CLI = path.join(import.meta.dir, "..", "src", "cli.ts");

/**
 * Regression: a non-interactive `jeo` run must EXIT.
 *
 * `startSessionNotifyEndpoint` binds a `Bun.serve` socket and a snapshot poll
 * `setInterval` for the whole launch lifetime, but its teardown lived only on the
 * interactive REPL's exit path. A one-shot run (`echo "…" | jeo`, `jeo -p "…"`, any CI
 * or scripted use) returns through one of ~17 early `return`s that never reach it, so
 * with `notifications.enabled` the process sat there forever holding a listening socket.
 *
 * It was invisible for two reasons: it only reproduces when notifications are actually
 * configured, and Bun timers/servers do not show up in `process._getActiveHandles()` —
 * so the hung process reported ZERO active handles while refusing to exit.
 *
 * These tests pin the fix deterministically by pointing `JEO_CONFIG_DIR` at a temp
 * config with notifications ON, instead of depending on whatever the developer's real
 * `~/.jeo/config.json` happens to say.
 */
async function makeNotifyEnabledHome(): Promise<{ configDir: string; workDir: string }> {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-notify-cfg-"));
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-notify-work-"));
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({
      notifications: {
        enabled: true,
        telegram: { botToken: "000000:test-token-not-real", chatId: "1" },
      },
      defaultModel: "claude-sonnet-4-6",
    }),
  );
  return { configDir, workDir };
}

async function runOneShot(
  stdin: string,
  timeoutMs: number,
): Promise<{ code: number | "timeout"; configDir: string }> {
  const { configDir, workDir } = await makeNotifyEnabledHome();
  const proc = Bun.spawn([process.execPath, CLI, "--no-tui", "--no-session", "--no-skills"], {
    cwd: workDir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1", JEO_CONFIG_DIR: configDir },
  });
  proc.stdin.write(stdin);
  proc.stdin.end();
  const drained = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await Promise.race([
    proc.exited,
    new Promise<"timeout">(r => setTimeout(() => r("timeout"), timeoutMs)),
  ]);
  if (code === "timeout") proc.kill(9);
  await drained;
  await fs.rm(workDir, { recursive: true, force: true });
  return { code, configDir };
}

test("a one-shot run with notifications ENABLED still exits (the endpoint cannot hold the loop)", async () => {
  // 10s is ~25x the observed healthy exit (~0.4s) and well under the old hang, so this
  // fails loudly on a regression without being flaky on a loaded CI box.
  const { code, configDir } = await runOneShot("", 10_000);
  expect(code).not.toBe("timeout");
  await fs.rm(configDir, { recursive: true, force: true });
}, 20_000);

test("a piped command with notifications ENABLED exits and leaves no session discovery file", async () => {
  const { code, configDir } = await runOneShot("/exit\n", 10_000);
  expect(code).not.toBe("timeout");

  // The endpoint publishes a discovery file the Telegram daemon polls and dials. A
  // one-shot run that leaves one behind makes the daemon retry a dead socket forever,
  // so the `finally` teardown must remove it even though the run exited early.
  const sessionsDir = path.join(configDir, "notify", "sessions");
  let leftover: string[] = [];
  try {
    leftover = await fs.readdir(sessionsDir);
  } catch {
    leftover = []; // never created at all — also correct
  }
  expect(leftover).toEqual([]);
  await fs.rm(configDir, { recursive: true, force: true });
}, 20_000);

test("SessionNotifyEndpoint unrefs both the server and the poll timer", async () => {
  // Unit-level guard for the same contract: even a caller that forgets `stop()`
  // (a crash path, a future early return) must not be able to pin the process open.
  const { SessionNotifyEndpoint } = await import("../src/agent/notify/session-endpoint");
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-notify-unit-"));
  const prev = process.env.JEO_CONFIG_DIR;
  process.env.JEO_CONFIG_DIR = configDir;
  try {
    const endpoint = new SessionNotifyEndpoint(configDir, "unit-test-session");
    await endpoint.start();
    const internals = endpoint as unknown as {
      server?: { hasRef?: () => boolean };
      pollTimer?: { hasRef?: () => boolean };
    };
    // `hasRef()` is the only observable signal; when a runtime does not expose it the
    // assertion degrades to "did not claim to be ref'd" rather than a false pass.
    expect(internals.pollTimer?.hasRef?.() ?? false).toBe(false);
    expect(internals.server?.hasRef?.() ?? false).toBe(false);
    await endpoint.stop();
  } finally {
    if (prev === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = prev;
    await fs.rm(configDir, { recursive: true, force: true });
  }
});
