import { expect, test } from "bun:test";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

async function scenario(mode: string): Promise<Record<string, unknown>> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-discord-host-worker-")));
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let watchdog: Timer | undefined;
  try {
    const home = path.join(root, "home");
    await fs.mkdir(home, { mode: 0o700 });
    let binary: string | undefined;
    if (process.env.JEO_TEST_CLI_BINARY !== undefined) {
      if (!path.isAbsolute(process.env.JEO_TEST_CLI_BINARY)) throw new Error("JEO_TEST_CLI_BINARY must be absolute");
      await fs.access(process.env.JEO_TEST_CLI_BINARY, constants.X_OK);
      binary = path.join(root, "jeo");
      await fs.copyFile(process.env.JEO_TEST_CLI_BINARY, binary);
      await fs.chmod(binary, 0o700);
    }
    child = Bun.spawn([process.execPath, "--no-env-file", path.join(import.meta.dir, "fixtures/discord-host-worker.ts"), root, mode], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "", HOME: home, TMPDIR: root,
        JEO_CONFIG_DIR: path.join(root, "config"), JEO_STATIC_MEMORY: "1", NO_COLOR: "1",
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
        ...(binary ? { JEO_TEST_CLI_BINARY: binary } : {}),
      },
    });
    // Deadline only: successful completion is driven by child exit and effect/IPC barriers, not elapsed time.
    watchdog = setTimeout(() => child?.kill("SIGTERM"), 100_000);
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    return JSON.parse(stdout);
  } finally {
    clearTimeout(watchdog);
    if (child?.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
    const leaked: number[] = [];
    const ownership = await fs.readFile(path.join(root, "payloads.jsonl"), "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    for (const line of ownership.trim().split("\n").filter(Boolean)) {
      const record = JSON.parse(line) as { pid: number; outside: string };
      // Never signal a recycled PID: only this fixture's unique absolute payload path establishes ownership.
      const command = Bun.spawnSync(["ps", "-p", String(record.pid), "-o", "command="], { stdout: "pipe", stderr: "pipe" });
      if (command.exitCode === 0 && command.stdout.toString().includes("discord-host-worker.ts payload") && command.stdout.toString().includes(record.outside)) {
        process.kill(record.pid, "SIGKILL");
        leaked.push(record.pid);
      }
    }
    await fs.rm(root, { recursive: true, force: true });
    expect(leaked).toEqual([]);
  }
}

test("Discord host CLI runs as the host UID in its Git worktree and reads an allowed file outside it", async () => {
  const report = await scenario("probe");
  expect(report.hostUid).toBe(report.expectedUid);
  expect(report.outsideText).toBe("outside-worktree sentinel\n");
  expect(report.gitTopLevel).toBe(report.workerCwd);
  expect(report.workerCwd).not.toBe(report.sourceCwd);
  expect(report.sourceVictimExists).toBe(false);
  expect(report.ipc).toBe(true);
}, 110_000);

test("real destructive command waits for the matching thread's authenticated standalone approval, not model or quoted controls", async () => {
  const report = await scenario("approval");
  expect(report.existsBeforeApproval).toBe(true);
  expect(report.existsAfterApproval).toBe(false);
  expect(report.modelControlDelivered).toBe(true);
  expect(report.wrongThreadRejected).toBe(true);
  expect(report.unauthorizedRejected).toBe(true);
  expect(report.quotedControlDidNotApprove).toBe(true);
  expect(report.replayedApprovalRejected).toBe(true);
}, 110_000);

for (const mode of ["cancel", "archive"]) {
  test(`Discord host ${mode} halts only thread A's leased shell before cleanup ACK while thread B keeps making progress`, async () => {
    const report = await scenario(mode);
    expect(report.aAliveAtAck).toBe(false);
    expect(report.receiptAtAck).toBe(true);
    expect(report.aAliveAfterControl).toBe(false);
    expect(report.bHeartbeatAdvanced).toBe(true);
    expect(report.bAliveAfterControl).toBe(true);
    expect(report.workerForcedKills).toBe(0);
  }, 110_000);
}

for (const mode of ["eof", "disconnect"]) {
  test(`Discord host CLI ${mode} performs owned shell cleanup and writes a receipt before exit`, async () => {
    const report = await scenario(mode);
    expect(report.aAliveAtAck).toBe(false);
    expect(report.receiptAtAck).toBe(true);
    expect(report.aAliveAfterExit).toBe(false);
    expect(report.workerForcedKills).toBe(0);
    expect(report.workerExit).toBe(mode === "eof" ? 0 : 143);
  }, 110_000);
}

test("Discord host restart restores worktree and transcript but does not replay an interrupted platform message", async () => {
  const report = await scenario("restart");
  expect(report.restartedCwd).toBe(report.originalCwd);
  expect(report.historyRestored).toBe(true);
  expect(report.originalLaunches).toBe(1);
  expect(report.heartbeatStarts).toBe(1);
  expect(report.duplicateProviderRequests).toBe(0);
  expect(report.aAliveAfterControl).toBe(false);
}, 110_000);

test("cancel before a thread's first worker admission prevents queued commands while unrelated later work still runs", async () => {
  const report = await scenario("queue-cancel");
  expect(report.cancelledProviderRequests).toBe(0);
  expect(report.workerLaunches).toBe(2);
  expect(report.subsequentOutside).toBe("outside-worktree sentinel\n");
  expect(report.aAliveAfterControl).toBe(false);
}, 110_000);
