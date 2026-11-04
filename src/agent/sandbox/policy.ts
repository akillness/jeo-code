import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SandboxConfig, SandboxMount, SandboxPolicy } from "./types";

export interface SandboxPolicyOptions {
  sessionKey: string;
  revision: number;
  cwd: string;
  config: SandboxConfig;
  grants?: readonly { host: string; mode: "ro" | "rw" }[];
  privatePaths?: readonly string[];
}

export function validateSandboxConfig(value: SandboxConfig): void {
  if (!value || typeof value.image !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/.test(value.image)) {
    throw new Error("SANDBOX_CONFIG: an existing local image reference is required");
  }
  const limits = value.limits;
  if (!limits || !Number.isSafeInteger(limits.memoryBytes) || limits.memoryBytes <= 0 ||
      !Number.isSafeInteger(limits.pids) || limits.pids <= 0 ||
      !Number.isFinite(limits.cpus) || limits.cpus <= 0) {
    throw new Error("SANDBOX_CONFIG: positive finite memory, PID and CPU limits are required");
  }
}

export function sandboxPathContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export function windowsSystemRoot(): string {
  const configured = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.windir;
  if (configured && path.isAbsolute(configured)) return configured;
  for (const candidate of ["powershell.exe", "cmd.exe"]) {
    const resolved = Bun.which(candidate);
    const match = resolved ? /^(.*)[\\/]System32(?:[\\/]|$)/i.exec(resolved) : null;
    if (match?.[1] && path.isAbsolute(match[1])) return match[1];
  }
  throw new Error("SANDBOX_STATE: Windows system directory is unavailable");
}

let nativeHome: Promise<string> | undefined;

/** Bun userInfo() can inherit startup HOME; query the native account database instead. */
export function nativeSandboxHome(): Promise<string> {
  nativeHome ??= (async () => {
    let home: string | undefined;
    let argv: string[] | undefined;
    let systemRoot = "";
    if (process.platform === "win32") {
      systemRoot = windowsSystemRoot();
      const script = "$ErrorActionPreference='Stop';[Console]::Out.Write([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile))";
      argv = [path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
    } else {
      const uid = process.getuid?.();
      if (uid === undefined) throw new Error("SANDBOX_STATE: native user identity unavailable");
      if (process.platform === "darwin") argv = ["/usr/bin/dscacheutil", "-q", "user", "-a", "uid", String(uid)];
      else {
        const entry = (await fs.readFile("/etc/passwd", "utf8")).split("\n").find(line => line.split(":")[2] === String(uid));
        home = entry?.split(":")[5];
        if (!home) argv = ["/usr/bin/getent", "passwd", String(uid)];
      }
    }
    if (argv) {
      const child = Bun.spawn(argv, { env: { SystemRoot: systemRoot }, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const timer = setTimeout(() => child.kill(), 30_000);
      try {
        const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
        if (code !== 0) throw new Error("SANDBOX_STATE: native account home lookup failed");
        home = process.platform === "darwin" ? /^dir: (.+)$/m.exec(output)?.[1] : process.platform === "win32" ? output.trim() : output.trim().split(":")[5];
      } finally { clearTimeout(timer); }
    }
    if (!home || !path.isAbsolute(home)) throw new Error("SANDBOX_STATE: native account home unavailable");
    return canonicalSandboxPath(home);
  })();
  return nativeHome;
}

/** Canonicalize even a not-yet-created private state path without trusting symlinked ancestors. */
export async function canonicalSandboxPath(value: string, mustExist = true, cwd?: string): Promise<string> {
  if (typeof value !== "string" || !value.trim() || /[\0\r\n]/.test(value)) throw new Error("SANDBOX_PATH: invalid host path");
  // Reject namespaces before normalization or metadata can contact SMB servers or devices.
  if (process.platform === "win32" && /^(?:[\\/]{2}|[\\/]\?\?[\\/])/.test(value)) throw new Error("SANDBOX_PATH: Windows network and device paths are forbidden");
  const absolute = cwd === undefined ? path.resolve(value) : path.resolve(cwd, value);
  if (process.platform === "win32" && /^[\\/]{2}/.test(absolute)) throw new Error("SANDBOX_PATH: Windows network and device paths are forbidden");
  try {
    const resolved = await fs.realpath(absolute);
    return process.platform === "win32" && /^[A-Za-z]:$/.test(resolved) ? `${resolved}\\` : resolved;
  }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // macOS realpath can reject launchd sockets even though their parent is resolvable.
    const socket = code === "EOPNOTSUPP" && (await fs.lstat(absolute)).isSocket();
    if (!socket && (mustExist || code !== "ENOENT")) throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    const resolvedParent = await canonicalSandboxPath(parent, false);
    const result = path.join(resolvedParent, path.basename(absolute));
    return process.platform === "win32" && /^[A-Za-z]:$/.test(result) ? `${result}\\` : result;
  }
}

/** Deny endpoint ancestors even when their socket has not been created yet. */
export async function validateSandboxMountSource(host: string, privatePaths: readonly string[], controlPaths: readonly string[] = []): Promise<void> {
  const home = await canonicalSandboxPath(os.homedir());
  const isRoot = host === path.parse(host).root || (process.platform === "win32" && /^[A-Za-z]:[\\/]?$/.test(host));
  if (isRoot || host === home) throw new Error("SANDBOX_POLICY: host root and whole-home mounts are forbidden");
  if (privatePaths.some(privatePath => sandboxPathContains(host, privatePath) || sandboxPathContains(privatePath, host))) {
    throw new Error("SANDBOX_POLICY: mount overlaps private control state");
  }
  const endpoints = [process.env.SSH_AUTH_SOCK, process.env.DOCKER_HOST?.startsWith("unix://") ? process.env.DOCKER_HOST.slice(7) : undefined, ...controlPaths].filter((value): value is string => Boolean(value));
  for (const endpoint of endpoints) {
    if (sandboxPathContains(host, await canonicalSandboxPath(endpoint, false))) throw new Error("SANDBOX_POLICY: mount exposes a control socket endpoint");
  }
  const pending = [host];
  while (pending.length) {
    const current = pending.pop()!;
    const stat = await fs.lstat(current);
    // Symlinks inside a bind resolve in the guest namespace, not the host namespace.
    if (stat.isSymbolicLink()) continue;
    if (stat.isSocket() || path.basename(current).toLowerCase() === "docker.sock") throw new Error("SANDBOX_POLICY: control sockets cannot be mounted");
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(current)) pending.push(path.join(current, entry));
    } else if (!stat.isFile()) throw new Error("SANDBOX_POLICY: non-file resources cannot be mounted");
  }
}

