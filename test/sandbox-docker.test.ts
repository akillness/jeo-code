import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDockerBackend } from "../src/agent/sandbox/docker";
import { createSandboxPolicy } from "../src/agent/sandbox/policy";
import { createServer } from "node:net";
import type { SandboxPolicy, SandboxProcess } from "../src/agent/sandbox/types";

const config = {
  image: "fixture/bun:qualified",
  limits: { memoryBytes: 128 * 1024 * 1024, pids: 32, cpus: 0.5 },
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-container-policy-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const granted = path.join(root, "granted");
  const privatePath = path.join(root, "private-control");
  await Promise.all([workspace, granted, privatePath].map((dir) => fs.mkdir(dir)));
  return { root: await fs.realpath(root), workspace, granted, privatePath };
}

test("canonical aliases identify the same approved resource and policy digest", async () => {
  const { root, workspace, granted } = await fixture();
  const alias = path.join(root, "grant-alias");
  await fs.symlink(granted, alias, process.platform === "win32" ? "junction" : "dir");
  const first = await createSandboxPolicy({ sessionKey: "canonical-session", revision: 7, cwd: workspace, config, grants: [{ host: granted, mode: "ro" }] });
  const second = await createSandboxPolicy({ sessionKey: "canonical-session", revision: 7, cwd: path.join(workspace, "."), config, grants: [{ host: alias, mode: "ro" }] });
  expect(second.digest).toBe(first.digest);
  expect(second.mounts).toEqual(first.mounts);
  const canonical = await fs.realpath(granted);
  expect(second.mounts.find((mount) => mount.host === canonical)?.mode).toBe("ro");
});

test("host root cannot become the workspace or an extra grant", async () => {
  const { workspace } = await fixture();
  const hostRoot = path.parse(workspace).root;
  await expect(createSandboxPolicy({ sessionKey: "root-workspace", revision: 1, cwd: hostRoot, config })).rejects.toThrow();
  await expect(createSandboxPolicy({ sessionKey: "root-grant", revision: 1, cwd: workspace, config, grants: [{ host: hostRoot, mode: "rw" }] })).rejects.toThrow();
});

test("canonical symlinks cannot launder private control files into a grant", async () => {
  const { root, workspace, privatePath } = await fixture();
  const alias = path.join(root, "looks-public");
  await fs.symlink(privatePath, alias, process.platform === "win32" ? "junction" : "dir");
  await expect(createSandboxPolicy({ sessionKey: "private-alias", revision: 1, cwd: workspace, config, privatePaths: [privatePath], grants: [{ host: alias, mode: "rw" }] })).rejects.toThrow();
  await expect(createSandboxPolicy({ sessionKey: "private-parent", revision: 1, cwd: workspace, config, privatePaths: [privatePath], grants: [{ host: root, mode: "ro" }] })).rejects.toThrow();
});

test.skipIf(process.platform === "win32")("Docker control sockets cannot enter a policy through a canonical alias", async () => {
  const { root, workspace } = await fixture();
  const socket = path.join(root, "docker.sock");
  const alias = path.join(root, "innocent-resource");
  await fs.writeFile(socket, "fixture Docker control endpoint");
  await fs.symlink(socket, alias);
  await expect(createSandboxPolicy({ sessionKey: "docker-socket", revision: 1, cwd: workspace, config, grants: [{ host: alias, mode: "rw" }] })).rejects.toThrow();
});

for (const [name, limits] of [
  ["zero memory", { ...config.limits, memoryBytes: 0 }],
  ["negative memory", { ...config.limits, memoryBytes: -1 }],
  ["infinite CPU", { ...config.limits, cpus: Infinity }],
  ["NaN CPU", { ...config.limits, cpus: NaN }],
  ["zero PID budget", { ...config.limits, pids: 0 }],
  ["fractional PID budget", { ...config.limits, pids: 1.5 }],
] as const) {
  test(`invalid deployment limit fails closed: ${name}`, async () => {
    const { workspace } = await fixture();
    await expect(createSandboxPolicy({ sessionKey: "invalid-limits", revision: 1, cwd: workspace, config: { ...config, limits } })).rejects.toThrow();
  });
}

// Stateful external-boundary fake: CLI success and actual container presence
// are deliberately independent so a lying removal cannot pass revocation.
test("missing Docker cannot produce a usable image qualification", async () => {
  const backend = createDockerBackend({
    env: {},
    run: async () => { throw Object.assign(new Error("Docker executable not found"), { code: "ENOENT" }); },
  });
  await expect(backend.preflight(config)).rejects.toThrow(/Docker|docker|ENOENT/);
});

const imageA = `sha256:${"a".repeat(64)}`;
const imageB = `sha256:${"b".repeat(64)}`;
type DockerMount = { Type: string; Source: string; Destination: string; RW: boolean };
type Container = { name: string; image: string; labels: Record<string, string>; running: boolean; mounts?: DockerMount[]; finish?: (code: number) => void };

