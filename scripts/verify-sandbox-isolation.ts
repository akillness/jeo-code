import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDockerBackend } from "../src/agent/sandbox/docker";
import { createSandboxPolicy } from "../src/agent/sandbox/policy";
import { createSandboxSupervisor } from "../src/agent/sandbox/supervisor";
import { prepareHandsBundle } from "../src/agent/sandbox/bundle";
import type { SandboxBackend, SandboxSupervisor } from "../src/agent/sandbox/types";
import type { ToolResult } from "../src/agent/tools";

// Run explicitly: bun scripts/verify-sandbox-isolation.ts
// Real Docker only: no fake backend, downloads, builds, or missing-prerequisite passes.
const config = {
  image: "oven/bun:1.3.14",
  limits: { memoryBytes: 268435456, pids: 64, cpus: 1 },
};
const contracts = [
  "local-image", "guest-identity", "runtime-boundaries", "bind-root-pinning", "read-write-tools",
  "bash", "eval", "job", "monitor", "unmounted-sentinel", "read-only-grant",
  "read-write-grant", "session-isolation", "ancestor-policy-denial", "shared-workspace", "detached-child", "policy-replacement",
  "replacement-isolation", "revocation", "post-revoke-denial",
] as const;
type Contract = typeof contracts[number];
const checks: { contract: Contract; status: "PASS"; evidence: unknown }[] = [];
const supervisors: SandboxSupervisor[] = [];
const launches: { sessionKey: string; revision: number; name: string; stderr: string }[] = [];
const cleanupErrors: string[] = [];
const confirmedAbsent: string[] = [];
let root: string | undefined;
let failure: string | undefined;
let current: Contract = "local-image";
let image: { imageId: string; platform: string } | undefined;
let guest: { platform: string; arch: string; cwd: string; uid: number } | undefined;