export async function createSandboxPolicy(options: SandboxPolicyOptions): Promise<SandboxPolicy> {
  validateSandboxConfig(options.config);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.sessionKey) || !Number.isSafeInteger(options.revision) || options.revision < 0) {
    throw new Error("SANDBOX_POLICY: invalid session or revision");
  }
  const home = await canonicalSandboxPath(os.homedir());
  const nativeHome = await nativeSandboxHome();
  const privatePaths = await Promise.all([
    ...[...new Set([home, nativeHome])].flatMap(root => [".jeo", ".jeopi", ".docker", ".gemini", ".ssh", ".claude", ".codex", ".agents", ".aws", ".azure", ".gnupg", ".config"].map(name => path.join(root, name))),
    ...["JEO_CONFIG_DIR", "DOCKER_CONFIG", "XDG_CONFIG_HOME", "JEO_GEMINI_CREDS_PATH", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AZURE_CONFIG_DIR", "GNUPGHOME"].map(key => process.env[key]).filter((value): value is string => Boolean(value)),
    ...(options.privatePaths ?? []),
  ].map(value => canonicalSandboxPath(value, false)));
  const mounts = new Map<string, SandboxMount>();
  const workspace = await canonicalSandboxPath(options.cwd);
  const resources = [{ host: workspace, mode: "rw" as const }, ...(options.grants ?? [])];
  for (const resource of resources) {
    if (resource.mode !== "ro" && resource.mode !== "rw") throw new Error("SANDBOX_POLICY: invalid access mode");
    const host = await canonicalSandboxPath(resource.host);
    await validateSandboxMountSource(host, privatePaths);
    for (const existing of mounts.values()) {
      if (existing.host !== host && (sandboxPathContains(existing.host, host) || sandboxPathContains(host, existing.host))) {
        throw new Error("SANDBOX_MOUNT_OVERLAP: non-identical ancestor and descendant mount roots are forbidden");
      }
    }
    const existing = mounts.get(host);
    const mode = existing?.mode === "rw" ? "rw" : resource.mode;
    const guest = host === workspace ? "/workspace" : `/grants/${new Bun.CryptoHasher("sha256").update(host).digest("hex")}`;
    mounts.set(host, Object.freeze({ host, guest, mode }));
  }
  const ordered = [...mounts.values()].sort((a, b) => a.guest.localeCompare(b.guest));
  const config = Object.freeze({ image: options.config.image, limits: Object.freeze({ ...options.config.limits }) });
  const content = { sessionKey: options.sessionKey, revision: options.revision, mounts: ordered, config, privatePaths: Object.freeze(privatePaths) };
  const digest = new Bun.CryptoHasher("sha256").update(JSON.stringify(content)).digest("hex");
  return Object.freeze({ ...content, mounts: Object.freeze(ordered), digest });
}

export function sandboxGuestPath(policy: SandboxPolicy, hostPath: string): string {
  const absolute = path.resolve(hostPath);
  const mount = [...policy.mounts].sort((a, b) => b.host.length - a.host.length)
    .find(candidate => sandboxPathContains(candidate.host, absolute));
  if (!mount) throw new Error("SANDBOX_PATH: path has no approved mount");
  const relative = path.relative(mount.host, absolute).split(path.sep).join("/");
  return relative ? `${mount.guest}/${relative}` : mount.guest;
}
