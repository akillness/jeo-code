import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensurePrivateSandboxDirectory } from "./authority";
import { canonicalSandboxPath, nativeSandboxHome, sandboxPathContains, validateSandboxConfig, validateSandboxMountSource } from "./policy";
import type { SandboxBackend, SandboxConfig, SandboxPolicy, SandboxProcess, SandboxTermination } from "./types";

export interface DockerCommandResult { exitCode: number; stdout: string; stderr: string }
interface DockerChild {
  stdin: SandboxProcess["stdin"];
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}
export interface DockerBackendOptions {
  dockerPath?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  run?: (argv: readonly string[]) => Promise<DockerCommandResult>;
  spawn?: (argv: readonly string[]) => DockerChild;
}

/** Launch failed, but the exact owned container still requires verified removal. */
export class SandboxLaunchError extends Error {
  readonly residual: readonly string[];
  readonly #retry: () => Promise<SandboxTermination>;

  constructor(message: string, residual: readonly string[], cleanup: () => Promise<SandboxTermination>, options?: ErrorOptions) {
    super(message, options);
    this.name = "SandboxLaunchError";
    this.residual = Object.freeze([...residual]);
    this.#retry = cleanup;
  }

  cleanup(): Promise<SandboxTermination> { return this.#retry(); }
}

const OWNER = "dev.jeo.sandbox.owner";
const SESSION = "dev.jeo.sandbox.session";
const REVISION = "dev.jeo.sandbox.revision";
const CLI_OUTPUT_BYTES = 1_000_000; // Same transport ceiling as messenger workers.

export function createDockerBackend(options: DockerBackendOptions = {}): SandboxBackend {
  const executable = options.dockerPath ?? Bun.which("docker") ?? "docker";
  const platform = options.platform ?? process.platform;
  const suppliedEnv = options.env ?? process.env;
  const environment: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "SYSTEMROOT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATHEXT", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_API_VERSION"]) {
    if (suppliedEnv[key] !== undefined) environment[key] = suppliedEnv[key]!;
  }
  const owner = crypto.randomUUID();
  const run = options.run ?? (async (argv: readonly string[]): Promise<DockerCommandResult> => {
    const child = Bun.spawn([...argv], { env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 30_000);
    const collect = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > CLI_OUTPUT_BYTES) { child.kill(); throw new Error("Docker control output exceeded its bound"); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      return Buffer.concat(chunks).toString("utf8");
    };
    try {
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, collect(child.stdout), collect(child.stderr)]);
      return { exitCode, stdout, stderr };
    } finally { clearTimeout(timer); }
  });
  const spawn = options.spawn ?? ((argv: readonly string[]): DockerChild =>
    Bun.spawn([...argv], { env: environment, stdin: "pipe", stdout: "pipe", stderr: "pipe" }) as unknown as DockerChild);
  const command = (args: readonly string[]) => run([executable, ...args]);

  async function checked(args: readonly string[], context: string): Promise<string> {
    let result: DockerCommandResult;
    try { result = await command(args); }
    catch { throw new Error(`SANDBOX_UNAVAILABLE: Docker ${context} could not run`); }
    if (result.exitCode !== 0) throw new Error(`SANDBOX_UNAVAILABLE: Docker ${context} failed; check the local daemon and existing image`);
    return result.stdout.trim();
  }

  async function preflight(config: SandboxConfig): Promise<{ imageId: string; platform: string }> {
    validateSandboxConfig(config);
    const explicit = environment.DOCKER_CONTEXT ? undefined : environment.DOCKER_HOST;
    if (explicit && !/^(unix:\/\/\/|npipe:\/\/)/i.test(explicit)) throw new Error("SANDBOX_UNAVAILABLE: only local Docker endpoints are authorized");
    const context = await checked(["context", "show"], "context discovery");
    const endpointText = await checked(["context", "inspect", context, "--format", "{{json .Endpoints.docker.Host}}"], "context inspection");
    let endpoint: unknown;
    try { endpoint = JSON.parse(endpointText); } catch { throw new Error("SANDBOX_UNAVAILABLE: malformed Docker endpoint"); }
    const effective = explicit ?? endpoint;
    if (typeof effective !== "string" || !/^(unix:\/\/\/|npipe:\/\/)/i.test(effective)) throw new Error("SANDBOX_UNAVAILABLE: remote Docker context is not authorized");
    environment.DOCKER_HOST = effective;
    delete environment.DOCKER_CONTEXT; // Pin the verified local endpoint for every later command.
    let info: { OSType?: string };
    let image: { Id?: string; Os?: string; Architecture?: string };
    try {
      info = JSON.parse(await checked(["info", "--format", "{{json .}}"], "daemon inspection"));
      image = JSON.parse(await checked(["image", "inspect", config.image, "--format", "{{json .}}"], "local image inspection"));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("SANDBOX_")) throw error;
      throw new Error("SANDBOX_UNAVAILABLE: malformed Docker daemon or image response");
    }
    if (info.OSType !== "linux" || image.Os !== "linux") throw new Error("SANDBOX_UNAVAILABLE: a Linux Docker daemon and Linux Bun image are required");
    if (!image.Id || !/^sha256:[a-f0-9]{64}$/.test(image.Id) || !image.Architecture) throw new Error("SANDBOX_UNAVAILABLE: local image has no immutable identity");
    return { imageId: image.Id, platform: `linux/${image.Architecture}` };
  }

  async function acquireLaunchLock(sources: readonly string[]): Promise<() => Promise<void>> {
    // One lock per native user, independent of session/config/backend instance.
    const directory = await ensurePrivateSandboxDirectory(path.join(await nativeSandboxHome(), ".jeo", "sandbox-launch"));
    if (sources.some(source => sandboxPathContains(source, directory) || sandboxPathContains(directory, source))) {
      throw new Error("SANDBOX_POLICY: mount overlaps the parent launch lock");
    }
    const lock = path.join(directory, "launch.lock");
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await fs.mkdir(lock, { mode: 0o700 });
        const owned = await fs.lstat(lock, { bigint: true });
        return async () => {
          let current;
          try { current = await fs.lstat(lock, { bigint: true }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
          if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino) throw new Error("SANDBOX_UNAVAILABLE: launch lock ownership changed");
          await fs.rmdir(lock);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw new Error("SANDBOX_UNAVAILABLE: managed launch lock unavailable", { cause: error });
        try {
          const stat = await fs.lstat(lock);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("SANDBOX_UNAVAILABLE: invalid managed launch lock");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        await Bun.sleep(25);
      }
    }
  }

  // Every managed launch holds the same native-user lock. Identical/disjoint bind
  // roots keep hands from renaming another source or its ancestors. Inspect Source
  // is admission metadata, not physical host/guest inode attestation; native host
  // and Docker operators are outside this model-execution boundary.
  async function validateManagedRoots(sources: readonly string[]): Promise<void> {
    const ids = (await checked(["container", "ls", "--all", "--filter", `label=${OWNER}`, "--format", "{{.ID}}"], "managed container discovery")).split(/\r?\n/).filter(Boolean);
    for (const id of ids) {
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("SANDBOX_UNAVAILABLE: invalid managed container identity");
      let record: { Config?: { Labels?: Record<string, string> }; Mounts?: { Type?: string; Source?: string; Destination?: string }[] };
      try { record = JSON.parse(await checked(["inspect", "--format", "{{json .}}", id], "managed mount inspection")); }
      catch { throw new Error("SANDBOX_UNAVAILABLE: managed mount metadata unavailable"); }
      const labels = record.Config?.Labels;
      if (!labels?.[OWNER] || !labels[SESSION] || !/^\d+$/.test(labels[REVISION] ?? "") || !Array.isArray(record.Mounts)) throw new Error("SANDBOX_UNAVAILABLE: unknown managed ownership or mounts");
      for (const mount of record.Mounts) {
        if (mount.Type === "tmpfs" && mount.Destination === "/tmp") continue;
        if (mount.Type !== "bind" || typeof mount.Source !== "string" || !path.isAbsolute(mount.Source)) throw new Error("SANDBOX_UNAVAILABLE: unknown managed mount metadata");
        const source = await canonicalSandboxPath(mount.Source);
        if (sources.some(candidate => candidate !== source && (sandboxPathContains(candidate, source) || sandboxPathContains(source, candidate)))) {
          throw new Error("SANDBOX_MOUNT_OVERLAP: managed mount roots must be identical or disjoint");
        }
      }
    }
  }

  async function launch(policy: SandboxPolicy, bundlePath: string): Promise<SandboxProcess> {
    const qualified = await preflight(policy.config);
    const bundle = await canonicalSandboxPath(bundlePath);
    if (!(await fs.stat(bundle)).isFile()) throw new Error("SANDBOX_POLICY: hands bundle is not a regular file");
    const sources = [...policy.mounts.map(mount => mount.host), bundle];
    for (let index = 0; index < sources.length; index++) {
      for (const other of sources.slice(index + 1)) {
        if (other !== sources[index] && (sandboxPathContains(other, sources[index]!) || sandboxPathContains(sources[index]!, other))) throw new Error("SANDBOX_MOUNT_OVERLAP: mount roots must be identical or disjoint");
      }
    }
    const sourceIdentity = await Promise.all(sources.map(source => fs.stat(source, { bigint: true })));
    const validateSources = async (): Promise<void> => {
      for (let index = 0; index < sources.length; index++) {
        const source = sources[index]!;
        const stat = await fs.stat(source, { bigint: true });
        if (await canonicalSandboxPath(source) !== source || stat.dev !== sourceIdentity[index]!.dev || stat.ino !== sourceIdentity[index]!.ino) throw new Error("SANDBOX_MOUNT_IDENTITY: host mount source changed during launch");
      }
      for (const mount of policy.mounts) await validateSandboxMountSource(mount.host, policy.privatePaths ?? [], [environment.DOCKER_HOST!.startsWith("unix://") ? environment.DOCKER_HOST!.slice(7) : "", suppliedEnv.SSH_AUTH_SOCK ?? ""].filter(Boolean));
    };
    const mounts: string[] = [];
    for (const mount of policy.mounts) {
      if (await canonicalSandboxPath(mount.host) !== mount.host || sandboxPathContains(mount.host, bundle)) {
        throw new Error("SANDBOX_POLICY: mount changed or exposes the trusted hands bundle");
      }
      // Docker's --mount grammar is CSV, not shell syntax. Refuse ambiguous source names.
      if (/[,\r\n\0]/.test(mount.host) || !/^\/(workspace|grants\/[a-f0-9]{64})$/.test(mount.guest)) throw new Error("SANDBOX_POLICY: unsupported mount path");
      mounts.push("--mount", `type=bind,source=${mount.host},target=${mount.guest}${mount.mode === "ro" ? ",readonly" : ""}`);
    }
    if (/[,\r\n\0]/.test(bundle)) throw new Error("SANDBOX_POLICY: unsupported bundle path");
    const name = `jeo-sbx-${new Bun.CryptoHasher("sha256").update(policy.sessionKey).digest("hex").slice(0, 20)}-r${policy.revision}-${crypto.randomUUID()}`;
    const uid = platform === "win32" ? undefined : process.getuid?.();
    const gid = platform === "win32" ? undefined : process.getgid?.();
    if (uid === 0) throw new Error("SANDBOX_UNAVAILABLE: run the host controller as a non-root user");
    const user = uid === undefined || gid === undefined ? "bun" : `${uid}:${gid}`;
    const createArgs = [
      "create", "--pull=never", "--name", name,
      "--label", `${OWNER}=${owner}`, "--label", `${SESSION}=${policy.sessionKey}`, "--label", `${REVISION}=${policy.revision}`,
      "--init", "--interactive", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", String(policy.config.limits.pids), "--memory", String(policy.config.limits.memoryBytes), "--cpus", String(policy.config.limits.cpus),
      "--user", user, "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777", "--workdir", "/workspace",
      "--env", "HOME=/tmp/jeo-home", "--env", "JEO_CONFIG_DIR=/tmp/jeo-home", "--env", "JEO_SANDBOX_HANDS=1",
      ...mounts, "--mount", `type=bind,source=${bundle},target=/jeo/hands.js,readonly`,
      "--entrypoint", "/usr/local/bin/bun", qualified.imageId, "/jeo/hands.js",
    ];
    let stopping: Promise<SandboxTermination> | undefined;
    const stop = (): Promise<SandboxTermination> => {
      stopping ??= (async () => {
        try {
          const before = await command(["inspect", "--format", "{{json .}}", name]);
          if (before.exitCode === 0) {
            const record = JSON.parse(before.stdout) as { Config?: { Labels?: Record<string, string> } };
            const labels = record.Config?.Labels;
            if (labels?.[OWNER] !== owner || labels[SESSION] !== policy.sessionKey || labels[REVISION] !== String(policy.revision)) {
              return { gone: false, residual: [name] };
            }
            await command(["rm", "--force", name]);
          }
          const remaining = await command(["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"]);
          if (remaining.exitCode !== 0 || remaining.stdout.trim()) return { gone: false, residual: [name] };
          const revision = await command(["container", "ls", "--all", "--filter", `label=${OWNER}=${owner}`, "--filter", `label=${SESSION}=${policy.sessionKey}`, "--filter", `label=${REVISION}=${policy.revision}`, "--format", "{{.Names}}"]);
          if (revision.exitCode !== 0) return { gone: false, residual: [name] };
          const residual = revision.stdout.trim().split(/\r?\n/).filter(Boolean);
          return { gone: residual.length === 0, residual };
        } catch { return { gone: false, residual: [name] }; }
      })();
      const attempt = stopping;
      void attempt.then(result => { if (!result.gone && stopping === attempt) stopping = undefined; });
      return attempt;
    };
    const unlock = await acquireLaunchLock(sources);
    let released = false;
    const cleanupOwned = async (): Promise<SandboxTermination> => {
      const result = await stop();
      if (!released) {
        try { await unlock(); released = true; }
        catch { return { gone: false, residual: [...result.residual, "managed launch lock"] }; }
      }
      return result;
    };
    try {
      await validateManagedRoots(sources);
      await validateSources();
      await checked(createArgs, "container creation");
      await validateSources();
      const child = spawn([executable, "start", "--attach", "--interactive", name]);
      const deadline = Date.now() + 30_000;
      for (;;) {
        const record = JSON.parse(await checked(["inspect", "--format", "{{json .}}", name], "container start verification")) as { Config?: { Labels?: Record<string, string> }; State?: { Running?: boolean }; Mounts?: { Type?: string; Source?: string; Destination?: string; RW?: boolean }[] };
        const labels = record.Config?.Labels;
        if (labels?.[OWNER] !== owner || labels[SESSION] !== policy.sessionKey || labels[REVISION] !== String(policy.revision) || !Array.isArray(record.Mounts)) throw new Error("SANDBOX_UNAVAILABLE: started container ownership or mount metadata changed");
        const actual = record.Mounts.filter(mount => mount.Type === "bind");
        const expected = [...policy.mounts.map(mount => ({ source: mount.host, guest: mount.guest, writable: mount.mode === "rw" })), { source: bundle, guest: "/jeo/hands.js", writable: false }];
        if (actual.length !== expected.length) throw new Error("SANDBOX_UNAVAILABLE: unexpected container bind mounts");
        for (const mount of expected) {
          const observed = actual.find(candidate => candidate.Destination === mount.guest);
          if (!observed?.Source || await canonicalSandboxPath(observed.Source) !== mount.source || observed.RW !== mount.writable) throw new Error("SANDBOX_UNAVAILABLE: actual container bind configuration changed");
        }
        if (record.State?.Running === true) break;
        if (Date.now() >= deadline) throw new Error("SANDBOX_UNAVAILABLE: container did not start");
        await Bun.sleep(25);
      }
      await validateSources();
      await unlock();
      released = true;
      return { name, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited: child.exited, stop };
    } catch (error) {
      const cleanup = await cleanupOwned();
      if (!cleanup.gone) throw new SandboxLaunchError(`REVOKE_INCOMPLETE: failed sandbox launch left owned resources for ${name}`, cleanup.residual, cleanupOwned, { cause: error });
      throw error;
    }
  }

  return { preflight, launch };
}