function pass(contract: Contract, evidence: unknown): void {
  checks.push({ contract, status: "PASS", evidence });
  const index = contracts.indexOf(contract);
  current = contracts[index + 1] ?? contract;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function output(result: ToolResult): string {
  assert.equal(result.success, true, result.error || result.output);
  return result.output;
}
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
async function tool(supervisor: SandboxSupervisor, name: string, args: Record<string, unknown>): Promise<string> {
  return output(await supervisor.call(name, args, { signal: AbortSignal.timeout(30_000) }));
}
async function exec(supervisor: SandboxSupervisor, source: string, ...args: string[]): Promise<string> {
  return output(await supervisor.exec(["bun", "-e", source, ...args], { signal: AbortSignal.timeout(30_000) })).trim();
}
async function docker(args: string[]): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    assert.equal(code, 0, `docker ${args[0]} failed: ${stderr}`);
    return stdout.trim();
  } finally { clearTimeout(timer); }
}
async function absent(name: string): Promise<void> {
  assert.equal(await docker(["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"]), "", `${name} still exists`);
}
async function noFile(file: string): Promise<void> { await assert.rejects(fs.stat(file), { code: "ENOENT" }); }
async function denied(supervisor: SandboxSupervisor, files: string[]): Promise<void> {
  assert.equal(await exec(supervisor, `const fs=require('node:fs');for(const p of process.argv.slice(1)){try{fs.readFileSync(p);throw Error('UNAUTHORIZED_READ:'+p)}catch(e){if(e.code!=='ENOENT'&&e.code!=='EACCES')throw e}}console.log('DENIED')`, ...files), "DENIED");
}
function latest(sessionKey: string): typeof launches[number] {
  const record = launches.findLast(item => item.sessionKey === sessionKey);
  assert.ok(record, `session ${sessionKey} did not launch a container`);
  return record;
}
// Desktop bind bridges need not emit native fs.watch events. Poll the actual
// host artifact with async I/O until it changes, bounded by a failure deadline.
async function growing(file: string, after: number): Promise<number> {
  const deadline = performance.now() + 10_000;
  let bytes = 0;
  while (performance.now() < deadline) {
    bytes = (await fs.stat(file).catch(error => {
      if (error.code !== "ENOENT") throw error;
      return { size: 0 };
    })).size;
    if (bytes > after) return bytes;
  }
  throw new Error(`heartbeat did not grow beyond ${after} bytes; observed ${bytes}: ${file}`);
}
async function heartbeat(supervisor: SandboxSupervisor, guestFile: string, hostFile: string): Promise<number> {
  const writer = `const fs=require('node:fs');const fd=fs.openSync(process.argv[2],'a');function tick(){fs.writeSync(fd,'tick\\n');fs.fsyncSync(fd)}tick();setInterval(tick,10);`;
  const middle = `const fs=require('node:fs');const fd=fs.openSync('/workspace/detached.log','a');const p=require('node:child_process').spawn('bun',['/workspace/writer.cjs',process.argv[2]],{detached:true,stdio:['ignore',fd,fd]});p.unref();`;
  await tool(supervisor, "write", { filePath: "writer.cjs", content: writer });
  await tool(supervisor, "write", { filePath: "middle.cjs", content: middle });
  assert.equal(await exec(supervisor, `const fd=require('node:fs').openSync('/workspace/detached.log','a');const p=require('node:child_process').spawn('bun',['/workspace/middle.cjs',process.argv[1]],{detached:true,stdio:['ignore',fd,fd]});p.unref();console.log('DETACHED')`, guestFile), "DETACHED");
  try {
    const first = await growing(hostFile, 0);
    const second = await growing(hostFile, first);
    assert.ok(second > first, "detached grandchild must keep writing after both parents exit");
    return second;
  } catch (error) {
    const diagnostic = await tool(supervisor, "read", { filePath: "detached.log", raw: true }).catch(message);
    throw new Error(`${message(error)}; detached stderr: ${diagnostic}`);
  }
}
async function witness(supervisor: SandboxSupervisor): Promise<void> {
  assert.equal(await exec(supervisor, `const fs=require('node:fs');const fd=fs.openSync('/workspace/witness','a');for(let i=0;i<1000;i++){fs.writeSync(fd,'witness\\n');fs.fsyncSync(fd)}fs.closeSync(fd);console.log('WITNESS_OK')`), "WITNESS_OK");
}

