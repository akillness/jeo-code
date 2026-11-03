import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGrantAuthority } from "../src/agent/sandbox/authority";
import { handleSandboxControl } from "../src/agent/sandbox/control";
import { SandboxLaunchError } from "../src/agent/sandbox/docker";
import { createSandboxPolicy } from "../src/agent/sandbox/policy";
import { createSandboxSupervisor } from "../src/agent/sandbox/supervisor";
import type { SandboxBackend, SandboxProcess, SandboxTermination } from "../src/agent/sandbox/types";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(launch: Error | SandboxProcess, sessionKey = "launch-cleanup-session") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "jeo-launch-cleanup-")));
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }); });
  const cwd = join(root, "workspace");
  const resource = join(root, "resource");
  await Promise.all([mkdir(cwd), mkdir(resource)]);
  const config = { image: "test-local-image", limits: { memoryBytes: 268435456, pids: 32, cpus: 1 } };
  const policy = await createSandboxPolicy({ sessionKey, revision: 1, cwd, config });
  let launches = 0;
  const backend: SandboxBackend = {
    async preflight() { return { imageId: "sha256:" + "a".repeat(64), platform: "linux/arm64" }; },
    async launch() {
      launches++;
      if (launch instanceof Error) throw launch;
      return launch;
    },
  };
  const supervisor = createSandboxSupervisor({ policy, backend, bundlePath: join(root, "trusted-hands.js") });
  cleanups.push(async () => {
    await supervisor.close().catch(() => {});
  });
  const authority = await createGrantAuthority({
    sessionKey, cwd, config, supervisor, allowedUserIds: ["operator"],
    stateDirectory: join(root, "private-state"),
  });
  const actor = { origin: "terminal" as const, sessionKey };
  return { supervisor, authority, actor, resource, get launches() { return launches; } };
}

for (const action of ["revoke", "close"] as const) {
  test(`launch cleanup: legacy unstructured REVOKE_INCOMPLETE cannot report successful ${action}`, async () => {
    const f = await fixture(new Error("REVOKE_INCOMPLETE: owned-launch-residual still exists"));
    const failed = await f.supervisor.call("read", { path: "before-cleanup" });
    expect(failed.success).toBe(false);
    expect(failed.error).toMatch(/REVOKE_INCOMPLETE/);
    if (action === "revoke") {
      const termination = await f.supervisor.revoke();
      expect(termination.gone).toBe(false);
      expect(termination.residual.join(" ")).toMatch(/owned-launch-residual|unknown|unconfirmed/i);
    } else {
      await expect(f.supervisor.close()).rejects.toThrow(/REVOKE_INCOMPLETE/);
    }
    const blocked = await f.supervisor.exec(["bun", "run", "must-not-run.ts"]);
    expect(blocked.success).toBe(false);
    expect(f.launches).toBe(1);
  });
}

test("launch cleanup: human revoke control cannot announce removal after an unstructured incomplete launch", async () => {
  const f = await fixture(new Error("REVOKE_INCOMPLETE: owned-launch-residual still exists"));
  const failed = await f.supervisor.call("read", { path: "before-cleanup" });
  expect(failed.success).toBe(false);
  const control = await handleSandboxControl("/sandbox revoke", f.actor, f.authority);
  expect(control.handled).toBe(true);
  expect(control.output).toMatch(/Sandbox control error:.*REVOKE_INCOMPLETE/);
  expect(control.output).not.toContain("confirmed removed");
  expect(f.authority.snapshot().blocked).toBe(true);
  await expect(f.authority.requestAccess(f.resource, "rw")).rejects.toThrow(/REVOKE_INCOMPLETE/);
  const status = await handleSandboxControl("/sandbox status", f.actor, f.authority);
  expect(status.output).toMatch(/blocked/);
});

