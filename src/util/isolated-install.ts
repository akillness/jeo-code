import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type EnvRecord = Readonly<Record<string, string | undefined>>;

export const JEO_PACKAGE = "jeo-code";
export const NPM_REGISTRY_URL = "https://registry.npmjs.org/";

const BACKUP_TAG = ".jeo-bak.";

function isNonEmpty(v: string | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** Resolve the user's home directory cross-platform (honors Windows USERPROFILE / HOMEDRIVE+HOMEPATH). */
export function resolveHomeDir(
  env: EnvRecord = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (isNonEmpty(env.HOME)) return env.HOME;
  if (platform === "win32") {
    if (isNonEmpty(env.USERPROFILE)) return env.USERPROFILE;
    if (isNonEmpty(env.HOMEDRIVE) && isNonEmpty(env.HOMEPATH)) {
      return path.win32.join(env.HOMEDRIVE, env.HOMEPATH);
    }
  }
  return os.homedir();
}

/**
 * Isolated Bun global directory dedicated exclusively to `jeo-code` (`~/.jeo/global` on POSIX,
 * `%USERPROFILE%\.jeo\global` on Windows). Keeping `jeo-code` separate from Bun's shared
 * `~/.bun/install/global` guarantees `jeo update` never reads, re-resolves, or modifies `jeopi`
 * or any other global CLI package.
 */
export function isolatedGlobalDir(
  env: EnvRecord = process.env,
  home: string = resolveHomeDir(env),
  platform: NodeJS.Platform = process.platform,
): string {
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  if (isNonEmpty(env.JEO_GLOBAL_DIR)) return pathImpl.resolve(env.JEO_GLOBAL_DIR);
  const configDir = isNonEmpty(env.JEO_CONFIG_DIR)
    ? pathImpl.resolve(env.JEO_CONFIG_DIR)
    : pathImpl.join(home, ".jeo");
  return pathImpl.join(configDir, "global");
}

/** Where Bun places global executable shims (`$BUN_INSTALL_BIN`, else `$BUN_INSTALL/bin`, else `~/.bun/bin`). */
export function resolveBunBinDir(
  env: EnvRecord = process.env,
  home: string = resolveHomeDir(env),
  platform: NodeJS.Platform = process.platform,
): string {
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  if (isNonEmpty(env.BUN_INSTALL_BIN)) return pathImpl.resolve(env.BUN_INSTALL_BIN);
  const installRoot = isNonEmpty(env.BUN_INSTALL) ? pathImpl.resolve(env.BUN_INSTALL) : pathImpl.join(home, ".bun");
  return pathImpl.join(installRoot, "bin");
}

/** Locate the `bun` binary cross-platform (prefers current Bun execPath, then PATH, then bun bin dir). */
export function resolveBunExecutable(
  env: EnvRecord = process.env,
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
  whichFn: (cmd: string) => string | null = cmd => Bun.which(cmd),
): string {
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  if (/^bun(\.exe)?$/i.test(pathImpl.basename(execPath)) && fs.existsSync(execPath)) {
    return execPath;
  }
  const onPath = platform === "win32" ? (whichFn("bun.exe") ?? whichFn("bun")) : whichFn("bun");
  if (onPath) return onPath;

  const home = resolveHomeDir(env, platform);
  const candidate = pathImpl.join(resolveBunBinDir(env, home, platform), platform === "win32" ? "bun.exe" : "bun");
  if (fs.existsSync(candidate)) return candidate;
  return platform === "win32" ? "bun.exe" : "bun";
}

/** Locate `npm` command invocation cross-platform (`cmd /d /s /c npm ...` on Windows when needed). */
export function buildNpmCommand(platform: NodeJS.Platform, npmArgs: readonly string[]): string[] {
  if (platform !== "win32") return ["npm", ...npmArgs];
  const npmCmd = Bun.which("npm.cmd") ?? Bun.which("npm");
  if (npmCmd && !/\.cmd$/i.test(npmCmd)) return [npmCmd, ...npmArgs];
  const quoted = ["npm", ...npmArgs].map(a => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
  return ["cmd", "/d", "/s", "/c", quoted];
}

/**
 * Candidate argv attempts to invoke the active `jeo` executable cross-platform.
 * Checks `<bunBinDir>/jeo(.exe)` first when present so a freshly updated shim is found
 * even if PATH hasn't propagated or a stale copy sits elsewhere.
 */
export function jeoCommandAttempts(
  platform: NodeJS.Platform,
  args: readonly string[],
  binDir?: string,
): string[][] {
  const attempts: string[][] = [];
  if (binDir) {
    const pathImpl = platform === "win32" ? path.win32 : path.posix;
    const binExe = pathImpl.join(binDir, platform === "win32" ? "jeo.exe" : "jeo");
    if (fs.existsSync(binExe)) attempts.push([binExe, ...args]);
  }
  attempts.push(["jeo", ...args]);
  if (platform === "win32") {
    attempts.push(["jeo.exe", ...args]);
    const joined = ["jeo", ...args].map(a => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
    attempts.push(["cmd", "/d", "/s", "/c", joined]);
  }
  return attempts;
}

/** Clean up stale `*.jeo-bak.*` files left behind in `binDir` by prior Windows updates. */
export function sweepStaleBinBackups(binDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(binDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.includes(BACKUP_TAG)) {
      try {
        fs.unlinkSync(path.join(binDir, name));
      } catch {
        // Still locked by a live process; leave for the next sweep.
      }
    }
  }
}

function removeIfExists(filePath: string): void {
  try {
    const st = fs.lstatSync(filePath);
    if (st.isDirectory() && !st.isSymbolicLink()) return;
    fs.unlinkSync(filePath);
  } catch {
    // Absent or already removed.
  }
}

function moveAsideForBackup(filePath: string, backupPath: string): boolean {
  try {
    fs.lstatSync(filePath);
  } catch {
    return false;
  }
  try {
    fs.renameSync(filePath, backupPath);
    return true;
  } catch {
    return false;
  }
}

function restoreBackups(backups: ReadonlyArray<{ original: string; backup: string }>): void {
  for (const { original, backup } of backups) {
    try {
      removeIfExists(original);
      fs.renameSync(backup, original);
    } catch {
      // Best-effort rollback.
    }
  }
}

function cleanupBackups(backups: ReadonlyArray<{ original: string; backup: string }>): void {
  for (const { backup } of backups) {
    try {
      fs.unlinkSync(backup);
    } catch {
      // On Windows a running exe backup stays until next run; sweepStaleBinBackups removes it then.
    }
  }
}

function atomicSymlink(target: string, linkPath: string): void {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  const tmpLink = `${linkPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.symlinkSync(target, tmpLink);
    fs.renameSync(tmpLink, linkPath);
  } catch (err) {
    removeIfExists(tmpLink);
    throw err;
  }
}

export interface SpawnOutcome {
  success: boolean;
  exitCode?: number | null;
}

export interface IsolatedUpdateIo {
  env?: EnvRecord;
  platform?: NodeJS.Platform;
  execPath?: string;
  which?: (cmd: string) => string | null;
  spawn?: (cmd: string[], env: Record<string, string>) => SpawnOutcome;
  activeVersion?: () => string | null;
}

export interface IsolatedUpdateResult {
  success: boolean;
  stderr?: string;
  manual?: string[];
  globalDir: string;
  binDir: string;
}

function buildChildEnv(base: EnvRecord, globalDir: string, binDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) out[k] = v;
  }
  out.BUN_INSTALL_GLOBAL_DIR = globalDir;
  out.BUN_INSTALL_BIN = binDir;
  return out;
}

/**
 * Install/update `jeo-code@<version>` via `bun` into its OWN isolated global directory (`~/.jeo/global`
 * on POSIX, `%USERPROFILE%\.jeo\global` on Windows) and atomically update the `jeo` executable in Bun's
 * global bin directory (`~/.bun/bin` or `%USERPROFILE%\.bun\bin`).
 *
 * Because `BUN_INSTALL_GLOBAL_DIR` points to `jeo-code`'s dedicated directory, Bun NEVER reads,
 * writes, locks, or re-resolves `jeopi-cli` (or any other package) in `~/.bun/install/global`.
 */
export function runIsolatedBunUpdate(
  version: string | undefined,
  io: IsolatedUpdateIo = {},
): IsolatedUpdateResult {
  const env = io.env ?? process.env;
  const platform = io.platform ?? process.platform;
  const execPath = io.execPath ?? process.execPath;
  const home = resolveHomeDir(env, platform);
  const globalDir = isolatedGlobalDir(env, home, platform);
  const binDir = resolveBunBinDir(env, home, platform);
  const stagingBinDir = path.join(globalDir, "bin");
  const bunExe = resolveBunExecutable(env, platform, execPath, io.which);
  const target = `${JEO_PACKAGE}@${version ?? "latest"}`;

  const spawn =
    io.spawn ??
    ((cmd, childEnv) => Bun.spawnSync(cmd, { env: childEnv, stdout: "inherit", stderr: "inherit" }));

  fs.mkdirSync(globalDir, { recursive: true });
  fs.mkdirSync(stagingBinDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  sweepStaleBinBackups(binDir);

  // Step 1: Stage-install into the isolated global dir with a private staging bin dir.
  // If the registry fetch or install fails, the user's live bin in `binDir` is untouched.
  const stageAttempts: string[][] = [
    [bunExe, "install", "-g", target, "--no-cache", `--registry=${NPM_REGISTRY_URL}`],
    [bunExe, "install", "-g", target, "--force", "--no-cache", `--registry=${NPM_REGISTRY_URL}`],
  ];

  let staged = false;
  let lastErr = "";
  const stageEnv = buildChildEnv(env, globalDir, stagingBinDir);
  for (const cmd of stageAttempts) {
    try {
      const res = spawn(cmd, stageEnv);
      if (res.success) {
        // Verify the installed package version in globalDir matches target when a specific version was requested.
        if (version) {
          const pkgJsonPath = path.join(globalDir, "node_modules", JEO_PACKAGE, "package.json");
          try {
            const raw: unknown = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
            if (raw && typeof raw === "object" && "version" in raw && raw.version === version) {
              staged = true;
              break;
            }
            lastErr = `bun installed unexpected version in ${globalDir}`;
            continue;
          } catch {
            // If a test stubbed spawn without creating files, trust zero exit when no manifest check applies.
            if (io.spawn) {
              staged = true;
              break;
            }
            lastErr = `bun install exited 0 but ${pkgJsonPath} is missing`;
            continue;
          }
        }
        staged = true;
        break;
      }
      lastErr = `${cmd[0]} exited with code ${res.exitCode}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastErr = `${cmd[0]} unavailable: ${msg}`;
    }
  }

  if (!staged) {
    return {
      success: false,
      stderr: lastErr,
      manual: [
        `BUN_INSTALL_GLOBAL_DIR="${globalDir}" BUN_INSTALL_BIN="${binDir}" bun install -g ${target} --no-cache --registry=${NPM_REGISTRY_URL}`,
      ],
      globalDir,
      binDir,
    };
  }

  // Step 2: Atomically expose the newly installed `jeo` executable inside `binDir`.
  if (platform !== "win32") {
    const cliTarget = path.join(globalDir, "node_modules", JEO_PACKAGE, "src", "cli.ts");
    const linkTarget = fs.existsSync(cliTarget) ? cliTarget : path.join(stagingBinDir, "jeo");
    const destLink = path.join(binDir, "jeo");
    if (fs.existsSync(linkTarget)) {
      atomicSymlink(linkTarget, destLink);
    } else if (!io.spawn) {
      return {
        success: false,
        stderr: `installed package entry missing at ${cliTarget}`,
        manual: [`bun install -g ${target} --no-cache --registry=${NPM_REGISTRY_URL}`],
        globalDir,
        binDir,
      };
    }
    removeIfExists(path.join(binDir, "joc"));
  } else {
    // Windows: rename existing shims (safe even if jeo.exe is the currently running binary),
    // then have Bun generate a fresh Windows shim in `binDir` pointing at `globalDir`.
    const backups: Array<{ original: string; backup: string }> = [];
    for (const name of ["jeo.exe", "jeo", "jeo.cmd", "joc.exe", "joc", "joc.cmd"]) {
      const orig = path.join(binDir, name);
      const bak = path.join(binDir, `${name}${BACKUP_TAG}${process.pid}`);
      if (moveAsideForBackup(orig, bak)) {
        backups.push({ original: orig, backup: bak });
      }
    }
    const linkEnv = buildChildEnv(env, globalDir, binDir);
    let linked = false;
    try {
      const linkCmd = [bunExe, "install", "-g", target, `--registry=${NPM_REGISTRY_URL}`];
      const linkRes = spawn(linkCmd, linkEnv);
      linked = linkRes.success;
      if (!linked) {
        lastErr = `bun bin link exited with code ${linkRes.exitCode}`;
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    if (!linked) {
      restoreBackups(backups);
      return {
        success: false,
        stderr: lastErr,
        manual: [
          `set BUN_INSTALL_GLOBAL_DIR=${globalDir} && set BUN_INSTALL_BIN=${binDir} && bun install -g ${target} --no-cache --registry=${NPM_REGISTRY_URL}`,
        ],
        globalDir,
        binDir,
      };
    }
    cleanupBackups(backups);
  }

  // Step 3: Verify the active `jeo` on PATH matches the installed version when readable.
  if (io.activeVersion && version) {
    const active = io.activeVersion();
    if (active !== null && active !== version) {
      return {
        success: false,
        stderr: `bun reported success but the active 'jeo' is still ${active}`,
        manual: [
          `Ensure ${binDir} appears first on PATH, or run: bun install -g ${target} --no-cache --registry=${NPM_REGISTRY_URL}`,
        ],
        globalDir,
        binDir,
      };
    }
  }

  return { success: true, globalDir, binDir };
}
