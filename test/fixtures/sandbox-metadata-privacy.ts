import { mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import * as ffi from "bun:ffi";
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
let raced = false;
if (mode === "skill-asset-directory-race") {
  // This subprocess intentionally mocks the FFI boundary before catalog import.
  const original = { ...ffi };
  mock.module("bun:ffi", () => ({
    ...original,
    dlopen(...args: Parameters<typeof ffi.dlopen>) {
      const library = original.dlopen(...args);
      const openat = library.symbols.openat;
      return {
        ...library,
        symbols: {
          ...library.symbols,
          openat(fd: number, name: Buffer, flags: number) {
            if (name.toString() === "guide.txt\0") {
              const dir = path.join(nativeHome, ".agents", "skills", "allowed", "references");
              const moved = path.join(privateDir, "moved-references");
              renameSync(dir, moved);
              mkdirSync(dir);
              writeFileSync(path.join(moved, "guide.txt"), "PRIVATE-RACE-CONTENT");
              raced = true;
            }
            return openat(fd, name, flags);
          },
        },
      };
    },
  }));
}
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

if (mode === "skill-asset-directory-race") {
  process.env.HOME = nativeHome;
  process.env.JEO_CONFIG_DIR = path.join(nativeHome, ".jeo");
  const dir = path.join(nativeHome, ".agents", "skills", "allowed", "references");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "guide.txt");
  await fs.writeFile(file, "APPROVED-CONTENT");
  let rejected = false;
  let content = "";
  try {
    const snapshot = await catalog.snapshotSandboxSkillAssets(host, path.join(root, "race-snapshot"), [], [file]);
    const target = snapshot.resources?.get(file);
    if (target) content = await fs.readFile(target, "utf8");
  } catch { rejected = true; }
  process.stdout.write(JSON.stringify({ raced, rejected, content }));
  process.exit(0);
}