try {
  const backend = createDockerBackend();
  const trackedBackend: SandboxBackend = {
    preflight: backend.preflight.bind(backend),
    async launch(policy, bundlePath) {
      const child = await backend.launch(policy, bundlePath);
      const record = { sessionKey: policy.sessionKey, revision: policy.revision, name: child.name, stderr: "" };
      launches.push(record);
      const [diagnostic, forwarded] = child.stderr.tee();
      void (async () => {
        const reader = diagnostic.getReader();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            record.stderr = (record.stderr + new TextDecoder().decode(chunk.value)).slice(-16_384);
          }
        } catch (error) { record.stderr += message(error); }
        finally { reader.releaseLock(); }
      })();
      return { ...child, stderr: forwarded };
    },
  };
  image = await backend.preflight(config);
  assert.match(image.imageId, /^sha256:[a-f0-9]{64}$/);
  pass("local-image", image);

  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-native-isolation-")));
  await fs.chmod(root, 0o700);
  const workspaceA = path.join(root, "workspace-a");
  const workspaceB = path.join(root, "workspace-b");
  const readOnly = path.join(root, "read-only");
  const approved = path.join(root, "approved");
  const outside = path.join(root, "outside-secret.txt");
  await Promise.all([workspaceA, workspaceB, readOnly, approved].map(dir => fs.mkdir(dir, { mode: 0o700 })));
  const sentinel = `OUTSIDE-${crypto.randomUUID()}`;
  const readOnlySentinel = `READ_ONLY-${crypto.randomUUID()}`;
  await fs.writeFile(outside, sentinel);
  await fs.writeFile(path.join(readOnly, "sentinel.txt"), readOnlySentinel);
  const token = crypto.randomUUID();
  const policyA = await createSandboxPolicy({ sessionKey: `native-a-${token}`, revision: 1, cwd: workspaceA, config,
    grants: [{ host: readOnly, mode: "ro" }, { host: approved, mode: "rw" }] });
  const policyB = await createSandboxPolicy({ sessionKey: `native-b-${token}`, revision: 1, cwd: workspaceB, config });
  const readOnlyGuest = policyA.mounts.find(mount => mount.host === readOnly)!.guest;
  const approvedGuest = policyA.mounts.find(mount => mount.host === approved)!.guest;
  const bundlePath = await prepareHandsBundle();
  const a = createSandboxSupervisor({ policy: policyA, backend: trackedBackend, bundlePath });
  const b = createSandboxSupervisor({ policy: policyB, backend: trackedBackend, bundlePath });
  supervisors.push(a, b);

  guest = JSON.parse(await exec(a, `console.log(JSON.stringify({platform:process.platform,arch:process.arch,cwd:process.cwd(),uid:process.getuid()}))`));
  assert.equal(guest!.platform, "linux");
  assert.equal(guest!.cwd, "/workspace");
  assert.notEqual(guest!.uid, 0);
  assert.deepEqual(JSON.parse(await exec(b, `console.log(JSON.stringify({platform:process.platform,arch:process.arch,cwd:process.cwd(),uid:process.getuid()}))`)), guest);
  pass("guest-identity", { host: { platform: process.platform, arch: process.arch }, guest });

  const nameA = latest(policyA.sessionKey).name;
  const nameB = latest(policyB.sessionKey).name;
  assert.notEqual(nameA, nameB);
  const deployed = JSON.parse(await docker(["inspect", nameA]));
  const runtime = deployed[0].HostConfig;
  assert.equal(deployed[0].Image, image.imageId);
  assert.equal(runtime.Memory, config.limits.memoryBytes);
  assert.equal(runtime.PidsLimit, config.limits.pids);
  assert.equal(runtime.NanoCpus, 1_000_000_000);
  assert.equal(runtime.NetworkMode, "none");
  assert.equal(runtime.ReadonlyRootfs, true);
  assert.ok(runtime.CapDrop.includes("ALL"));
  assert.ok(runtime.SecurityOpt.includes("no-new-privileges"));
  assert.equal(await exec(a, `const fs=require('node:fs');try{fs.writeFileSync('/forbidden-root','BAD');throw Error('ROOT_WRITABLE')}catch(e){if(e.code!=='EROFS'&&e.code!=='EACCES')throw e}if(!/^CapEff:\\s*0+$/m.test(fs.readFileSync('/proc/self/status','utf8')))throw Error('capabilities retained');if(fs.existsSync('/var/run/docker.sock'))throw Error('Docker socket visible');console.log('ROOT_AND_CAPS_DENIED')`), "ROOT_AND_CAPS_DENIED");
  pass("runtime-boundaries", { imageId: deployed[0].Image, limits: config.limits, network: runtime.NetworkMode, readOnlyRoot: true, nonRoot: guest!.uid });
  const renameDenials = JSON.parse(await exec(a, `const fs=require('node:fs');const denied=[];for(const p of process.argv.slice(1)){try{fs.renameSync(p,'/tmp/moved-root');throw Error('MOUNT_ROOT_MOVED:'+p)}catch(e){if(!['EBUSY','EXDEV','EROFS'].includes(e.code))throw e;denied.push({root:p,error:e.code})}}console.log(JSON.stringify(denied))`, "/workspace", approvedGuest));
  assert.equal(renameDenials.length, 2);
  assert.equal(await fs.realpath(workspaceA), workspaceA);
  assert.equal(await fs.realpath(approved), approved);
  pass("bind-root-pinning", { renameDenials, hostRootsRemain: true });

  const payload = `ordinary-write-${token}\n`;
  await tool(a, "write", { filePath: path.join(workspaceA, "ordinary.txt"), content: payload });
  assert.equal(await fs.readFile(path.join(workspaceA, "ordinary.txt"), "utf8"), payload);
  assert.equal(await tool(a, "read", { filePath: path.join(workspaceA, "ordinary.txt"), raw: true }), payload);
  await noFile(path.join(workspaceB, "ordinary.txt"));
  pass("read-write-tools", { content: payload, isolatedWorkspace: true });

  for (const kind of ["bash", "eval"] as const) {
    const source = `const value=JSON.stringify({tool:${JSON.stringify(kind)},platform:process.platform,cwd:process.cwd()});${kind === "eval" ? "await Bun.write" : "require('node:fs').writeFileSync"}('/workspace/${kind}.json',value);${kind === "eval" ? "log" : "console.log"}(value);`;
    const text = await tool(a, kind, kind === "eval" ? { code: source, timeoutMs: 10_000 } : { command: `bun -e ${quote(source)}`, timeoutMs: 10_000 });
    const expected = { tool: kind, platform: "linux", cwd: "/workspace" };
    assert.deepEqual(JSON.parse(text.trim()), expected);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(workspaceA, `${kind}.json`), "utf8")), expected);
    await noFile(path.join(workspaceB, `${kind}.json`));
    pass(kind, expected);
  }
  for (const kind of ["job", "monitor"] as const) {
    const value = `${kind}-${token}`;
    const source = `require('node:fs').writeFileSync('/workspace/${kind}.txt',${JSON.stringify(value)});console.log(${JSON.stringify(value)});`;
    const started = await tool(a, kind, { action: "start", command: `bun -e ${quote(source)}`, persistent: true });
    const id = started.match(/started (?:job )?'([^']+)'/)?.[1];
    assert.ok(id, `cannot retrieve ${kind} identity: ${started}`);
    await tool(a, kind, { action: "await", ids: [id], timeoutMs: 10_000 });
    assert.match(await tool(a, kind, { action: "tail", ids: [id] }), new RegExp(value));
    assert.equal(await fs.readFile(path.join(workspaceA, `${kind}.txt`), "utf8"), value);
    const other = await b.call(kind, { action: "tail", ids: [id] }, { signal: AbortSignal.timeout(10_000) });
    assert.equal(other.success, false);
    assert.match(other.error ?? "", /No (?:job|monitor) matches/);
    pass(kind, { id, written: value, otherSessionCannotObserveRegistry: true });
  }

  await denied(a, [outside]);
  const deniedRead = await a.call("read", { filePath: outside, raw: true }, { signal: AbortSignal.timeout(10_000) });
  assert.equal(deniedRead.success, false);
  const deniedWrite = await a.call("write", { filePath: outside, content: "BAD" }, { signal: AbortSignal.timeout(10_000) });
  assert.equal(deniedWrite.success, false);
  assert.equal(await fs.readFile(outside, "utf8"), sentinel);
  pass("unmounted-sentinel", { readDenied: true, writeDenied: true, hostSentinelUnchanged: true });

  assert.equal(await tool(a, "read", { filePath: path.join(readOnly, "sentinel.txt"), raw: true }), readOnlySentinel);
  const rejected = await a.call("write", { filePath: path.join(readOnly, "forbidden.txt"), content: "BAD" }, { signal: AbortSignal.timeout(10_000) });
  assert.equal(rejected.success, false);
  assert.equal(await exec(a, `try{require('node:fs').writeFileSync(process.argv[1]+'/forbidden-exec','BAD');throw Error('RO_WRITABLE')}catch(e){if(e.code!=='EROFS'&&e.code!=='EACCES')throw e}console.log('READ_ONLY_DENIED')`, readOnlyGuest), "READ_ONLY_DENIED");
  await noFile(path.join(readOnly, "forbidden.txt"));
  await noFile(path.join(readOnly, "forbidden-exec"));
  assert.equal(await fs.readFile(path.join(readOnly, "sentinel.txt"), "utf8"), readOnlySentinel);
  pass("read-only-grant", { read: readOnlySentinel, toolAndExecWritesDenied: true });

  await tool(a, "write", { filePath: path.join(approved, "allowed.txt"), content: "APPROVED_WRITE" });
  assert.equal(await fs.readFile(path.join(approved, "allowed.txt"), "utf8"), "APPROVED_WRITE");
  pass("read-write-grant", { hostContent: "APPROVED_WRITE" });
  await denied(b, [`${approvedGuest}/allowed.txt`, path.join(approved, "allowed.txt"), `${readOnlyGuest}/sentinel.txt`, path.join(workspaceA, "ordinary.txt")]);
  assert.equal(await exec(a, `require('node:fs').writeFileSync('/tmp/private-session','SESSION_A');console.log('TMP_WRITTEN')`), "TMP_WRITTEN");
  await denied(b, ["/tmp/private-session"]);
  pass("session-isolation", { grantAndHostPathsDenied: true, privateTempDenied: true, containers: [nameA, nameB] });

  const ancestorPolicy = await createSandboxPolicy({ sessionKey: `native-ancestor-${token}`, revision: 1, cwd: root, config });
  const ancestor = createSandboxSupervisor({ policy: ancestorPolicy, backend: trackedBackend, bundlePath });
  supervisors.push(ancestor);
  const refused = await ancestor.exec(["bun", "-e", "console.log('UNSAFE_ANCESTOR_LAUNCH')"], { signal: AbortSignal.timeout(30_000) });
  assert.equal(refused.success, false, "an ancestor mount would allow changing other sessions' approved roots");
  assert.match(refused.error ?? "", /SANDBOX_MOUNT_OVERLAP/);
  assert.equal(await docker(["container", "ls", "--all", "--filter", `label=dev.jeo.sandbox.session=${ancestorPolicy.sessionKey}`, "--format", "{{.ID}}"]), "");
  pass("ancestor-policy-denial", { rejectedBeforeEffects: true, noContainer: true, error: refused.error });

  const sharedPolicy = await createSandboxPolicy({ sessionKey: `native-shared-${token}`, revision: 1, cwd: workspaceA, config });
  const shared = createSandboxSupervisor({ policy: sharedPolicy, backend: trackedBackend, bundlePath });
  supervisors.push(shared);
  await tool(shared, "write", { filePath: "shared.txt", content: `SHARED-${token}` });
  assert.equal(await tool(a, "read", { filePath: "shared.txt", raw: true }), `SHARED-${token}`);
  assert.equal(await fs.readFile(path.join(workspaceA, "shared.txt"), "utf8"), `SHARED-${token}`);
  await denied(shared, [`${approvedGuest}/allowed.txt`, "/tmp/private-session"]);
  assert.deepEqual(await shared.revoke(), { gone: true, residual: [] });
  await absent(latest(sharedPolicy.sessionKey).name);
  pass("shared-workspace", { exactWorkspaceShared: true, grantsAndTempRemainPrivate: true });

  const replacedHeartbeat = path.join(approved, "replacement-heartbeat");
  const liveBytes = await heartbeat(a, `${approvedGuest}/replacement-heartbeat`, replacedHeartbeat);
  pass("detached-child", { bytesAfterTwoDetachBoundaries: liveBytes });
  const nextPolicy = await createSandboxPolicy({ sessionKey: policyA.sessionKey, revision: 2, cwd: workspaceA, config });
  await a.replacePolicy(nextPolicy);
  await absent(nameA);
  const replacementStopped = await fs.readFile(replacedHeartbeat, "utf8");
  await witness(b);
  assert.equal(await fs.readFile(replacedHeartbeat, "utf8"), replacementStopped);
  assert.equal(launches.filter(item => item.sessionKey === policyA.sessionKey).length, 1, "replacement must not eagerly launch another worker");
  pass("policy-replacement", { removed: nameA, heartbeatStopped: true, replacementIsLazy: true });

  await denied(a, [`${approvedGuest}/allowed.txt`, `${readOnlyGuest}/sentinel.txt`, "/tmp/private-session"]);
  const replacement = latest(policyA.sessionKey);
  assert.equal(replacement.revision, 2);
  assert.notEqual(replacement.name, nameA);
  assert.equal(await tool(a, "read", { filePath: "ordinary.txt", raw: true }), payload);
  const revokedGrantWrite = await a.call("write", { filePath: `${approvedGuest}/after-replacement`, content: "BAD" }, { signal: AbortSignal.timeout(10_000) });
  assert.equal(revokedGrantWrite.success, false);
  await noFile(path.join(approved, "after-replacement"));
  pass("replacement-isolation", { revision: 2, container: replacement.name, oldGrantsAndTempDenied: true, workspacePreserved: true });

  const revokedHeartbeat = path.join(workspaceA, "revoke-heartbeat");
  await heartbeat(a, "/workspace/revoke-heartbeat", revokedHeartbeat);
  assert.deepEqual(await a.revoke(), { gone: true, residual: [] });
  await absent(replacement.name);
  const revokedStopped = await fs.readFile(revokedHeartbeat, "utf8");
  await witness(b);
  assert.equal(await fs.readFile(revokedHeartbeat, "utf8"), revokedStopped);
  assert.equal(await fs.readFile(replacedHeartbeat, "utf8"), replacementStopped);
  pass("revocation", { removed: replacement.name, detachedWritersStopped: true, otherSessionUsable: true });
  const before = launches.length;
  for (const result of [
    await a.exec(["bun", "-e", "require('node:fs').writeFileSync('/workspace/resurrected','BAD')"]),
    await a.call("write", { filePath: "resurrected", content: "BAD" }),
  ]) {
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /revok|closed|blocked/i);
  }
  assert.equal(launches.length, before);
  await noFile(path.join(workspaceA, "resurrected"));
  await absent(nameA);
  await absent(replacement.name);
  pass("post-revoke-denial", { staleExecAndToolRejected: true, newContainers: 0, noHostArtifact: true });
} catch (error) {
  failure = message(error);
} finally {
  for (const supervisor of supervisors.reverse()) {
    try {
      assert.deepEqual(await supervisor.revoke(), { gone: true, residual: [] });
      await supervisor.close();
    } catch (error) { cleanupErrors.push(message(error)); }
  }
  for (const launch of launches) {
    try { await absent(launch.name); confirmedAbsent.push(launch.name); }
    catch (error) { cleanupErrors.push(message(error)); }
  }
  if (root && cleanupErrors.length === 0) {
    try { await fs.rm(root, { recursive: true, force: true }); }
    catch (error) { cleanupErrors.push(message(error)); }
  }
}
const passed = new Set(checks.map(check => check.contract));
const status = failure || cleanupErrors.length || passed.size !== contracts.length ? "FAIL" : "PASS";
console.log(JSON.stringify({
  status, command: "bun scripts/verify-sandbox-isolation.ts",
  host: { platform: process.platform, arch: process.arch }, guest, image, config, checks,
  ...(failure ? { failedContract: current, error: failure } : {}),
  notRun: contracts.filter(contract => !passed.has(contract) && (!failure || contract !== current)),
  cleanup: { status: cleanupErrors.length ? "FAIL" : "PASS", errors: cleanupErrors, containersConfirmedAbsent: confirmedAbsent, fixturesRemoved: !!root && cleanupErrors.length === 0 },
  ...(status === "FAIL" ? { diagnostics: launches.filter(launch => launch.stderr).map(launch => ({ name: launch.name, stderr: launch.stderr })) } : {}),
  qualification: "Only the reported native host is qualified. A Linux guest on macOS is neither Linux-host nor Windows-host evidence.",
}, null, 2));
if (status !== "PASS") process.exitCode = 1;
