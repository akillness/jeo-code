import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDockerBackend } from "../src/agent/sandbox/docker";
import { createSandboxPolicy } from "../src/agent/sandbox/policy";
import type { SandboxProcess } from "../src/agent/sandbox/types";

// Diagnostic only, not a replacement for trusted hands qualification.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-mount-identity-")));
const workspace = path.join(root, "workspace");
const bundle = path.join(root, "probe.js");
let worker: SandboxProcess | undefined;
let report: Record<string, unknown> | undefined;
try {
  await fs.chmod(root, 0o700);
  await fs.mkdir(workspace, { mode: 0o700 });
  await fs.writeFile(bundle, `const fs=require('node:fs');const st=fs.statSync('/workspace',{bigint:true});let renameError;try{fs.renameSync('/workspace','/tmp/moved-root');throw Error('mount root moved')}catch(e){if(!e.code)throw e;renameError=e.code}console.log(JSON.stringify({platform:process.platform,arch:process.arch,dev:String(st.dev),ino:String(st.ino),uid:String(st.uid),mode:String(st.mode),renameError}));for await(const chunk of Bun.stdin.stream()){};`, { mode: 0o400 });
  const hostStat = await fs.stat(workspace, { bigint: true });
  const backend = createDockerBackend();
  const policy = await createSandboxPolicy({
    sessionKey: `identity-${crypto.randomUUID()}`, revision: 1, cwd: workspace,
    config: { image: "oven/bun:1.3.14", limits: { memoryBytes: 268435456, pids: 64, cpus: 1 } },
  });
  const image = await backend.preflight(policy.config);
  worker = await backend.launch(policy, bundle);
  const timer = setTimeout(() => { void worker?.stop(); }, 30_000);
  try {
    await worker.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(worker.stdout).text(), new Response(worker.stderr).text(), worker.exited,
    ]);
    assert.equal(exitCode, 0, stderr);
    const guest = JSON.parse(stdout.trim());
    const host = { platform: process.platform, arch: process.arch, dev: String(hostStat.dev), ino: String(hostStat.ino), uid: String(hostStat.uid), mode: String(hostStat.mode) };
    report = { status: "PASS", diagnosticOnly: true, host, guest, image, sameDev: host.dev === guest.dev, sameIno: host.ino === guest.ino, stdout: stdout.trim(), stderr, exitCode };
  } finally { clearTimeout(timer); }
} catch (error) {
  report = { status: "FAIL", diagnosticOnly: true, host: { platform: process.platform, arch: process.arch }, error: error instanceof Error ? error.message : String(error) };
  process.exitCode = 1;
} finally {
  if (worker) {
    assert.deepEqual(await worker.stop(), { gone: true, residual: [] });
    const check = Bun.spawn(["docker", "container", "ls", "--all", "--filter", `name=^/${worker.name}$`, "--format", "{{.ID}}"], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => check.kill(), 20_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([new Response(check.stdout).text(), new Response(check.stderr).text(), check.exited]);
      assert.equal(exitCode, 0, stderr);
      assert.equal(stdout.trim(), "", "probe container remains");
    } finally { clearTimeout(timer); }
  }
  await fs.rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ ...report, cleanup: { containerIndependentlyAbsent: worker ? true : null, containerWasLaunched: !!worker, privateFixtureRemoved: true } }, null, 2));