if (mode === "skill-asset-authorization" || mode === "skill-asset-authorization-native") {
  process.env.HOME = nativeHome;
  process.env.JEO_CONFIG_DIR = path.join(nativeHome, ".jeo");
  const store = path.join(nativeHome, ".agents", "skills");
  const allowed = path.join(store, "allowed");
  const denied = path.join(store, "denied");
  await Promise.all([fs.mkdir(path.join(allowed, "references"), { recursive: true }), fs.mkdir(denied, { recursive: true })]);
  const doc = path.join(allowed, "SKILL.md");
  const support = path.join(allowed, "references", "guide.txt");
  await fs.writeFile(doc, "---\nname: allowed\ndescription: Approved skill\n---\nRead references/guide.txt\n");
  await fs.writeFile(support, "APPROVED-SUPPORT");
  await fs.writeFile(path.join(allowed, "references", "unapproved.txt"), "UNAPPROVED-SUPPORT");
  await fs.writeFile(path.join(denied, "SKILL.md"), "---\nname: denied\ndescription: Private skill\n---\nPRIVATE-SKILL\n");
  await fs.writeFile(path.join(privateDir, "secret.txt"), "PRIVATE-SECRET");
  await fs.symlink(path.join(privateDir, "secret.txt"), path.join(allowed, "references", "escape.txt"));
  await fs.link(path.join(privateDir, "secret.txt"), path.join(allowed, "references", "hardlink.txt"));
  await fs.symlink(path.join(privateDir), path.join(allowed, "references", "linked-directory"));
  const invalid = {
    directory: allowed,
    symlink: path.join(allowed, "references", "escape.txt"),
    intermediateSymlink: path.join(allowed, "references", "linked-directory", "secret.txt"),
    hardlink: path.join(allowed, "references", "hardlink.txt"),
    traversal: `${allowed}/../allowed/SKILL.md`,
    outside: path.join(privateDir, "secret.txt"),
    wildcard: path.join(allowed, "references", "*.txt"),
    relative: "allowed/SKILL.md",
  };
  const rejected: Record<string, boolean> = {};
  for (const [name, file] of Object.entries(invalid)) {
    try { await catalog.snapshotSandboxSkillAssets(host, path.join(root, `invalid-${name}`), [], [file]); rejected[name] = false; }
    catch { rejected[name] = true; }
  }
  const snapshot = await catalog.snapshotSandboxSkillAssets(host, path.join(root, "approved-snapshot"), [], [doc, support]);
  const mapped = snapshot.paths.get(doc);
  if (mode === "skill-asset-authorization-native") {
    // Runtime-selected source root avoids module mocks from the test runner.
    const { createSandboxSupervisor } = await import(sourceRoot + "/src/agent/sandbox/supervisor.ts");
    const nativePolicy = await policy.createSandboxPolicy({ sessionKey: "authorization-native", revision: 1, cwd: host, config: { backend: "native" } });
    const native = createSandboxSupervisor({ policy: nativePolicy, readOnlyRoots: [snapshot.root] });
    try {
      await catalog.prepareSandboxSkillCatalog(native, host, [], [], snapshot);
      const loaded = await withSandboxExecution({ supervisor: native }, () => catalog.loadSkills(host));
      const selected = loaded.find(item => item.name === "allowed");
      if (!selected?.sourcePath) throw new Error("Authorized skill missing from catalog");
      const resources = selected.sandboxResources ?? [];
      const task = catalog.buildSkillTask(selected, "Use the approved helper");
      const helper = resources.find(resource => resource.source === support);
      if (!helper) throw new Error("Approved helper missing from task resource mapping");
      const directory = path.dirname(selected.sourcePath);
      const permitted = await native.exec(["/bin/cat", helper.snapshot]);
      const unapproved = await native.exec(["/bin/cat", path.join(directory, "references", "unapproved.txt")]);
      const original = await native.exec(["/bin/cat", path.join(denied, "SKILL.md")]);
      const escaped = await native.exec(["/bin/cat", path.join(directory, "references", "escape.txt")]);
      const write = await native.exec(["/bin/sh", "-c", 'printf changed > "$1"', "sh", path.join(directory, "references", "guide.txt")]);
      process.stdout.write(JSON.stringify({ permitted, unapproved, original, escaped, write, resources, task, support, snapshotRoot: snapshot.root }));
    } finally { await native.close(); }
    process.exit(0);
  }
  await catalog.prepareSandboxSkillCatalog(supervisor, host, [], [], snapshot);
  const skills = await run(() => catalog.loadSkills(host));
  const snapshotFiles = await filesUnder(snapshot.root);
  const noSnapshotSupervisor = { ...supervisor };
  await catalog.prepareSandboxSkillCatalog(noSnapshotSupervisor, host);
  const noSnapshotSkills = await withSandboxExecution({ supervisor: noSnapshotSupervisor }, () => catalog.loadSkills(host));
  process.stdout.write(JSON.stringify({ mapped, skills: skills.map(item => ({ name: item.name, raw: item.raw })), noSnapshotSkills: noSnapshotSkills.map(item => item.name), snapshotFiles, rejected }));
  process.exit(0);
}