class DockerDaemon {
  readonly containers = new Map<string, Container>();
  readonly mutations: string[] = [];
  endpoint = "unix:///fixture/docker.sock";
  osType = "linux";
  imagePresent = true;
  imageTag = imageA;
  retagAfterInspect = false;
  removalLies = false;
  inspectFails = false;
  available = true;
  pulls = 0;
  afterCreate?: () => Promise<void>;

  private reply(value: unknown) {
    return { exitCode: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" };
  }

  private missing(message: string) { return { exitCode: 1, stdout: "", stderr: message }; }

  private args(argv: readonly string[]) { return /(^|[\\/])docker(\.exe)?$/i.test(argv[0] ?? "") ? argv.slice(1) : [...argv]; }

  private option(args: readonly string[], name: string) {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  }

  private formatted(args: readonly string[], value: unknown) {
    const format = this.option(args, "--format");
    if (!format) return this.reply(value);
    const record = Array.isArray(value) ? value[0] : value;
    const field = format.match(/\.(\w+(?:\.\w+)*)/)?.[1];
    let selected: unknown = record;
    if (field) for (const key of field.split(".")) selected = typeof selected === "object" && selected !== null ? (selected as Record<string, unknown>)[key] : undefined;
    return this.reply(format.includes("json") ? JSON.stringify(selected ?? record) : String(selected ?? ""));
  }

  run = async (argv: readonly string[]) => {
    const args = this.args(argv);
    const command = args[0];
    if (!this.available && command !== "context") return this.missing("Cannot connect to Docker daemon");
    if (command === "context") {
      if (args[1] === "show") return this.reply("fixture-local");
      return this.formatted(args, [{ Name: "fixture-local", Endpoints: { docker: { Host: this.endpoint } } }]);
    }
    if (command === "version") return this.formatted(args, { Server: { Os: this.osType, Arch: "arm64", Version: "28.0.0" }, Client: { Version: "28.0.0" } });
    if (command === "info") return this.formatted(args, { OSType: this.osType, Architecture: "aarch64", ServerVersion: "28.0.0" });
    if (command === "pull" || (command === "image" && args[1] === "pull")) { this.pulls++; return this.missing("pull forbidden in test"); }
    if (command === "image" && args[1] === "inspect") {
      if (!this.imagePresent) return this.missing("Error: No such image: fixture/bun:qualified");
      const result = this.formatted(args, [{ Id: this.imageTag, Os: "linux", Architecture: "arm64", RepoTags: [config.image] }]);
      if (this.retagAfterInspect) this.imageTag = imageB;
      return result;
    }
    if (command === "create" || command === "run") {
      this.mutations.push(command);
      const name = this.option(args, "--name");
      if (!name) return this.missing("fixture requires a generated container name");
      const labels: Record<string, string> = {};
      for (let i = 0; i < args.length; i++) {
        const label = args[i] === "--label" ? args[++i] : args[i]?.startsWith("--label=") ? args[i]?.slice(8) : undefined;
        if (label) { const split = label.indexOf("="); labels[label.slice(0, split)] = label.slice(split + 1); }
      }
      const selected = args.find((arg) => arg === imageA || arg === imageB || arg === config.image);
      if (!selected) return this.missing("fixture image not selected");
      const mounts: DockerMount[] = [];
      for (let index = 0; index < args.length; index++) {
        const mount = args[index] === "--mount" ? args[++index] : undefined;
        if (!mount) continue;
        const fields = Object.fromEntries(mount.split(",").map((field) => field.split("=")));
        if (!fields.source || !fields.target) throw new Error("Invalid fixture mount");
        mounts.push({ Type: "bind", Source: fields.source, Destination: fields.target, RW: !mount.split(",").includes("readonly") });
      }
      this.containers.set(name, { name, image: selected === config.image ? this.imageTag : selected, labels, mounts, running: command === "run" });
      await this.afterCreate?.();
      return this.reply(name);
    }
    if (command === "start") {
      const container = this.containers.get(args.at(-1) ?? "");
      if (!container) return this.missing("No such container");
      container.running = true;
      return this.reply(container.name);
    }
    if (command === "rm" || command === "stop" || command === "kill") {
      this.mutations.push(command);
      for (const arg of args.slice(1)) {
        const container = this.containers.get(arg);
        if (!container) continue;
        if (command === "rm" && !this.removalLies) { this.containers.delete(arg); container.finish?.(137); }
        else if (command !== "rm") { container.running = false; container.finish?.(137); }
      }
      return this.reply("");
    }
    if (command === "inspect" || (command === "container" && args[1] === "inspect")) {
      if (this.inspectFails) return this.missing("Cannot connect to Docker daemon");
      const container = this.containers.get(args.at(-1) ?? "");
      if (!container) return this.missing(`Error: No such container: ${args.at(-1)}`);
      return this.formatted(args, [{ Id: container.name, Name: `/${container.name}`, Config: { Labels: container.labels }, Mounts: container.mounts, State: { Running: container.running } }]);
    }
    if (command === "ps" || (command === "container" && args[1] === "ls")) {
      if (this.inspectFails) return this.missing("Cannot connect to Docker daemon");
      let containers = [...this.containers.values()];
      for (let i = 0; i < args.length; i++) if (args[i] === "--filter") {
        const filter = args[++i] ?? "";
        if (filter.startsWith("label=")) { const [key, value] = filter.slice(6).split("="); containers = containers.filter((container) => key !== undefined && (value === undefined ? key in container.labels : container.labels[key] === value)); }
        if (filter.startsWith("name=")) { const name = filter.slice(5).replace(/^\^\//, "").replace(/\$$/, ""); containers = containers.filter((container) => container.name === name); }
      }
      return this.reply(containers.map((container) => container.name).join("\n"));
    }
    return this.missing(`Unexpected Docker command: ${args.join(" ")}`);
  };

  spawn = (argv: readonly string[]) => {
    const args = this.args(argv);
    const name = args.at(-1) ?? "";
    const container = this.containers.get(name);
    if (!container) throw new Error(`Cannot attach missing fixture container ${name}`);
    container.running = true;
    const lifecycle = Promise.withResolvers<number>();
    container.finish = lifecycle.resolve;
    const exited = lifecycle.promise;
    return {
      stdin: { write(_data: string) {}, flush() {}, end() {} },
      stdout: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
      stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
      exited,
      kill() { container.finish?.(137); },
    };
  };

  backend(env: Record<string, string | undefined> = {}) {
    return createDockerBackend({ run: this.run, spawn: this.spawn, env, platform: "linux" });
  }
}

async function launchFixture(daemon: DockerDaemon, sessionKey = "session-a") {
  const { root, workspace } = await fixture();
  const bundle = path.join(root, "worker.js");
  await fs.writeFile(bundle, "process.stdin.resume();");
  const backend = daemon.backend();
  const policy = await createSandboxPolicy({ sessionKey, revision: 1, cwd: workspace, config });
  return { backend, policy, process: await backend.launch(policy, bundle) };
}

test("a missing local image fails without downloading or starting a container", async () => {
  const daemon = new DockerDaemon();
  daemon.imagePresent = false;
  await expect(daemon.backend().preflight(config)).rejects.toThrow(/image/i);
  expect(daemon.pulls).toBe(0);
  expect(daemon.containers.size).toBe(0);
  expect(daemon.mutations).toEqual([]);
});

test("an unreachable local daemon cannot qualify or launch a host fallback", async () => {
  const daemon = new DockerDaemon();
  daemon.available = false;
  await expect(daemon.backend().preflight(config)).rejects.toThrow(/daemon|Docker|docker/);
  expect(daemon.containers.size).toBe(0);
  expect(daemon.mutations).toEqual([]);
  expect(daemon.pulls).toBe(0);
});

for (const endpoint of ["tcp://127.0.0.1:2375", "tcp://remote.example:2376", "ssh://remote.example", "https://remote.example:2376"]) {
  test(`remote Docker endpoint fails closed: ${endpoint}`, async () => {
    const daemon = new DockerDaemon();
    await expect(daemon.backend({ DOCKER_HOST: endpoint }).preflight(config)).rejects.toThrow(/local|remote|endpoint/i);
    expect(daemon.containers.size).toBe(0);
    expect(daemon.pulls).toBe(0);
  });
}

test("remote Docker context and Windows guest daemon cannot qualify local Linux hands", async () => {
  const remote = new DockerDaemon();
  remote.endpoint = "ssh://remote.example";
  await expect(remote.backend().preflight(config)).rejects.toThrow(/local|remote|endpoint/i);
  const windows = new DockerDaemon();
  windows.osType = "windows";
  await expect(windows.backend().preflight(config)).rejects.toThrow(/linux/i);
  expect(remote.mutations).toEqual([]);
  expect(windows.mutations).toEqual([]);
});

test("retagging a local image after qualification cannot change the launched image", async () => {
  const daemon = new DockerDaemon();
  daemon.retagAfterInspect = true;
  const launched = await launchFixture(daemon);
  try {
    expect(daemon.containers.get(launched.process.name)?.image).toBe(imageA);
    expect(daemon.pulls).toBe(0);
  } finally { await launched.process.stop(); }
});

test("successful CLI removal is not revocation when the owned container remains", async () => {
  const daemon = new DockerDaemon();
  const launched = await launchFixture(daemon);
  daemon.removalLies = true;
  const result = await launched.process.stop();
  expect(result.gone).toBe(false);
  expect(result.residual).toContain(launched.process.name);
  expect(daemon.containers.has(launched.process.name)).toBe(true);
});

test("daemon failure during independent absence verification is never reported gone", async () => {
  const daemon = new DockerDaemon();
  const launched = await launchFixture(daemon);
  daemon.inspectFails = true;
  const result = await launched.process.stop();
  expect(result.gone).toBe(false);
  expect(result.residual).toContain(launched.process.name);
});

test("removing one session leaves unrelated and other-session containers running", async () => {
  const daemon = new DockerDaemon();
  daemon.containers.set("unrelated-service", { name: "unrelated-service", image: imageB, labels: { owner: "someone-else" }, running: true });
  const a = await launchFixture(daemon, "session-a");
  const b = await launchFixture(daemon, "session-b");
  const result = await a.process.stop();
  expect(result).toEqual({ gone: true, residual: [] });
  expect(daemon.containers.has(a.process.name)).toBe(false);
  expect(daemon.containers.get(b.process.name)?.running).toBe(true);
  expect(daemon.containers.get("unrelated-service")?.running).toBe(true);
  await b.process.stop();
});

test("non-identical ancestor grants cannot surround another approved mount root", async () => {
  const { root, workspace } = await fixture();
  const parent = path.join(root, "grant-parent");
  const child = path.join(parent, "child");
  await fs.mkdir(child, { recursive: true });
  await expect(createSandboxPolicy({ sessionKey: "overlap-parent", revision: 1, cwd: workspace, config, grants: [{ host: parent, mode: "rw" }, { host: child, mode: "ro" }] })).rejects.toThrow(/overlap|ancestor|nested|disjoint/i);
  await expect(createSandboxPolicy({ sessionKey: "overlap-child", revision: 1, cwd: workspace, config, grants: [{ host: child, mode: "rw" }, { host: parent, mode: "ro" }] })).rejects.toThrow(/overlap|ancestor|nested|disjoint/i);
});


test("directory replacement during Docker create is rejected and its new container is removed", async () => {
  const daemon = new DockerDaemon();
  const { root, workspace } = await fixture();
  const bundle = path.join(root, "worker.js");
  await fs.writeFile(bundle, "process.stdin.resume();");
  const policy = await createSandboxPolicy({ sessionKey: "create-race", revision: 1, cwd: workspace, config });
  daemon.afterCreate = async () => { await fs.rename(workspace, `${workspace}-approved`); await fs.mkdir(workspace); };
  let launched: SandboxProcess | undefined;
  try {
    await expect((async () => { launched = await daemon.backend().launch(policy, bundle); })()).rejects.toThrow(/identity|changed|replaced|approval/i);
    expect(daemon.containers.size).toBe(0);
  } finally { await launched?.stop(); }
});

for (const direction of ["active-ancestor", "active-descendant"] as const) {
  test(`managed mount admission rejects ${direction} owned by a different controller`, async () => {
    const daemon = new DockerDaemon();
    const { root, workspace } = await fixture();
    const descendant = path.join(workspace, "descendant");
    await fs.mkdir(descendant);
    const bundle = path.join(root, "worker.js");
    await fs.writeFile(bundle, "process.stdin.resume();");
    const activeSource = await fs.realpath(direction === "active-ancestor" ? workspace : descendant);
    const requestedSource = direction === "active-ancestor" ? descendant : workspace;
    daemon.containers.set("other-controller", { name: "other-controller", image: imageB, labels: { "dev.jeo.sandbox.owner": "other-controller-owner", "dev.jeo.sandbox.session": "active-existing", "dev.jeo.sandbox.revision": "1" }, running: true, mounts: [{ Type: "bind", Source: activeSource, Destination: "/workspace", RW: true }] });
    const policy = await createSandboxPolicy({ sessionKey: direction, revision: 1, cwd: requestedSource, config });
    let launched: SandboxProcess | undefined;
    try {
      await expect((async () => { launched = await daemon.backend().launch(policy, bundle); })()).rejects.toThrow(/overlap|ancestor|nested|conflict/i);
      expect(daemon.mutations).toEqual([]);
      expect(daemon.containers.get("other-controller")?.running).toBe(true);
    } finally { await launched?.stop(); }
  });
}

test("exactly shared workspace roots admit independent simultaneously live sessions", async () => {
  const daemon = new DockerDaemon();
  const { root, workspace } = await fixture();
  const bundle = path.join(root, "worker.js");
  await fs.writeFile(bundle, "process.stdin.resume();");
  const a = await daemon.backend().launch(await createSandboxPolicy({ sessionKey: "shared-a", revision: 1, cwd: workspace, config }), bundle);
  let b: typeof a | undefined;
  try {
    b = await daemon.backend().launch(await createSandboxPolicy({ sessionKey: "shared-b", revision: 1, cwd: workspace, config }), bundle);
    expect(a.name).not.toBe(b.name);
    expect(daemon.containers.get(a.name)?.running).toBe(true);
    expect(daemon.containers.get(b.name)?.running).toBe(true);
  } finally { await a.stop(); await b?.stop(); }
});

test("managed containers with uninspectable mount metadata block new admission without deleting them", async () => {
  const daemon = new DockerDaemon();
  daemon.containers.set("unknown-managed-mount", { name: "unknown-managed-mount", image: imageB, labels: { "dev.jeo.sandbox.owner": "another-controller", "dev.jeo.sandbox.session": "active-existing", "dev.jeo.sandbox.revision": "1" }, running: true });
  const { root, workspace } = await fixture();
  const bundle = path.join(root, "worker.js");
  await fs.writeFile(bundle, "process.stdin.resume();");
  const policy = await createSandboxPolicy({ sessionKey: "unknown-active-mounts", revision: 1, cwd: workspace, config });
  let launched: SandboxProcess | undefined;
  try {
    await expect((async () => { launched = await daemon.backend().launch(policy, bundle); })()).rejects.toThrow(/mount|inspect|metadata|admission/i);
    expect(daemon.mutations).toEqual([]);
    expect(daemon.containers.get("unknown-managed-mount")?.running).toBe(true);
  } finally { await launched?.stop(); }
});

async function isolatedPolicy(cwd: string, grant: string, home: string, environment: Record<string, string> = {}) {
  const driver = path.join(home, "policy-driver.ts");
  const modulePath = new URL("../src/agent/sandbox/policy.ts", import.meta.url).href;
  await fs.writeFile(driver, `import {createSandboxPolicy} from ${JSON.stringify(modulePath)};const input=JSON.parse(process.argv[2]);try{await createSandboxPolicy(input);console.log(JSON.stringify({accepted:true}));}catch(error){console.log(JSON.stringify({accepted:false,error:String(error)}));}`);
  const child = Bun.spawn([process.execPath, driver, JSON.stringify({ sessionKey: "sensitive-grant", revision: 1, cwd, config, grants: [{ host: grant, mode: "ro" }] })], {
    env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, ...environment },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  return JSON.parse(stdout);
}

for (const resource of [".gemini", ".ssh", ".claude", ".codex", ".agents", ".aws", ".azure", ".gnupg", ".config"]) {
  test(`credential-bearing ${resource} cannot be exposed through a canonical grant alias`, async () => {
    const { root, workspace } = await fixture();
    const home = path.join(root, "isolated-home");
    const sensitive = path.join(home, resource);
    const alias = path.join(root, "public-alias");
    await fs.mkdir(sensitive, { recursive: true });
    await fs.writeFile(path.join(sensitive, "credential"), "PRIVATE_PARENT_ONLY");
    await fs.symlink(sensitive, alias, process.platform === "win32" ? "junction" : "dir");
    expect(await isolatedPolicy(workspace, alias, home)).toEqual({ accepted: false, error: expect.stringMatching(/private|control/i) });
  });
}

test("an explicitly configured private state directory remains protected through a symlinked configuration path", async () => {
  const { root, workspace, privatePath } = await fixture();
  const home = path.join(root, "isolated-home");
  const alias = path.join(root, "configured-state-alias");
  await fs.mkdir(home);
  await fs.writeFile(path.join(privatePath, "authority-key"), "PRIVATE_PARENT_ONLY");
  await fs.symlink(privatePath, alias, process.platform === "win32" ? "junction" : "dir");
  expect(await isolatedPolicy(workspace, privatePath, home, { JEO_CONFIG_DIR: alias })).toEqual({ accepted: false, error: expect.stringMatching(/private|control/i) });
});

test("an SSH agent endpoint ancestor is denied even before its socket appears", async () => {
  const { root, workspace, granted } = await fixture();
  const home = path.join(root, "isolated-home");
  await fs.mkdir(home);
  expect(await isolatedPolicy(workspace, granted, home, { SSH_AUTH_SOCK: path.join(granted, "agent-endpoint") })).toEqual({ accepted: false, error: expect.stringMatching(/socket|endpoint/i) });
});

test.skipIf(process.platform === "win32")("a pinned Docker context endpoint ancestor cannot be admitted as a grant", async () => {
  const daemon = new DockerDaemon();
  const { root, workspace, granted } = await fixture();
  const bundle = path.join(root, "worker.js");
  await fs.writeFile(bundle, "process.stdin.resume();");
  const policy = await createSandboxPolicy({ sessionKey: "pinned-endpoint", revision: 1, cwd: workspace, config, grants: [{ host: granted, mode: "ro" }] });
  daemon.endpoint = `unix://${path.join(granted, "daemon-endpoint")}`;
  let launched: SandboxProcess | undefined;
  try {
    await expect((async () => { launched = await daemon.backend().launch(policy, bundle); })()).rejects.toThrow(/socket|endpoint/i);
    expect(daemon.mutations).toEqual([]);
  } finally { await launched?.stop(); }
});

test.skipIf(process.platform === "win32")("a nested real Unix socket is refused without treating an ordinary directory as safe", async () => {
  const { workspace } = await fixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "j-"));
  roots.push(root);
  const resource = path.join(root, "resource");
  const nested = path.join(resource, "nested");
  await fs.mkdir(nested, { recursive: true });
  const socket = path.join(nested, "s");
  const server = createServer();
  try {
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(socket, listening.resolve);
    await listening.promise;
    await expect(createSandboxPolicy({ sessionKey: "nested-control-socket", revision: 1, cwd: workspace, config, grants: [{ host: resource, mode: "ro" }] })).rejects.toThrow(/socket/i);
  } finally {
    if (server.listening) {
      const closed = Promise.withResolvers<void>();
      server.close((error) => error ? closed.reject(error) : closed.resolve());
      await closed.promise;
    }
  }
});

test("concurrent conflicting root admission returns exactly one usable session", async () => {
  const daemon = new DockerDaemon();
  const { root, workspace } = await fixture();
  const descendant = path.join(workspace, "nested");
  await fs.mkdir(descendant);
  const bundle = path.join(root, "worker.js");
  await fs.writeFile(bundle, "process.stdin.resume();");
  const policies = await Promise.all([workspace, descendant].map((cwd, index) => createSandboxPolicy({ sessionKey: `concurrent-${index}`, revision: 1, cwd, config })));
  const results = await Promise.allSettled(policies.map((policy) => daemon.backend().launch(policy, bundle)));
  const running = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  try {
    expect(running.length).toBe(1);
    const denied = results.find((result) => result.status === "rejected");
    expect(denied?.status === "rejected" ? String(denied.reason) : "").toMatch(/overlap|ancestor|conflict/i);
    expect(daemon.containers.get(running[0]!.name)?.running).toBe(true);
    expect(daemon.containers.size).toBe(1);
  } finally { await Promise.all(running.map((child) => child.stop())); }
});

for (const tamper of ["source", "destination", "write-mode", "extra-mount"] as const) {
  test(`actual started container metadata cannot silently change the approved ${tamper}`, async () => {
    const daemon = new DockerDaemon();
    const { root, workspace, granted } = await fixture();
    const bundle = path.join(root, "worker.js");
    await fs.writeFile(bundle, "process.stdin.resume();");
    const policy = await createSandboxPolicy({ sessionKey: `tamper-${tamper}`, revision: 1, cwd: workspace, config, grants: [{ host: granted, mode: "ro" }] });
    const unrelated = await fs.realpath(granted);
    daemon.afterCreate = async () => {
      const created = [...daemon.containers.values()][0];
      const mount = created?.mounts?.find((candidate) => tamper === "write-mode" ? candidate.Source === unrelated : candidate.Destination === "/workspace");
      if (!mount || !created?.mounts) throw new Error("Missing created approved mount in fixture");
      if (tamper === "source") mount.Source = unrelated;
      if (tamper === "destination") mount.Destination = "/unapproved-workspace";
      if (tamper === "write-mode") mount.RW = true;
      if (tamper === "extra-mount") created.mounts.push({ Type: "bind", Source: unrelated, Destination: "/unapproved", RW: true });
    };
    let launched: SandboxProcess | undefined;
    try {
      await expect((async () => { launched = await daemon.backend().launch(policy, bundle); })()).rejects.toThrow(/bind|mount|config/i);
      expect(daemon.containers.size).toBe(0);
    } finally { await launched?.stop(); }
  });
}

test("different HOME and config profiles share native-user root admission across controller processes", async () => {
  const daemon = new DockerDaemon();
  const { root, workspace } = await fixture();
  const descendant = path.join(workspace, "nested");
  await fs.mkdir(descendant);
  const bundle = path.join(root, "worker.js");
  const driver = path.join(root, "controller.ts");
  await fs.writeFile(bundle, "process.stdin.resume();");
  const backendModule = new URL("../src/agent/sandbox/docker.ts", import.meta.url).href;
  const policyModule = new URL("../src/agent/sandbox/policy.ts", import.meta.url).href;
  await fs.writeFile(driver, `
import {createDockerBackend} from ${JSON.stringify(backendModule)};
import {createSandboxPolicy} from ${JSON.stringify(policyModule)};
import {createInterface} from 'node:readline';
const input=JSON.parse(process.argv[2]);
const send=(frame)=>process.stdout.write(JSON.stringify(frame)+'\\n');
const pending=new Map();let sequence=0;let session;
const lines=createInterface({input:process.stdin});
lines.on('line',async(line)=>{const frame=JSON.parse(line);if(frame.type==='stop'){try{const result=await session.stop();send({type:'stopped',result});process.exit(result.gone?0:1);}catch(error){send({type:'fatal',error:String(error)});process.exit(1);}return;}const waiter=pending.get(frame.id);if(!waiter)throw Error('unknown response');pending.delete(frame.id);if(frame.error)waiter.reject(Error(frame.error));else waiter.resolve(frame.result);});
const backend=createDockerBackend({env:{},platform:'linux',run:(argv)=>{const id=String(++sequence);const waiter=Promise.withResolvers();pending.set(id,waiter);send({type:'run',id,argv});return waiter.promise;},spawn:(argv)=>{send({type:'spawn',argv});const life=Promise.withResolvers();return {stdin:{write(){},flush(){},end(){}},stdout:new ReadableStream({start(c){c.close()}}),stderr:new ReadableStream({start(c){c.close()}}),exited:life.promise,kill(){life.resolve(137)}};}});
try{const policy=await createSandboxPolicy(input.policy);session=await backend.launch(policy,input.bundle);send({type:'launched',name:session.name});}catch(error){send({type:'denied',error:String(error)});process.exit(0);}
`);

  const controllers = await Promise.all([workspace, descendant].map(async (cwd, index) => {
    const home = path.join(root, `profile-${index}`);
    const configDirectory = path.join(home, "configuration");
    await fs.mkdir(configDirectory, { recursive: true, mode: 0o700 });
    const child = Bun.spawn([process.execPath, driver, JSON.stringify({ policy: { sessionKey: `profile-${index}`, revision: 1, cwd, config }, bundle })], {
      env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, JEO_CONFIG_DIR: configDirectory, TMPDIR: home },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const outcome = Promise.withResolvers<{ launched: boolean; name?: string; error?: string }>();
    const stderr = new Response(child.stderr).text();
    const pump = (async () => {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = buffered.indexOf("\n")) >= 0) {
            const frame = JSON.parse(buffered.slice(0, newline)) as { type: string; id?: string; argv?: string[]; name?: string; error?: string };
            buffered = buffered.slice(newline + 1);
            if (frame.type === "run" && frame.argv) {
              try { child.stdin.write(`${JSON.stringify({ id: frame.id, result: await daemon.run(frame.argv) })}\n`); }
              catch (error) { child.stdin.write(`${JSON.stringify({ id: frame.id, error: String(error) })}\n`); }
              child.stdin.flush();
            } else if (frame.type === "spawn" && frame.argv) {
              daemon.spawn(frame.argv);
            } else if (frame.type === "launched") outcome.resolve({ launched: true, name: frame.name });
            else if (frame.type === "denied") outcome.resolve({ launched: false, error: frame.error });
            else if (frame.type === "fatal") throw new Error(frame.error);
          }
        }
        outcome.reject(new Error("Controller exited before reporting launch outcome"));
      } catch (error) { outcome.reject(error); throw error; }
      finally { reader.releaseLock(); }
    })();
    return { child, outcome: outcome.promise, pump, stderr };
  }));

