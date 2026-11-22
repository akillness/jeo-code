/**
 * macOS launchd service management (`dev.jeo.thread-orchestrator`).
 * Never writes Discord bot tokens into the plist; the daemon reads credentials at runtime.
 */

import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expandTilde, orchPaths, resolveOrchHome } from "./store";

export const ORCH_LAUNCHD_LABEL = "dev.jeo.thread-orchestrator";

export function launchdPlistPath(home = os.homedir()): string {
  return path.join(path.resolve(expandTilde(home)), "Library", "LaunchAgents", `${ORCH_LAUNCHD_LABEL}.plist`);
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function isBunVirtualPath(value: string): boolean {
  return value.startsWith("/$bunfs/") || value.replaceAll("\\", "/").startsWith("B:/~BUN/");
}

function isJsRuntimeBinary(binaryPath: string): boolean {
  const base = path.basename(binaryPath).toLowerCase();
  return (
    base === "bun" ||
    base === "bun.exe" ||
    base === "node" ||
    base === "node.exe" ||
    base === "deno" ||
    base === "deno.exe"
  );
}

export function currentJeoCommand(
  entry?: string,
  execPath = process.execPath,
): string[] {
  const trimmedExec = execPath.trim();
  const expandedExec = trimmedExec ? expandTilde(trimmedExec) : "";
  const binary = expandedExec
    ? path.isAbsolute(expandedExec) ||
      expandedExec.includes("/") ||
      expandedExec.includes("\\") ||
      expandedExec.startsWith(".")
      ? path.resolve(expandedExec)
      : path.join(os.homedir(), ".bun", "bin", "bun")
    : path.join(os.homedir(), ".bun", "bin", "bun");

  if (entry) {
    const trimmedEntry = entry.trim();
    if (isBunVirtualPath(trimmedEntry)) {
      return [binary];
    }
    const expandedEntry = expandTilde(trimmedEntry);
    if (path.isAbsolute(expandedEntry)) {
      const resolvedEntry = path.resolve(expandedEntry);
      if (resolvedEntry === binary) return [binary];
      return [binary, resolvedEntry];
    }
  }
  if (isBunVirtualPath(import.meta.dir) || !isJsRuntimeBinary(binary)) {
    return [binary];
  }
  const devEntry = path.resolve(import.meta.dir, "../cli.ts");
  if (fsSync.existsSync(devEntry)) {
    return [binary, devEntry];
  }
  const distEntry = path.resolve(import.meta.dir, "jeo.js");
  if (fsSync.existsSync(distEntry)) {
    return [binary, distEntry];
  }
  return [binary, devEntry];
}

export function buildLaunchdPlist(opts: {
  programArgs: string[];
  orchHome: string;
  workingDir?: string;
  pathEnv?: string;
  homeDir?: string;
}): string {
  const orchHome = path.resolve(expandTilde(opts.orchHome));
  const homeDir = path.resolve(expandTilde(opts.homeDir ?? os.homedir()));
  const workingDir = path.resolve(expandTilde(opts.workingDir ?? orchHome));
  const resolvedProgramArgs = opts.programArgs.map(arg =>
    arg === "~" || arg.startsWith("~/") || arg.startsWith("~\\") ? path.resolve(expandTilde(arg)) : arg,
  );
  const args = [...resolvedProgramArgs, "orch", "daemon"];
  const stdoutLog = path.join(orchHome, "daemon.stdout.log");
  const stderrLog = path.join(orchHome, "daemon.stderr.log");
  const defaultPath = [
    "/Applications/Orca.app/Contents/Resources/bin",
    path.join(homeDir, ".bun", "bin"),
    path.join(homeDir, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");
  const pathEnv = opts.pathEnv ?? defaultPath;

  const argsXml = args.map(a => `    <string>${xmlEscape(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(ORCH_LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(workingDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrLog)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEscape(homeDir)}</string>
    <key>JEO_ORCH_HOME</key>
    <string>${xmlEscape(orchHome)}</string>
    <key>PATH</key>
    <string>${xmlEscape(pathEnv)}</string>
  </dict>
</dict>
</plist>
`;
}

async function execLaunchctl(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function guiDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  return `gui/${uid}`;
}

export async function getLaunchdStatus(home = os.homedir()): Promise<{
  installed: boolean;
  loaded: boolean;
  plistPath: string;
  detail: string;
}> {
  const plistPath = launchdPlistPath(home);
  let installed = false;
  try {
    await fs.access(plistPath);
    installed = true;
  } catch {
    installed = false;
  }

  if (process.platform !== "darwin") {
    return { installed, loaded: false, plistPath, detail: "launchd is only available on macOS." };
  }

  const target = `${guiDomain()}/${ORCH_LAUNCHD_LABEL}`;
  const res = await execLaunchctl(["print", target]);
  if (res.exitCode === 0) {
    const pidMatch = res.stdout.match(/\bpid\s*=\s*(\d+)/);
    const stateMatch = res.stdout.match(/\bstate\s*=\s*([^\n]+)/);
    const pid = pidMatch ? `pid=${pidMatch[1]}` : "no pid";
    const st = stateMatch ? stateMatch[1]!.trim() : "loaded";
    return { installed, loaded: true, plistPath, detail: `${st} (${pid})` };
  }
  return {
    installed,
    loaded: false,
    plistPath,
    detail: installed ? "plist installed, service not loaded" : "not installed",
  };
}

export interface InstallLaunchdOptions {
  orchHome?: string;
  programArgs?: string[];
  load?: boolean;
  homeDir?: string;
  pathEnv?: string;
}

export async function installLaunchdService(
  opts: InstallLaunchdOptions = {},
): Promise<{ plistPath: string; loaded: boolean; detail: string }> {
  const orchHome = resolveOrchHome(opts.orchHome);
  const { home } = orchPaths(orchHome);
  await fs.mkdir(home, { recursive: true });

  const homeDir = path.resolve(expandTilde(opts.homeDir ?? os.homedir()));
  const plistPath = launchdPlistPath(homeDir);
  await fs.mkdir(path.dirname(plistPath), { recursive: true });

  const programArgs = (opts.programArgs ?? currentJeoCommand()).map(arg =>
    arg === "~" || arg.startsWith("~/") || arg.startsWith("~\\") ? path.resolve(expandTilde(arg)) : arg,
  );
  const plistXml = buildLaunchdPlist({
    programArgs,
    orchHome,
    workingDir: orchHome,
    homeDir,
    pathEnv: opts.pathEnv,
  });
  await fs.writeFile(plistPath, plistXml, "utf8");

  if (process.platform !== "darwin" || opts.load === false) {
    return {
      plistPath,
      loaded: false,
      detail: process.platform !== "darwin" ? "plist written (non-macOS; skipped launchctl)" : "plist written (load skipped)",
    };
  }

  const domain = guiDomain();
  const target = `${domain}/${ORCH_LAUNCHD_LABEL}`;
  await execLaunchctl(["bootout", target]).catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, 200));
  const boot = await execLaunchctl(["bootstrap", domain, plistPath]);
  if (boot.exitCode !== 0) {
    return {
      plistPath,
      loaded: false,
      detail: `plist written, launchctl bootstrap failed: ${(boot.stderr || boot.stdout).trim()}`,
    };
  }
  return {
    plistPath,
    loaded: true,
    detail: `installed and loaded ${target}`,
  };
}

export async function uninstallLaunchdService(home = os.homedir()): Promise<{
  removed: boolean;
  detail: string;
}> {
  const plistPath = launchdPlistPath(home);
  if (process.platform === "darwin") {
    const target = `${guiDomain()}/${ORCH_LAUNCHD_LABEL}`;
    await execLaunchctl(["bootout", target]).catch(() => undefined);
  }
  let removed = false;
  try {
    await fs.unlink(plistPath);
    removed = true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
  return {
    removed,
    detail: removed ? `unloaded and removed ${plistPath}` : `service unloaded (${plistPath} was not present)`,
  };
}
