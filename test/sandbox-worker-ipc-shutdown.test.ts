import { expect, test } from "bun:test";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";

const reportSchema = z.object({
  aliveAfterBad: z.boolean(), ackBefore: z.boolean(), killsBefore: z.number(), killsAfter: z.number(),
  workerExit: z.number().int(), containersAfter: z.array(z.string()), containerId: z.string().min(1),
  acknowledgements: z.array(z.object({ nonce: z.string(), gone: z.boolean() })), nonce: z.string().min(1), turn: z.string(),
});

const lifecycleSchema = z.object({
  mode: z.enum(["natural", "early"]), ipcJson: z.boolean(), earlySent: z.boolean(), workerExit: z.number().int(), turn: z.string(),
  requests: z.number().int(), killCalls: z.number().int(), nonce: z.string().min(1), toolStarted: z.boolean(),
  containersAfter: z.array(z.string()), acknowledgements: z.array(z.object({ nonce: z.string(), gone: z.boolean() })),
});

async function scenario(mode: "active" | "natural" | "early" = "active"): Promise<unknown> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-ipc-shutdown-")));
  const driver = path.join(root, "driver");
  await fs.mkdir(driver);
  let binary: string | undefined;
  if (process.env.JEO_TEST_CLI_BINARY !== undefined) {
    if (!path.isAbsolute(process.env.JEO_TEST_CLI_BINARY)) throw new Error("JEO_TEST_CLI_BINARY must be an absolute executable path");
    await fs.access(process.env.JEO_TEST_CLI_BINARY, constants.X_OK);
    const binaryDir = path.join(root, "isolated-binary");
    await fs.mkdir(binaryDir);
    binary = path.join(binaryDir, "jeo");
    await fs.copyFile(process.env.JEO_TEST_CLI_BINARY, binary);
    await fs.chmod(binary, 0o700);
  }
  const child = Bun.spawn([process.execPath, "--no-env-file", path.join(import.meta.dir, "fixtures/sandbox-worker-ipc-shutdown.ts"), root, mode], {
    cwd: driver, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    // Real HOME is required for the Docker client; config/workspace/sessions stay in the private root.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", JEO_CONFIG_DIR: path.join(root, "config"), JEO_STATIC_MEMORY: "1", NO_COLOR: "1", ...(binary ? { JEO_TEST_CLI_BINARY: binary } : {}) },
  });
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    return JSON.parse(stdout);
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
    await fs.rm(root, { recursive: true, force: true });
  }
}

// Real Docker + real Bun IPC through the actual launch path. Runs unconditionally on every platform and fails closed if prerequisites are unavailable.
test("worker IPC shutdown: only the exact nonce frame stops an active tool turn, without signals", async () => {
  const report = reportSchema.parse(await scenario("active"));
  // Bad private frames were ignored while the guest tool was still running.
  expect(report.aliveAfterBad).toBe(true);
  expect(report.ackBefore).toBe(false);
  // Correct frame: matching parent-nonce ACK, exit 143, owned container gone.
  expect(report.acknowledgements).toEqual([{ nonce: report.nonce, gone: true }]);
  expect(report.workerExit).toBe(143);
  expect(report.containersAfter).toEqual([]);
  // No SIGTERM/SIGKILL fallback on the worker handle.
  expect(report.killsBefore).toBe(0);
  expect(report.killsAfter).toBe(0);
}, 150_000);

// Real worker, real Docker: after one normal answer and stdin EOF the worker must exit 0 on its own (the IPC channel/listener
// must not keep it alive), with a matching ACK and no owned container left. No shutdown frame and no signals are sent.
test("worker IPC natural exit: normal answer then stdin EOF exits 0 by itself with ACK and no container", async () => {
  const report = lifecycleSchema.parse(await scenario("natural"));
  expect(report.ipcJson).toBe(true);
  expect(report.requests).toBeGreaterThanOrEqual(1);
  expect(report.toolStarted).toBe(false);
  expect(report.turn).toBe("resolved");
  expect(report.workerExit).toBe(0);
  expect(report.acknowledgements).toEqual([{ nonce: report.nonce, gone: true }]);
  expect(report.containersAfter).toEqual([]);
  expect(report.killCalls).toBe(0);
}, 150_000);

// Exact nonce frame delivered immediately after spawn, before any work: the listener must be registered early enough.
test("worker IPC shutdown immediately after spawn: no model/tool side effects, ACK, exit 143, no container", async () => {
  const report = lifecycleSchema.parse(await scenario("early"));
  expect(report.ipcJson).toBe(true);
  expect(report.earlySent).toBe(true);
  expect(report.requests).toBe(0);
  expect(report.toolStarted).toBe(false);
  expect(report.workerExit).toBe(143);
  expect(report.acknowledgements).toEqual([{ nonce: report.nonce, gone: true }]);
  expect(report.containersAfter).toEqual([]);
  expect(report.killCalls).toBe(0);
}, 150_000);