  try {
    const results = await Promise.all(controllers.map((controller) => controller.outcome));
    expect(results.filter((result) => result.launched).length).toBe(1);
    expect(results.find((result) => !result.launched)?.error).toMatch(/overlap|ancestor|conflict/i);
    expect(daemon.containers.size).toBe(1);
    for (const [index, result] of results.entries()) if (result.launched) {
      controllers[index]!.child.stdin.write(`${JSON.stringify({ type: "stop" })}\n`);
      controllers[index]!.child.stdin.flush();
    }
    expect(await Promise.all(controllers.map((controller) => controller.child.exited))).toEqual([0, 0]);
    await Promise.all(controllers.map((controller) => controller.pump));
    expect(await Promise.all(controllers.map((controller) => controller.stderr))).toEqual(["", ""]);
    expect(daemon.containers.size).toBe(0);
  } finally {
    for (const controller of controllers) controller.child.kill();
    await Promise.all(controllers.map((controller) => controller.child.exited));
  }
}, 45_000);

// A leaked EXITED managed container can record a bind Source that no longer canonicalizes (its temp workspace was
// deleted). ENOENT/ENOTDIR must be judged lexically so one vanished path cannot wedge every later launch; any other
// canonicalization failure must keep failing closed, and the overlap guard must still bind the lexical path.
const LEAKED = "leaked-exited-container";

