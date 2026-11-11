import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SandboxLaunchError } from "./docker";
import { canonicalSandboxPath, sandboxPathContains, validateSandboxConfig, validateSandboxMountSource } from "./policy";
import type { SandboxBackend, SandboxConfig, SandboxMount, SandboxPolicy, SandboxProcess, SandboxTermination } from "./types";

/**
 * Docker-free session sandbox: the operating system's own process sandbox confines the
 * hands runtime. macOS uses Seatbelt (`/usr/bin/sandbox-exec`, shipped with the OS); Linux
 * uses bubblewrap (`bwrap`). Anything else has no native mechanism and fails closed.
 *
 * Boundary, both platforms: no network; writes only to the approved read-write mounts and a
 * private per-session scratch directory; the user's home, other volumes, shared temp
 * directories and every policy private path are unreadable except for the approved mounts,
 * the trusted read-only roots (global skill directories) and the runtime itself. System
 * directories stay readable so the host toolchain (git, python, a shell) keeps working.
 * There are no cgroup limits: the native backend bounds reach, not resource use.
 *
 * Lifecycle: ending a session kills every process it started, including a descendant that called setsid
 * and was re-parented to launchd (where ancestry and the process group no longer reach it). On macOS the
 * kernel names the members: a sandbox is inherited across fork, exec and setsid and cannot be shed, and
 * each session's profile allows one unique mach service name that no other profile does. On Linux the
 * bubblewrap PID namespace dies with its init. A launch that cannot prove membership fails closed.
 * `reapOrphanedNativeProcesses` kills the processes of sessions whose owning host died without cleanup.
 */

interface NativeChild {
  readonly pid: number;
  readonly stdin: SandboxProcess["stdin"];
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
}

/** Default time a termination keeps killing and rescanning before it gives up and reports the failure. */
const TERMINATION_DEADLINE_MS = 10_000;

export interface NativeBackendOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** Trusted host directories exposed read-only (never model-chosen): the global skill roots. */
  readOnlyRoots?: readonly string[];
  /** Runtime that executes the hands bundle; defaults to this process's own executable. */
  runtimePath?: string;
  sandboxExecPath?: string;
  bwrapPath?: string;
  /** Parent of the per-session scratch directories; defaults to the OS temp directory. */
  scratchRoot?: string;
  run?: (argv: readonly string[]) => Promise<number>;
  spawn?: (argv: readonly string[], options: { cwd: string; env: Record<string, string> }) => NativeChild;
  signal?: (pid: number, signal: NodeJS.Signals | 0) => void;
  listProcesses?: () => Promise<ReadonlyArray<HostProcess>>;
  /** Whether `pid` runs under the session sandbox whose scratch directory is `session` (macOS Seatbelt). */
  isMember?: (pid: number, session: string) => boolean;
  /** How long ending a session keeps killing before it reports its members as not provably gone. */
  deadlineMs?: number;
}

export interface NativeSandboxLayout {
  /** Read-write and read-only mounts, at their host paths. */
  mounts: readonly SandboxMount[];
  readOnlyRoots: readonly string[];
  privatePaths: readonly string[];
  /** Private scratch root: `home/` and `tmp/` are writable, `runtime/` is read-only. */
  session: string;
  /** Canonical path of the executable that runs the hands bundle. */
  runtime: string;
  home: string;
}

/** Mach services a command-line toolchain needs (user lookup, logging); nothing that can launch apps. */
const SEATBELT_MACH_SERVICES = [
  "com.apple.system.opendirectoryd.libinfo",
  "com.apple.system.opendirectoryd.membership",
  "com.apple.system.logger",
  "com.apple.system.notification_center",
  "com.apple.logd",
  "com.apple.bsd.dirhelper",
];

