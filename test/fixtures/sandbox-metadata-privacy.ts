import { mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Message } from "../../src/agent/loop";
import type { SandboxSupervisor } from "../../src/agent/sandbox/types";

const [mode, root, sourceRoot] = process.argv.slice(2) as [string, string, string];
const source = (name: string) => path.join(sourceRoot, "src", name);
const originalReadFile = fs.readFile.bind(fs);

// These imports intentionally exercise the module-loading boundary: policy and
// provider seams must be installed before state/catalog/memory evaluate.
if (mode === "guest") {
  const { createWorkflowStateTool } = await import(source("agent/state.ts"));
  const request = JSON.parse(await Bun.stdin.text());
  const result = await createWorkflowStateTool()(request.args, request.cwd);
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

const nativeHome = path.join(root, "native-home");
const runtimeHome = path.join(root, "runtime-home");
const host = path.join(root, "host");
const guest = path.join(root, "guest");
const privateDir = path.join(root, "private");
await Promise.all([nativeHome, runtimeHome, host, guest, privateDir].map(dir => fs.mkdir(dir, { recursive: true })));
const policy = await import(source("agent/sandbox/policy.ts"));
mock.module(source("agent/sandbox/policy.ts"), () => ({ ...policy, nativeSandboxHome: async () => nativeHome }));
const { withSandboxExecution } = await import(source("agent/hooks.ts"));
const catalog = await import(source("skills/catalog.ts"));
const loop = await import(source("agent/loop.ts"));
const memory = await import(source("agent/memory.ts"));

const rpc: unknown[] = [];
const guestLogs: string[] = [];
const mounts = [{ host, guest }];
const supervisor: SandboxSupervisor = {
  toolMap() { throw new Error("No model tools in metadata fixture"); },
  async call(tool, args, options) {
    if (tool !== "__workflow") throw new Error(`Unexpected tool ${tool}`);
    const cwd = options?.cwd ?? host;
    const mount = mounts.find(item => cwd === item.host || cwd.startsWith(item.host + path.sep));
    if (!mount) throw new Error(`Unmapped guest request: ${cwd}`);
    const guestCwd = path.join(mount.guest, path.relative(mount.host, cwd));
    rpc.push({ tool, args, cwd });
    await fs.mkdir(guestCwd, { recursive: true });
    const child = Bun.spawn([process.execPath, "--no-env-file", import.meta.path, "guest", root, sourceRoot], {
      cwd: guestCwd,
      env: { PATH: process.env.PATH ?? "", HOME: path.join(root, "guest-home"), JEO_CONFIG_DIR: path.join(root, "guest-config") },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    child.stdin.write(JSON.stringify({ args, cwd: guestCwd }));
    child.stdin.end();
    const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    guestLogs.push(error);
    if (exit !== 0) throw new Error(`Guest dispatcher failed (${exit}): ${error}`);
    const result = JSON.parse(output);
    rpc.push({ result });
    return result;
  },
  async exec() { throw new Error("No shell execution in metadata fixture"); },
  async replacePolicy() {},
  async revoke() { return { gone: true, residual: [] }; },
  async close() {},
};
const run = <T>(fn: () => T) => withSandboxExecution({ supervisor }, fn);

async function filesUnder(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [name, bytes] of Object.entries(await filesUnder(target))) files[path.join(entry.name, name)] = bytes;
    } else if (entry.isFile()) files[entry.name] = await originalReadFile(target, "utf8");
  }
  return files;
}

if (mode === "memory") {
  const history: Message[] = [
    { role: "system", content: "SYSTEM-PROMPT-PRIVATE-8c7d" },
    { role: "user", content: "HISTORY-PRIVATE-2f9a investigate failure" },
    { role: "assistant", content: "HISTORY-PRIVATE-2f9a reproduce failure" },
    { role: "user", content: "HISTORY-PRIVATE-2f9a verify remedy" },
    { role: "assistant", content: "HISTORY-PRIVATE-2f9a verified" },
  ];
  const derived = { concepts: [{ type: "Command", title: "Focused verification", description: "Run the focused test", body: "Use bun test test/focused.test.ts after a change.", confidence: "high" }] };
  let parentSawHistory = false;
  const llm = spyOn(loop, "callLlm").mockImplementation(async (messages: Message[]) => {
    parentSawHistory = JSON.stringify(messages).includes("HISTORY-PRIVATE-2f9a");
    return JSON.stringify(derived);
  });
  let detachedSpawns = 0;
  const spawn = () => { detachedSpawns++; return { unref() {} }; };
  const updated = await run(() => memory.spawnDetachedDistill(history, host, "fixture/no-network", spawn));
  const distillRpc = JSON.stringify(rpc);
  const sharedFiles = await filesUnder(guest);
  const hostFiles = await filesUnder(host);
  let rawError = "";
  try { await run(() => memory.saveRawPayload(path.join(host, ".jeo", "memory"), { messages: history })); }
  catch (error) { rawError = String(error); }
  const afterRawFiles = await filesUnder(guest);
  const rejectedRawRpc = await supervisor.call("__workflow", { operation: "memory", action: "saveRaw", payload: { messages: history } }, { cwd: host });
  const plain = path.join(root, "plain");
  await fs.mkdir(plain);
  const plainSpawned = await memory.spawnDetachedDistill(history, plain, "fixture/no-network", spawn);
  const pending = Object.entries(await filesUnder(plain)).find(([name]) => path.basename(name).startsWith("pending-distill-"));
  await memory.saveRawPayload(path.join(plain, ".jeo", "memory"), { messages: history });
  const retained = Object.entries(await filesUnder(plain)).find(([name]) => name.includes(`${path.sep}raw${path.sep}`));
  llm.mockRestore();
  process.stdout.write(JSON.stringify({ updated, parentSawHistory, detachedSpawns, distillRpc, sharedFiles, hostFiles, rawError, afterRawFiles, rejectedRawRpc, plainSpawned, pending: pending ? JSON.parse(pending[1]) : null, retained: retained ? JSON.parse(retained[1]) : null, guestLogs }));
  process.exit(0);
}