function leakExitedContainer(daemon: DockerDaemon, source: string): void {
  daemon.containers.set(LEAKED, {
    name: LEAKED,
    image: imageB,
    running: false,
    labels: { "dev.jeo.sandbox.owner": "other-controller", "dev.jeo.sandbox.session": "stale", "dev.jeo.sandbox.revision": "1" },
    mounts: [{ Type: "bind", Source: source, Destination: "/workspace", RW: true }],
  });
}

async function leakFixture(sessionKey: string) {
  const { root, workspace } = await fixture();
  const bundle = path.join(root, "worker.js");
  await fs.writeFile(bundle, "process.stdin.resume();");
  const policy = await createSandboxPolicy({ sessionKey, revision: 1, cwd: workspace, config });
  return { root, workspace: await fs.realpath(workspace), bundle, policy };
}

async function expectLeakedLaunchAdmitted(daemon: DockerDaemon, policy: SandboxPolicy, bundle: string) {
  const launched = await daemon.backend().launch(policy, bundle);
  try {
    expect(daemon.mutations).toEqual(["create"]);
    expect(daemon.containers.get(launched.name)?.running).toBe(true);
    expect(daemon.containers.get(LEAKED)?.running).toBe(false);
  } finally { await launched.stop(); }
  // Only the freshly launched container was revoked; the leaked one is never touched.
  expect(daemon.mutations).toEqual(["create", "rm"]);
  expect(daemon.containers.has(LEAKED)).toBe(true);
}