function sbplString(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("SANDBOX_POLICY: unsupported control character in a sandbox path");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function ancestorsOf(file: string): string[] {
  const out: string[] = [];
  for (let current = path.dirname(file); current !== path.dirname(current); current = path.dirname(current)) out.push(current);
  return out;
}

/**
 * Seatbelt profile for one session revision. Deny reads by default; explicitly expose
 * system and toolchain paths, then the approved trees. Paths must be canonical:
 * Seatbelt matches the resolved path, never a symlink.
 */
export function seatbeltProfile(layout: NativeSandboxLayout): string {
  const subpaths = (values: readonly string[]): string => values.map(value => `(subpath ${sbplString(value)})`).join(" ");
  const literals = (values: readonly string[]): string => values.map(value => `(literal ${sbplString(value)})`).join(" ");
  const systemRoots = ["/System", "/usr/bin", "/usr/sbin", "/usr/lib", "/usr/libexec", "/usr/share", "/bin", "/sbin", "/dev", "/private/etc", "/Library/Apple", "/opt/homebrew/bin", "/opt/homebrew/lib", "/opt/homebrew/share", "/opt/homebrew/Cellar", "/usr/local/bin", "/usr/local/lib", "/usr/local/share", "/usr/local/Cellar"];
  const readable = [...new Set([...layout.mounts.map(mount => mount.host), ...layout.readOnlyRoots, layout.session])];
  const writable = [...new Set([...layout.mounts.filter(mount => mount.mode === "rw").map(mount => mount.host), path.join(layout.session, "home"), path.join(layout.session, "tmp")])];
  // realpath/stat must be able to walk down to an allowed tree through a denied root.
  const traversable = [...new Set([...systemRoots, ...readable, layout.runtime].flatMap(ancestorsOf))];
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec*)",
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow ipc-posix-shm)",
    "(allow ipc-posix-sem)",
    `(allow mach-lookup ${SEATBELT_MACH_SERVICES.map(name => `(global-name ${sbplString(name)})`).join(" ")})`,
    // The kernel-held tag of this session's processes: no other session's profile allows this name.
    `(allow mach-lookup (global-name ${sbplString(sessionService(layout.session))}))`,
    `(allow file-read* ${subpaths(systemRoots)})`,
    '(allow file-read* (literal "/"))',
    `(deny file-read* ${subpaths(layout.privatePaths)})`,
    `(allow file-read-metadata ${literals(traversable)})`,
    `(allow file-read* ${subpaths(readable)} (literal ${sbplString(layout.runtime)}))`,
    `(allow file-write* ${subpaths(writable)})`,
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (literal "/dev/stdout") (literal "/dev/stderr") (subpath "/dev/fd"))',
    '(allow file-ioctl (literal "/dev/null"))',
    "",
  ].join("\n");
}

/**
 * bubblewrap argv (without the program to run). Mount order is the policy: a read-only root,
 * empty tmpfs over every user-data and shared-state root, then the approved trees bound back
 * at their host paths. `existing` reports what each masked path currently is on the host.
 */
export function bubblewrapArgs(layout: NativeSandboxLayout, existing: ReadonlyMap<string, "dir" | "file">, env: Record<string, string>, cwd: string): string[] {
  const args = [
    "--die-with-parent", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
  ];
  const masked: string[] = [];
  const mask = (target: string): void => {
    if (masked.some(root => sandboxPathContains(root, target))) return;
    const kind = existing.get(target);
    if (kind === "dir") args.push("--tmpfs", target);
    else if (kind === "file") args.push("--ro-bind", "/dev/null", target);
    else return;
    masked.push(target);
  };
  for (const root of ["/tmp", "/var/tmp", "/run", "/mnt", "/media", "/home", "/root", layout.home]) mask(root);
  for (const privatePath of layout.privatePaths) mask(privatePath);
  for (const root of layout.readOnlyRoots) args.push("--ro-bind", root, root);
  args.push("--ro-bind", layout.runtime, layout.runtime);
  for (const mount of layout.mounts) args.push(mount.mode === "rw" ? "--bind" : "--ro-bind", mount.host, mount.host);
  args.push("--bind", layout.session, layout.session, "--ro-bind", path.join(layout.session, "runtime"), path.join(layout.session, "runtime"));
  args.push("--clearenv");
  for (const [key, value] of Object.entries(env)) args.push("--setenv", key, value);
  args.push("--chdir", cwd, "--");
  return args;
}

/** A host process and its parent. */
export interface HostProcess {
  readonly pid: number;
  readonly ppid: number;
}

type SignalFn = (pid: number, signal: NodeJS.Signals | 0) => void;