const sentinel = "PARENT-PRIVATE-CATALOG-a81e";
const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: ${body}\n---\n# ${name}\n${body}\n`;
const sentinelFile = path.join(privateDir, "SKILL.md");
await fs.writeFile(sentinelFile, skill("stolen-parent", sentinel));
const parentReads: string[] = [];
const readObserver = spyOn(fs, "readFile").mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
  const file = String(args[0]);
  parentReads.push(await fs.realpath(file).catch(() => path.resolve(file)));
  return originalReadFile(...args);
});
let unsafeRoot: string | undefined;

if (mode === "protected") {
  process.env.HOME = nativeHome;
  process.env.JEO_CONFIG_DIR = path.join(nativeHome, ".jeo");
  const store = path.join(root, "protected-store");
  const claudeSkills = path.join(nativeHome, ".claude", "skills");
  const nativeSkills = path.join(nativeHome, ".jeo", "skills");
  await Promise.all([path.join(store, "skills", "protected-store"), path.join(store, "alias-only"), claudeSkills, nativeSkills].map(dir => fs.mkdir(dir, { recursive: true })));
  await fs.symlink(store, path.join(nativeHome, ".agents"));
  await fs.symlink("../../.agents/alias-only", path.join(claudeSkills, "protected-alias"));
  await fs.writeFile(path.join(store, "alias-only", "SKILL.md"), skill("protected-alias", "Protected native alias guidance"));
  await fs.writeFile(path.join(store, "skills", "protected-store", "SKILL.md"), skill("protected-store", "Canonical protected store guidance"));
  await fs.writeFile(path.join(nativeSkills, "protected-native.md"), skill("protected-native", "Protected native install guidance"));
  // Keep the literal '..' after the workspace hop; path.join would erase it.
  await fs.symlink(`${host}/../private`, path.join(store, "skills", "escape"));
} else {
  process.env.HOME = runtimeHome;
  process.env.JEO_CONFIG_DIR = path.join(runtimeHome, ".jeo");
  unsafeRoot = mode === "home" ? path.join(runtimeHome, ".agents", "skills") : path.join(root, "shared-skills");
  if (mode !== "home") process.env.JEO_SKILLS_DIR = unsafeRoot;
  await fs.mkdir(path.join(unsafeRoot, "mutable"), { recursive: true });
  await fs.writeFile(path.join(unsafeRoot, "mutable", "SKILL.md"), skill("stale-parent", "Unprotected parent bytes"));
  // A second session with this root authorizedRW can replace SKILL.md before
  // this session snapshots: it must never become a trusted brain-side read.
  await fs.unlink(path.join(unsafeRoot, "mutable", "SKILL.md"));
  await fs.symlink(sentinelFile, path.join(unsafeRoot, "mutable", "SKILL.md"));
  if (mode !== "unmounted") {
    const guestRoot = path.join(root, "guest-skills");
    await fs.mkdir(path.join(guestRoot, "mutable"), { recursive: true });
    await fs.writeFile(path.join(guestRoot, "mutable", "SKILL.md"), skill("guest-guidance", "Guest authorized guidance"));
    mounts.push({ host: unsafeRoot, guest: guestRoot });
  }
}
const readable = unsafeRoot && mode !== "unmounted" ? [unsafeRoot] : [];
await catalog.prepareSandboxSkillCatalog(supervisor, host, [], readable);
const skills = await run(() => catalog.loadSkills(host));
const result = {
  skills: skills.filter((item: { sourcePath?: string }) => item.sourcePath),
  parentReadSentinel: parentReads.includes(sentinelFile),
  parentReads, rpc, guestLogs, unsafeRoot,
};
readObserver.mockRestore();
process.stdout.write(JSON.stringify(result));
process.exit(0);