async function expectLeakedLaunchRejected(daemon: DockerDaemon, policy: SandboxPolicy, bundle: string, pattern: RegExp) {
  let launched: SandboxProcess | undefined;
  try {
    await expect((async () => { launched = await daemon.backend().launch(policy, bundle); })()).rejects.toThrow(pattern);
    expect(daemon.mutations).toEqual([]);
    expect(daemon.containers.get(LEAKED)?.running).toBe(false);
  } finally { await launched?.stop(); }
}

test("a leaked exited managed container whose bind source vanished does not block a disjoint launch", async () => {
  const daemon = new DockerDaemon();
  const { policy, bundle } = await leakFixture("leaked-vanished-disjoint");
  const gone = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "jeo-compiled-worker-GONE-"));
  await fs.rm(gone, { recursive: true, force: true });
  leakExitedContainer(daemon, path.join(gone, "workspace"));
  await expectLeakedLaunchAdmitted(daemon, policy, bundle);
});

test("a vanished leaked bind source lexically inside the candidate workspace still trips the overlap guard", async () => {
  const daemon = new DockerDaemon();
  const { workspace, bundle, policy } = await leakFixture("leaked-vanished-child");
  const vanished = path.join(workspace, "vanished-child");
  await expect(fs.lstat(vanished)).rejects.toMatchObject({ code: "ENOENT" });
  leakExitedContainer(daemon, vanished);
  await expectLeakedLaunchRejected(daemon, policy, bundle, /SANDBOX_MOUNT_OVERLAP/);
});

