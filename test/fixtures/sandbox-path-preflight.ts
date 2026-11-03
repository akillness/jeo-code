import { spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createGrantAuthority, type GrantAuthority } from "../../src/agent/sandbox/authority";
import { canonicalSandboxPath } from "../../src/agent/sandbox/policy";
import type { SandboxSupervisor } from "../../src/agent/sandbox/types";

// Platform and builtin spies never leave this child process. Native setup and
// teardown use real local files; the simulated Windows phase cannot touch disk.
const mode = process.argv[2]!;
const inputs: string[] = JSON.parse(process.argv[3]!);
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const restores: Array<() => void> = [];
let root: string | undefined;
let authority: GrantAuthority | undefined;
let authorityWorkspace: string | undefined;
const calls: Array<{ operation: string; target: string }> = [];

try {
  if (mode === "authority" || mode === "authority-drive") {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-path-preflight-")));
    const cwd = path.join(root, "workspace");
    authorityWorkspace = cwd;
    await fs.mkdir(cwd);
    const supervisor: SandboxSupervisor = {
      toolMap: () => ({}),
      async call() { throw new Error("Unexpected worker call"); },
      async exec() { throw new Error("Unexpected worker execution"); },
      async replacePolicy() { throw new Error("Unexpected policy transition"); },
      async revoke() { throw new Error("Unexpected revocation"); },
      async close() {},
    };
    authority = await createGrantAuthority({
      sessionKey: "windows-preflight", cwd,
      stateDirectory: path.join(root, "private-authority"),
      allowedUserIds: ["operator"], supervisor,
      config: { image: "test-local-image", limits: { memoryBytes: 128 * 1024 * 1024, pids: 32, cpus: 1 } },
    });
  }

  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  const cwd = spyOn(process, "cwd").mockReturnValue(mode === "inherited" ? String.raw`\\server.invalid\share\workspace` : String.raw`C:\workspace`);
  const resolve = spyOn(path, "resolve").mockImplementation((...parts: string[]) => {
    calls.push({ operation: "resolve", target: parts.join(" | ") });
    // The real fixture directory represents an authority rooted on D:, while
    // the trusted parent process itself runs on C:. Only explicit base-path
    // resolution may select that authority drive for root-relative requests.
    if (mode === "authority-drive" && parts[0] === authorityWorkspace) {
      parts[0] = String.raw`D:\workspace`;
    }
    // Bun resolves against native cwd internally, so supply the simulated cwd explicitly.
    return path.win32.resolve(process.cwd(), ...parts);
  });
  const isAbsolute = spyOn(path, "isAbsolute").mockImplementation(path.win32.isAbsolute);
  restores.push(() => cwd.mockRestore(), () => resolve.mockRestore(), () => isAbsolute.mockRestore());
  const realpath = spyOn(fs, "realpath").mockImplementation(async target => {
    calls.push({ operation: "realpath", target: String(target) });
    if (mode === "local") return String(target);
    throw new Error("FORBIDDEN_FILESYSTEM_ACCESS");
  });
  restores.push(() => realpath.mockRestore());
  for (const operation of ["lstat", "stat", "readdir", "readFile", "mkdir", "writeFile", "open"] as const) {
    const spy = spyOn(fs, operation).mockImplementation(async (...args: unknown[]) => {
      calls.push({ operation, target: String(args[0]) });
      throw new Error("FORBIDDEN_FILESYSTEM_ACCESS");
    });
    restores.push(() => spy.mockRestore());
  }

  const reports = [];
  for (const input of inputs) {
    calls.length = 0;
    let value: string | undefined;
    let error: string | undefined;
    try {
      value = authority
        ? (await authority.requestAccess(input, "ro")).host
        : await canonicalSandboxPath(input, mode !== "optional");
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    }
    reports.push({ input, value, error, calls: [...calls], requests: authority?.snapshot().requests });
  }
  console.log(JSON.stringify(reports));
} finally {
  for (const restore of restores.reverse()) restore();
  Object.defineProperty(process, "platform", platform);
  if (root) await fs.rm(root, { recursive: true, force: true });
}