if (mode === "skill-assets" || mode === "skill-assets-native") {
  process.env.HOME = nativeHome;
  process.env.JEO_CONFIG_DIR = path.join(nativeHome, ".jeo");
  const store = path.join(nativeHome, ".agents", "skills");
  const source = path.join(store, "real");
  const alias = path.join(store, "alias");
  await fs.mkdir(path.join(source, "references"), { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), "# fixture\nRead references/guide.txt\n");
  await fs.writeFile(path.join(source, "references", "guide.txt"), "trusted-support");
  await fs.writeFile(path.join(privateDir, "secret.txt"), "private-secret");
  await fs.symlink("real", alias);
  await fs.symlink(path.join(privateDir, "secret.txt"), path.join(source, "references", "escape.txt"));
  await fs.symlink("cycle-b", path.join(source, "references", "cycle-a"));
  await fs.symlink("cycle-a", path.join(source, "references", "cycle-b"));
  const snapshot = await catalog.snapshotSandboxSkillAssets(host, path.join(root, "snapshot"), [], [path.join(source, "SKILL.md"), path.join(source, "references", "guide.txt")]);
  const mapped = snapshot.paths.get(path.join(source, "SKILL.md"));
  let aliasRejected = false;
  try { await catalog.snapshotSandboxSkillAssets(host, path.join(root, "alias-snapshot"), [], [path.join(alias, "SKILL.md")]); }
  catch { aliasRejected = true; }
  if (mode === "skill-assets-native") {
    // Runtime-selected source root keeps this fixture isolated from the test runner's module mocks.
    const { createSandboxSupervisor } = await import(sourceRoot + "/src/agent/sandbox/supervisor.ts");
    const nativePolicy = await policy.createSandboxPolicy({ sessionKey: "skill-assets-native", revision: 1, cwd: host, config: { backend: "native" } });
    const native = createSandboxSupervisor({ policy: nativePolicy, readOnlyRoots: [snapshot.root] });
    try {
      await catalog.prepareSandboxSkillCatalog(native, host, [], [], snapshot);
      const skills = await withSandboxExecution({ supervisor: native }, () => catalog.loadSkills(host));
      const selected = skills.find((item: { name: string }) => item.name === "real");
      if (!selected?.sourcePath) throw new Error("Snapshot skill missing from sandbox catalog");
      const supportPath = path.join(path.dirname(selected.sourcePath), "references", "guide.txt");
      const support = await native.exec(["/bin/cat", supportPath]);
      const secret = await native.exec(["/bin/cat", path.join(privateDir, "secret.txt")]);
      const write = await native.exec(["/bin/sh", "-c", 'printf overwritten > "$1"', "sh", supportPath]);
      process.stdout.write(JSON.stringify({ sourcePath: selected.sourcePath, snapshotRoot: snapshot.root, support, secret, write }));
    } finally { await native.close(); }
    process.exit(0);
  }
  await fs.writeFile(path.join(source, "references", "guide.txt"), "changed-after-snapshot");
  const result = {
    mapped,
    aliasRejected,
    content: mapped && await fs.readFile(mapped, "utf8"),
    support: mapped && await fs.readFile(path.join(path.dirname(mapped), "references", "guide.txt"), "utf8"),
    escaped: mapped && await fs.readFile(path.join(path.dirname(mapped), "references", "escape.txt"), "utf8").catch(() => null),
    cycle: mapped && await fs.readFile(path.join(path.dirname(mapped), "references", "cycle-a"), "utf8").catch(() => null),
  };
  process.stdout.write(JSON.stringify(result));
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
  const store = path.join(nativeHome, ".agents", "skills");
  const claudeSkills = path.join(nativeHome, ".claude", "skills");
  const nativeSkills = path.join(nativeHome, ".jeo", "skills");
  await Promise.all([path.join(store, "protected-store"), path.join(claudeSkills, "protected-claude"), nativeSkills].map(dir => fs.mkdir(dir, { recursive: true })));
  await fs.writeFile(path.join(claudeSkills, "protected-claude", "SKILL.md"), skill("protected-claude", "Protected native Claude guidance"));
  await fs.writeFile(path.join(store, "protected-store", "SKILL.md"), skill("protected-store", "Canonical protected store guidance"));
  await fs.writeFile(path.join(nativeSkills, "protected-native.md"), skill("protected-native", "Protected native install guidance"));
  // Keep the literal '..' after the workspace hop; path.join would erase it.
  await fs.symlink(`${host}/../private`, path.join(store, "escape"));
  await fs.symlink(path.join(store, "protected-store"), path.join(claudeSkills, "protected-alias"));
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
const protectedFiles = mode === "protected" ? [path.join(nativeHome, ".claude", "skills", "protected-claude", "SKILL.md"), path.join(nativeHome, ".agents", "skills", "protected-store", "SKILL.md"), path.join(nativeHome, ".jeo", "skills", "protected-native.md")] : [];
const protectedSnapshot = mode === "protected" ? await catalog.snapshotSandboxSkillAssets(host, path.join(root, "protected-snapshot"), [], protectedFiles) : undefined;
await catalog.prepareSandboxSkillCatalog(supervisor, host, [], readable, protectedSnapshot);
const skills = await run(() => catalog.loadSkills(host));
const result = {
  skills: skills.filter((item: { sourcePath?: string }) => item.sourcePath),
  parentReadSentinel: parentReads.includes(sentinelFile),
  parentReads, rpc, guestLogs, unsafeRoot,
};
readObserver.mockRestore();
process.stdout.write(JSON.stringify(result));
process.exit(0);