test("a leaked bind source beneath the hands bundle file (ENOTDIR) still trips the overlap guard", async () => {
  // A vanished path cannot lexically contain an existing candidate (every ancestor of a real path exists), so the
  // reachable "containing" overlap is the converse shape: an ENOTDIR source nested under the candidate bundle file.
  const daemon = new DockerDaemon();
  const { bundle, policy } = await leakFixture("leaked-under-bundle");
  leakExitedContainer(daemon, path.join(bundle, "x"));
  await expectLeakedLaunchRejected(daemon, policy, bundle, /SANDBOX_MOUNT_OVERLAP/);
});

test("a leaked bind source under an unrelated regular file (ENOTDIR) does not block a disjoint launch", async () => {
  const daemon = new DockerDaemon();
  const { root, bundle, policy } = await leakFixture("leaked-under-file");
  const regular = path.join(root, "unrelated-file.txt");
  await fs.writeFile(regular, "not a directory");
  leakExitedContainer(daemon, path.join(regular, "x"));
  await expectLeakedLaunchAdmitted(daemon, policy, bundle);
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an unreadable leaked bind source (EACCES) fails closed instead of falling back lexically", async () => {
  const daemon = new DockerDaemon();
  const { root, bundle, policy } = await leakFixture("leaked-eacces");
  const locked = path.join(root, "locked");
  await fs.mkdir(locked);
  leakExitedContainer(daemon, path.join(locked, "child"));
  await fs.chmod(locked, 0o000);
  try { await expectLeakedLaunchRejected(daemon, policy, bundle, /EACCES|permission/i); }
  finally { await fs.chmod(locked, 0o700); }
});