/** The mach service only this session's Seatbelt profile allows: the kernel-held tag of its processes. */
export function sessionService(session: string): string {
  return `com.jeo.sandbox.${path.basename(session)}`;
}

type SandboxCheck = (pid: number, operation: string, filter: number, argument: string) => number;
const SANDBOX_FILTER_GLOBAL_NAME = 2;
let sandboxCheck: SandboxCheck | null | undefined;

/** libsandbox's `sandbox_check`: the kernel's answer to "would this process's sandbox allow that?". */
function loadSandboxCheck(): SandboxCheck | null {
  if (sandboxCheck !== undefined) return sandboxCheck;
  sandboxCheck = null;
  if (process.platform !== "darwin") return null;
  try {
    // Variadic: arm64 Darwin reads the variadic argument from the stack, where the ninth integer argument
    // lands; x86_64 passes it in a register like any fourth argument.
    const arm = process.arch === "arm64";
    const { symbols } = dlopen("/usr/lib/libsandbox.1.dylib", {
      sandbox_check: {
        args: arm
          ? [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.ptr]
          : [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr],
        returns: FFIType.i32,
      },
    });
    const call = symbols.sandbox_check as unknown as (...args: unknown[]) => number;
    sandboxCheck = (pid, operation, filter, argument) => {
      const op = Buffer.from(`${operation}\0`);
      const arg = Buffer.from(`${argument}\0`);
      return arm ? call(pid, ptr(op), filter, 0n, 0n, 0n, 0n, 0n, ptr(arg)) : call(pid, ptr(op), filter, ptr(arg));
    };
  } catch { /* No libsandbox: membership is unprovable, and launch fails closed. */ }
  return sandboxCheck;
}

/**
 * Whether `pid` runs under this session's Seatbelt profile. A sandbox is inherited across fork, exec
 * and setsid and cannot be shed, so this holds for a re-parented descendant that no longer shows up in
 * the leader's ancestry (and for system binaries whose environment `ps` hides). An unsandboxed process
 * fails the first check, one under another session's profile or a missing pid the second, and a
 * third-party profile that allows every mach name fails the canary: only a profile that allows exactly
 * this session's name qualifies.
 */
export function isSessionMember(pid: number, session: string): boolean {
  const check = loadSandboxCheck();
  if (!check) return false;
  const service = sessionService(session);
  return check(pid, "network-outbound", 0, "") !== 0 &&
    check(pid, "mach-lookup", SANDBOX_FILTER_GLOBAL_NAME, service) === 0 &&
    check(pid, "mach-lookup", SANDBOX_FILTER_GLOBAL_NAME, `${service}.canary`) !== 0;
}