for (const action of ["revoke", "close", "control"] as const) {
  test(`launch cleanup: ${action} retries residual cleanup and succeeds only after confirmed absence`, async () => {
    const residual = "owned-failed-launch";
    let exists = true;
    let permitRemoval = false;
    let attempts = 0;
    const removalStarted = Promise.withResolvers<void>();
    const absenceConfirmed = Promise.withResolvers<void>();
    const launchError = new SandboxLaunchError("REVOKE_INCOMPLETE: launch cleanup failed", [residual], async (): Promise<SandboxTermination> => {
      attempts++;
      if (permitRemoval) {
        removalStarted.resolve();
        await absenceConfirmed.promise;
      }
      return { gone: !exists, residual: exists ? [residual] : [] };
    });
    const f = await fixture(launchError);
    cleanups.push(async () => { absenceConfirmed.resolve(); });
    const failed = await f.supervisor.call("write", { path: "never-written", content: "forbidden" });
    expect(failed.success).toBe(false);
    expect(failed.error).toMatch(/REVOKE_INCOMPLETE/);

    if (action === "revoke") {
      expect(await f.supervisor.revoke()).toEqual({ gone: false, residual: [residual] });
    } else if (action === "close") {
      await expect(f.supervisor.close()).rejects.toThrow(/REVOKE_INCOMPLETE/);
    } else {
      const control = await handleSandboxControl("/sandbox revoke", f.actor, f.authority);
      expect(control.output).toMatch(/Sandbox control error:.*REVOKE_INCOMPLETE/);
      expect(control.output).not.toContain("confirmed removed");
      expect(f.authority.snapshot().blocked).toBe(true);
      await expect(f.authority.requestAccess(f.resource, "rw")).rejects.toThrow(/REVOKE_INCOMPLETE/);
    }
    expect(exists).toBe(true);
    expect(attempts).toBeGreaterThan(0);
    const blocked = await f.supervisor.exec(["bun", "run", "must-not-run.ts"]);
    expect(blocked.success).toBe(false);
    expect(f.launches).toBe(1);

    permitRemoval = true;
    const retry = action === "revoke" ? f.supervisor.revoke()
      : action === "close" ? f.supervisor.close()
      : handleSandboxControl("/sandbox revoke", f.actor, f.authority);
    const confirmedRetry = retry.then(result => {
      expect(exists).toBe(false);
      return result;
    });
    expect(await Promise.race([
      removalStarted.promise.then(() => "cleanup-started"),
      confirmedRetry.then(() => "completed-without-confirmation"),
    ])).toBe("cleanup-started");
    const duringRemoval = await f.supervisor.call("write", { path: "still-forbidden", content: "forbidden" });
    expect(duringRemoval.success).toBe(false);
    expect(exists).toBe(true);
    exists = false;
    absenceConfirmed.resolve();
    const result = await confirmedRetry;
    if (action === "revoke") expect(result).toEqual({ gone: true, residual: [] });
    if (action === "control") expect(result).toEqual({ handled: true, output: "Sandbox access revoked; owned containers confirmed removed." });
    const afterRemoval = await f.supervisor.exec(["bun", "run", "cannot-revive.ts"]);
    expect(afterRemoval.success).toBe(false);
    expect(f.launches).toBe(1);
  });
}

test("launch cleanup: a failed session cannot block a different supervisor's effects or removal", async () => {
  const failed = await fixture(new Error("REVOKE_INCOMPLETE: another-session-residual"));
  expect((await failed.supervisor.call("read", { path: "fail-launch" })).success).toBe(false);
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let diagnostics!: ReadableStreamDefaultController<Uint8Array>;
  const exited = Promise.withResolvers<number>();
  const worker: SandboxProcess = {
    name: "independent-owned-worker",
    stdout: new ReadableStream({ start(controller) { output = controller; } }),
    stderr: new ReadableStream({ start(controller) { diagnostics = controller; } }),
    exited: exited.promise,
    stdin: {
      write(data: string) {
        const request: unknown = JSON.parse(data);
        if (!request || typeof request !== "object" || !("id" in request) || typeof request.id !== "string") throw new Error("Invalid request identity");
        output.enqueue(new TextEncoder().encode(JSON.stringify({ id: request.id, type: "result", result: { success: true, output: "independent session effect completed" } }) + "\n"));
      },
      flush() {},
      end() {},
    },
    async stop() {
      output.close();
      diagnostics.close();
      exited.resolve(0);
      return { gone: true, residual: [] };
    },
  };
  const independent = await fixture(worker, "independent-launch-cleanup-session");
  expect(await independent.supervisor.call("read", { path: "independent" })).toEqual({ success: true, output: "independent session effect completed" });
  expect((await failed.supervisor.revoke()).gone).toBe(false);
  expect(await independent.supervisor.revoke()).toEqual({ gone: true, residual: [] });
  expect(independent.launches).toBe(1);
});