test.skipIf(process.platform === "win32")("a symlink-loop leaked bind source (ELOOP) fails closed instead of falling back lexically", async () => {
  const daemon = new DockerDaemon();
  const { root, bundle, policy } = await leakFixture("leaked-eloop");
  const a = path.join(root, "loop-a");
  const b = path.join(root, "loop-b");
  await fs.symlink(b, a);
  await fs.symlink(a, b);
  leakExitedContainer(daemon, a);
  await expectLeakedLaunchRejected(daemon, policy, bundle, /ELOOP|too many/i);
});

// macOS aliases /var -> /private/var. A vanished source recorded through the alias must resolve through its nearest
// existing ancestor, or a lexical compare against the canonical (/private/var/...) candidate misses a real overlap.
const macVarAlias = process.platform === "darwin" && (await fs.realpath("/var").catch(() => "")) === "/private/var";
const viaVarAlias = (canonical: string): string => canonical.replace(/^\/private(?=\/var\/)/, "");

test.skipIf(!macVarAlias)("a vanished leaked bind source recorded through the /var alias inside the candidate workspace still trips the overlap guard", async () => {
  const daemon = new DockerDaemon();
  const { workspace, bundle, policy } = await leakFixture("leaked-alias-inside");
  expect(workspace.startsWith("/private/var/")).toBe(true);
  const aliasWorkspace = viaVarAlias(workspace);
  expect(aliasWorkspace).not.toBe(workspace);
  expect(await fs.realpath(aliasWorkspace)).toBe(workspace);
  const vanished = path.join(aliasWorkspace, "gone-parent", "gone-child");
  await expect(fs.lstat(vanished)).rejects.toMatchObject({ code: "ENOENT" });
  leakExitedContainer(daemon, vanished);
  await expectLeakedLaunchRejected(daemon, policy, bundle, /SANDBOX_MOUNT_OVERLAP/);
});

test.skipIf(!macVarAlias)("a vanished leaked bind source recorded through the /var alias outside the candidate does not block a disjoint launch", async () => {
  const daemon = new DockerDaemon();
  const { root, bundle, policy } = await leakFixture("leaked-alias-disjoint");
  const aliasRoot = viaVarAlias(root);
  expect(aliasRoot).not.toBe(root);
  const vanished = path.join(aliasRoot, "jeo-gone-alias", "workspace");
  await expect(fs.lstat(vanished)).rejects.toMatchObject({ code: "ENOENT" });
  leakExitedContainer(daemon, vanished);
  await expectLeakedLaunchAdmitted(daemon, policy, bundle);
});