/** Every process on the host with its parent. */
async function listHostProcesses(platform: NodeJS.Platform): Promise<HostProcess[]> {
  const out: HostProcess[] = [];
  if (platform === "linux") {
    for (const entry of await fs.readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = await fs.readFile(`/proc/${entry}/stat`, "utf8");
        out.push({ pid: Number(entry), ppid: Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) });
      } catch { /* Gone since the directory listing. */ }
    }
    return out;
  }
  const child = Bun.spawn(["ps", "-axo", "pid=,ppid="], { env: { PATH: "/bin:/usr/bin" }, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (code !== 0) throw new Error("process listing failed");
  for (const row of text.split("\n").map(line => line.trim().split(/\s+/).map(Number))) {
    if (row.length === 2 && row.every(Number.isSafeInteger) && row[0] !== child.pid) out.push({ pid: row[0]!, ppid: row[1]! });
  }
  return out;
}

/** The session's members, plus (while its leader lives) the leader's whole ancestry subtree. */
function selectMembers(all: ReadonlyArray<HostProcess>, isMemberPid: (pid: number) => boolean, leader: number | undefined): HostProcess[] {
  const chosen = new Map<number, HostProcess>();
  for (const entry of all) if (isMemberPid(entry.pid)) chosen.set(entry.pid, entry);
  if (leader !== undefined) {
    const tree = new Set([leader]);
    for (let grew = true; grew;) {
      grew = false;
      for (const entry of all) if (tree.has(entry.ppid) && !tree.has(entry.pid)) { tree.add(entry.pid); grew = true; }
    }
    for (const entry of all) if (tree.has(entry.pid)) chosen.set(entry.pid, entry);
  }
  return [...chosen.values()];
}

interface Termination {
  readonly scan: () => Promise<ReadonlyArray<HostProcess>>;
  readonly select: (all: ReadonlyArray<HostProcess>) => HostProcess[];
  readonly signal: SignalFn;
  readonly deadline: number;
  /** The process group of a live leader, if any. */
  readonly group?: () => number | undefined;
}

/**
 * Kill every selected process and prove it. SIGSTOP first: a stopped process cannot fork, so
 * rescanning until the set stops growing closes the window in which a child slips out between a
 * scan and the kill. `complete` is true only when a fresh scan selects nothing; a failed scan or
 * a missed deadline is incomplete, never a silent success.
 */
async function terminateProcesses(job: Termination): Promise<{ complete: boolean; killed: number }> {
  const send = (target: number, name: NodeJS.Signals): void => {
    const id = Math.abs(target);
    if (!Number.isSafeInteger(id) || id <= 1 || id === process.pid) return;
    try { job.signal(target, name); } catch { /* ESRCH: already gone; EPERM: not ours to signal. */ }
  };
  const killed = new Set<number>();
  for (;;) {
    let members: HostProcess[];
    try { members = job.select(await job.scan()); }
    catch { return { complete: false, killed: killed.size }; }
    if (members.length === 0) return { complete: true, killed: killed.size };
    // One group for the whole pass: a leader that dies after the freeze must still get the group kill.
    const group = job.group?.();
    const frozen = new Map(members.map(member => [member.pid, member]));
    for (let round = 0; round < 8; round++) {
      if (group !== undefined) send(-group, "SIGSTOP");
      for (const member of frozen.values()) send(member.pid, "SIGSTOP");
      let grew = false;
      try {
        for (const member of job.select(await job.scan())) {
          if (!frozen.has(member.pid)) { frozen.set(member.pid, member); grew = true; }
        }
      } catch { break; }
      if (!grew) break;
    }
    if (group !== undefined) send(-group, "SIGKILL");
    for (const member of frozen.values()) { send(member.pid, "SIGKILL"); killed.add(member.pid); }
    if (Date.now() >= job.deadline) return { complete: false, killed: killed.size };
    await Bun.sleep(25);
  }
}

export interface ReapOptions {
  platform?: NodeJS.Platform;
  /** Parent of the per-session scratch directories; defaults to the OS temp directory. */
  scratchRoot?: string;
  listProcesses?: () => Promise<ReadonlyArray<HostProcess>>;
  isMember?: (pid: number, session: string) => boolean;
  signal?: SignalFn;
  /** Whether the host process that owned a session still runs; defaults to a signal-0 probe. */
  ownerAlive?: (pid: number) => boolean;
  /** How long a reap keeps killing before it reports the members as not provably gone. */
  deadlineMs?: number;
}

/**
 * Kill the processes of native sessions whose owning host died without ending them (it crashed or was
 * killed), then remove their scratch directories. A session whose owner still lives is never touched.
 * A reused owner pid only delays the reaping; it can never kill a live owner's session.
 */
export async function reapOrphanedNativeProcesses(options: ReapOptions = {}): Promise<{ reaped: number; complete: boolean }> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return { reaped: 0, complete: true };
  const scan = options.listProcesses ?? ((): Promise<ReadonlyArray<HostProcess>> => listHostProcesses(platform));
  const member = options.isMember ?? ((memberPid: number, session: string): boolean => platform === "darwin" && isSessionMember(memberPid, session));
  const signal = options.signal ?? ((target: number, name: NodeJS.Signals | 0): void => { process.kill(target, name); });
  const ownerAlive = options.ownerAlive ?? ((ownerPid: number): boolean => {
    if (ownerPid === process.pid) return true;
    try { process.kill(ownerPid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  });
  let root: string;
  let entries: string[];
  try {
    root = await canonicalSandboxPath(options.scratchRoot ?? os.tmpdir());
    entries = await fs.readdir(root);
  } catch { return { reaped: 0, complete: true }; }
  let reaped = 0;
  let complete = true;
  for (const entry of entries) {
    if (!/^jeo-sandbox-native-[A-Za-z0-9]{6}$/.test(entry)) continue;
    const session = path.join(root, entry);
    // No owner file: a live host is still creating this session.
    const owner = Number(await fs.readFile(path.join(session, "runtime", "owner"), "utf8").catch(() => ""));
    if (!Number.isSafeInteger(owner) || owner <= 1 || ownerAlive(owner)) continue;
    const outcome = await terminateProcesses({ scan, select: all => selectMembers(all, memberPid => member(memberPid, session), undefined), signal, deadline: Date.now() + (options.deadlineMs ?? TERMINATION_DEADLINE_MS) });
    reaped += outcome.killed;
    if (outcome.complete) await fs.rm(session, { recursive: true, force: true }).catch(() => { /* Scratch files are not authority. */ });
    else complete = false;
  }
  return { reaped, complete };
}

export function createNativeBackend(options: NativeBackendOptions = {}): SandboxBackend {
  const platform = options.platform ?? process.platform;
  const suppliedEnv = options.env ?? process.env;
  const sandboxExec = options.sandboxExecPath ?? "/usr/bin/sandbox-exec";
  const bwrap = options.bwrapPath ?? Bun.which("bwrap") ?? "bwrap";
  const run = options.run ?? (async (argv: readonly string[]): Promise<number> => {
    const child = Bun.spawn([...argv], { env: { PATH: suppliedEnv.PATH ?? "/usr/bin:/bin" }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), 30_000);
    try { return await child.exited; }
    finally { clearTimeout(timer); }
  });
  // Its own process group and session: no controlling terminal, and one signal reaches the whole tree.
  const spawn = options.spawn ?? ((argv: readonly string[], spawnOptions: { cwd: string; env: Record<string, string> }): NativeChild =>
    Bun.spawn([...argv], { cwd: spawnOptions.cwd, env: spawnOptions.env, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true }) as unknown as NativeChild);
  const signal = options.signal ?? ((pid: number, name: NodeJS.Signals | 0): void => { process.kill(pid, name); });
  const listProcesses = options.listProcesses ?? ((): Promise<ReadonlyArray<HostProcess>> => listHostProcesses(platform));
  const isMember = options.isMember ?? ((memberPid: number, session: string): boolean => platform === "darwin" && isSessionMember(memberPid, session));
  let qualified: Promise<{ imageId: string; platform: string }> | undefined;

  function preflight(config: SandboxConfig): Promise<{ imageId: string; platform: string }> {
    validateSandboxConfig(config);
    if (config.backend !== "native") return Promise.reject(new Error("SANDBOX_CONFIG: the native backend cannot run a container policy"));
    qualified ??= (async () => {
      if (platform !== "win32" && process.getuid?.() === 0) throw new Error("SANDBOX_UNAVAILABLE: run the host controller as a non-root user");
      let probe: string[];
      let mechanism: string;
      if (platform === "darwin") {
        mechanism = "seatbelt";
        probe = [sandboxExec, "-p", "(version 1)(allow default)", "/usr/bin/true"];
      } else if (platform === "linux") {
        mechanism = "bubblewrap";
        probe = [bwrap, "--die-with-parent", "--unshare-net", "--unshare-pid", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--", Bun.which("true") ?? "/bin/true"];
      } else {
        throw new Error(`SANDBOX_UNAVAILABLE: no native sandbox exists on ${platform}; configure a Docker sandbox block (image and limits) instead`);
      }
      let code: number;
      try { code = await run(probe); }
      catch { code = -1; }
      if (code !== 0) {
        throw new Error(platform === "darwin"
          ? "SANDBOX_UNAVAILABLE: macOS Seatbelt (/usr/bin/sandbox-exec) could not start; a process that is already sandboxed cannot create a nested sandbox"
          : "SANDBOX_UNAVAILABLE: bubblewrap could not create a sandbox; install bwrap and allow unprivileged user namespaces, or configure a Docker sandbox block instead");
      }
      return { imageId: `native:${mechanism}`, platform: `${platform}/${process.arch}` };
    })();
    const attempt = qualified;
    // A failed probe is not cached: installing bwrap must not require a gateway restart.
    void attempt.catch(() => { if (qualified === attempt) qualified = undefined; });
    return attempt;
  }

  async function launch(policy: SandboxPolicy, bundlePath: string): Promise<SandboxProcess> {
    await preflight(policy.config);
    const workspace = policy.workspace;
    if (!workspace || !policy.mounts.some(mount => mount.host === workspace && mount.mode === "rw")) throw new Error("SANDBOX_POLICY: native policy has no workspace mount");
    for (const mount of policy.mounts) {
      if (mount.guest !== mount.host || await canonicalSandboxPath(mount.host) !== mount.host) throw new Error("SANDBOX_POLICY: native mount changed or is not at its host path");
      await validateSandboxMountSource(mount.host, policy.privatePaths ?? []);
    }
    const bundle = await canonicalSandboxPath(bundlePath);
    if (!(await fs.stat(bundle)).isFile()) throw new Error("SANDBOX_POLICY: hands bundle is not a regular file");
    const runtime = await canonicalSandboxPath(options.runtimePath ?? process.execPath);
    const home = await canonicalSandboxPath(os.homedir());
    const readOnlyRoots: string[] = [];
    for (const root of options.readOnlyRoots ?? []) {
      let canonical: string;
      try {
        canonical = await canonicalSandboxPath(root);
        if (!(await fs.stat(canonical)).isDirectory()) continue;
      } catch { continue; }
      if (canonical !== path.resolve(root)) throw new Error("SANDBOX_POLICY: read-only root changed or is not canonical");
      // A trusted root may sit inside a private tree (~/.agents/skills) but never expose one.
      if (canonical === path.parse(canonical).root || sandboxPathContains(canonical, home) ||
          (policy.privatePaths ?? []).some(privatePath => sandboxPathContains(canonical, privatePath))) {
        throw new Error("SANDBOX_POLICY: a read-only root would expose private state");
      }
      if (!readOnlyRoots.includes(canonical)) readOnlyRoots.push(canonical);
    }
    const session = await fs.mkdtemp(path.join(await canonicalSandboxPath(options.scratchRoot ?? os.tmpdir()), "jeo-sandbox-native-"));
    const removeSession = (): Promise<void> => fs.rm(session, { recursive: true, force: true }).catch(() => { /* Scratch files are not authority. */ });
    let child: NativeChild;
    try {
      if (policy.mounts.some(mount => sandboxPathContains(mount.host, session) || sandboxPathContains(session, mount.host))) {
        throw new Error("SANDBOX_POLICY: a mount overlaps the sandbox scratch directory");
      }
      const runtimeDirectory = path.join(session, "runtime");
      for (const directory of [runtimeDirectory, path.join(runtimeDirectory, "bin"), path.join(session, "home"), path.join(session, "tmp")]) await fs.mkdir(directory, { mode: 0o700 });
      // A private copy: Bun must read the directory that holds its entry point, and the
      // trusted bundle store under the jeo home stays invisible to the guest.
      const hands = path.join(runtimeDirectory, "hands.js");
      await fs.copyFile(bundle, hands);
      // `bun` on PATH is this same runtime, also when it is a compiled jeo executable.
      await fs.symlink(runtime, path.join(runtimeDirectory, "bin", "bun"));
      // Names the owning host so a later host can tell a crashed session from a live one.
      await fs.writeFile(path.join(runtimeDirectory, "owner"), String(process.pid), { mode: 0o444 });
      const layout: NativeSandboxLayout = { mounts: policy.mounts, readOnlyRoots, privatePaths: policy.privatePaths ?? [], session, runtime, home };
      const hidden = platform === "darwin"
        ? [home, "/Users", "/Volumes", "/private/var/folders", "/private/tmp", "/private/var/tmp", ...layout.privatePaths]
        : ["/tmp", "/var/tmp", "/run", "/mnt", "/media", "/home", "/root", home, ...layout.privatePaths];
      const visible = [...policy.mounts.map(mount => mount.host), ...readOnlyRoots];
      const searchPath: string[] = [path.join(runtimeDirectory, "bin")];
      for (const entry of (suppliedEnv.PATH ?? "").split(path.delimiter)) {
        if (!path.isAbsolute(entry)) continue;
        let directory: string;
        try { directory = await canonicalSandboxPath(entry); } catch { continue; }
        if (hidden.some(root => sandboxPathContains(root, directory)) && !visible.some(root => sandboxPathContains(root, directory))) continue;
        if (!searchPath.includes(directory)) searchPath.push(directory);
      }
      const env: Record<string, string> = {
        PATH: searchPath.join(path.delimiter),
        HOME: path.join(session, "home"),
        JEO_CONFIG_DIR: path.join(session, "home"),
        TMPDIR: path.join(session, "tmp"),
        JEO_SANDBOX_HANDS: "1",
        BUN_BE_BUN: "1",
      };
      for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM"]) {
        const value = suppliedEnv[key];
        if (value !== undefined && !/[\u0000\n\r]/.test(value)) env[key] = value;
      }
      let argv: string[];
      if (platform === "darwin") {
        const profile = path.join(runtimeDirectory, "profile.sb");
        await fs.writeFile(profile, seatbeltProfile(layout), { mode: 0o400 });
        argv = [sandboxExec, "-f", profile, runtime, hands];
      } else {
        const existing = new Map<string, "dir" | "file">();
        for (const target of hidden) {
          const stat = await fs.lstat(target).catch(() => undefined);
          if (stat?.isDirectory()) existing.set(target, "dir");
          else if (stat?.isFile()) existing.set(target, "file");
        }
        argv = [bwrap, ...bubblewrapArgs(layout, existing, env, workspace), runtime, hands];
      }
      child = spawn(argv, { cwd: workspace, env });
    } catch (error) {
      await removeSession();
      throw error;
    }
    const pid = child.pid;
    const name = `jeo-native-${new Bun.CryptoHasher("sha256").update(policy.sessionKey).digest("hex").slice(0, 20)}-r${policy.revision}-${pid}`;
    let exited = false;
    void child.exited.then(() => { exited = true; }, () => { exited = true; });
    let stopping: Promise<SandboxTermination> | undefined;
    const stop = (): Promise<SandboxTermination> => {
      stopping ??= (async (): Promise<SandboxTermination> => {
        // Kernel sandbox membership finds a descendant that called setsid and was re-parented (where
        // ancestry no longer reaches it); the leader's tree and process group cover the rest.
        const outcome = await terminateProcesses({
          scan: listProcesses,
          select: all => selectMembers(all, memberPid => isMember(memberPid, session), exited ? undefined : pid),
          signal,
          group: () => (exited ? undefined : pid),
          deadline: Date.now() + (options.deadlineMs ?? TERMINATION_DEADLINE_MS),
        });
        // Bun reaps the leader asynchronously; a complete outcome already needed it to leave the scan.
        if (!exited) await Promise.race([child.exited.catch(() => undefined), Bun.sleep(1_000)]);
        if (outcome.complete && exited) {
          await removeSession();
          return { gone: true, residual: [] };
        }
        return { gone: false, residual: [name] };
      })();
      const attempt = stopping;
      void attempt.then(result => { if (!result.gone && stopping === attempt) stopping = undefined; });
      return attempt;
    };
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      const cleanup = await stop();
      throw new SandboxLaunchError("SANDBOX_UNAVAILABLE: native sandbox process did not start", cleanup.gone ? [] : cleanup.residual, stop);
    }
    // macOS cannot enumerate a session's processes any other way, so a launch whose members cannot be
    // told apart from the host fails closed instead of promising a cleanup it could not prove.
    if (platform === "darwin" && !options.spawn && !options.isMember) {
      let verified = false;
      for (let attempts = 0; attempts < 100 && !verified && !exited; attempts++) {
        verified = isMember(pid, session);
        if (!verified) await Bun.sleep(20);
      }
      if (!verified) {
        const cleanup = await stop();
        throw new SandboxLaunchError("SANDBOX_UNAVAILABLE: native sandbox could not prove which processes belong to the session", cleanup.gone ? [] : cleanup.residual, stop);
      }
    }
    return { name, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited: child.exited, stop };
  }

  return { preflight, launch };
}
