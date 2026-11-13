import { existsSync } from "node:fs";
import pkg from "../../package.json";
import { messengerProfilesPath } from "../messenger/runtime";
import {
  checkLockCoverage,
  detectInstallOrigin,
  diffInstalled,
  formatChangeLine,
  formatRestoreCommands,
  formatUnchangedSummary,
  locateSharedGlobal,
  readManifestDeps,
  snapshotInstalled,
  type ExternalChange,
  type InstalledSnapshot,
  type InstallOrigin,
  type LocatedGlobal,
  type LockStatus,
} from "../util/shared-global";

/**
 * Compares two semver-ish version strings.
 * Choice: A version with a prerelease suffix is considered older than the same version without a prerelease suffix (e.g. 1.0.0 > 1.0.0-alpha).
 * If both versions have prerelease suffixes, they are compared lexicographically as a string tiebreak (e.g. 1.0.0-beta > 1.0.0-alpha).
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const cleanA = a.split("+")[0] || "";
  const cleanB = b.split("+")[0] || "";

  const [aBase = "", aPre] = cleanA.split("-");
  const [bBase = "", bPre] = cleanB.split("-");

  const aParts = aBase.split(".").map(x => parseInt(x, 10) || 0);
  const bParts = bBase.split(".").map(x => parseInt(x, 10) || 0);

  const maxLen = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < maxLen; i++) {
    const aVal = aParts[i] ?? 0;
    const bVal = bParts[i] ?? 0;
    if (aVal > bVal) return 1;
    if (aVal < bVal) return -1;
  }

  if (aPre === undefined && bPre !== undefined) return 1;
  if (aPre !== undefined && bPre === undefined) return -1;
  if (aPre === undefined && bPre === undefined) return 0;

  if (aPre > bPre) return 1;
  if (aPre < bPre) return -1;
  return 0;
}

/** Outcome of one self-install. `manual` carries the commands to run by hand when no automatic attempt worked. */
export interface InstallResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  manual?: string[];
}

export interface UpdateDeps {
  fetchJson: (url: string, options?: { signal?: AbortSignal }) => Promise<any>;
  localVersion: () => string;
  install: (version?: string) => Promise<InstallResult>;
  /** Display release notes after a successful self-update (best-effort, no-op in tests). */
  showWhatsNew?: () => void;
  /**
   * Re-pin registered messenger profiles to the freshly installed jeo and restart their services
   * (`jeo messenger update` of the NEW binary). Returns null when no profile is registered, else whether
   * every profile was refreshed. `quiet` keeps the child's output off stdout for `--json`. Optional in
   * tests; failures never fail the update.
   */
  refreshMessengers?: (quiet: boolean) => boolean | null;
  /** Version of the `jeo` actually on PATH, read after install to catch a silent no-op
   *  (installed but PATH still points at a different/older binary). Optional in tests. */
  activeVersion?: () => string | null;
  /**
   * Where the shared bun global lives, so an update can refuse before any installer could re-resolve packages
   * jeo does not own and can report any that moved. Optional: absent = no inspection (every existing test).
   */
  sharedGlobal?: { locate: () => LocatedGlobal };
}

/**
 * Ordered install attempts for `target` (`jeo-code@<version>`).
 *
 * `bun install -g` alone is not enough in practice: right after a publish bun can
 * still hold a stale registry manifest and fail with `No version matching "<v>"
 * found ... (but package exists)`. `--force` re-resolves against the registry and
 * is what actually recovers that state. npm is the last resort only for an active jeo that
 * lives under npm's global root (`origin` 'npm-global'): from a bun-global or unknown location
 * an npm install would create a stale second copy, so it is never attempted there. `origin`
 * undefined keeps the legacy three attempts. Pure so the policy is unit-testable without spawning.
 */
export function installCandidates(target: string, origin?: InstallOrigin): string[][] {
  const candidates = [
    ["bun", "install", "-g", target],
    // Cache-buster: bun's resolver held a stale manifest for a just-published version.
    ["bun", "install", "-g", target, "--force"],
  ];
  if (origin === undefined || origin === "npm-global") candidates.push(["npm", "install", "-g", target]);
  return candidates;
}

/** What to tell the user to run when every automatic attempt failed and npm was deliberately not tried. */
export function manualInstallLines(target: string, origin: InstallOrigin): string[] {
  if (origin === "npm-global") return [];
  return [
    `bun install -g ${target} --force`,
    origin === "bun-global"
      ? "(npm was not tried: the active jeo is under the bun global install)"
      : `(npm was not tried: the active jeo is not under the npm global root; if it came from npm run: npm install -g ${target})`,
  ];
}

/** Side effects `runInstall` needs, injected so the attempt policy is testable without spawning. */
export interface InstallIo {
  spawn: (cmd: string[]) => { success: boolean; exitCode?: number | null };
  activeVersion: () => string | null;
  origin: () => InstallOrigin;
}

function errorText(err: unknown): string {
  const message = err !== null && typeof err === "object" && "message" in err ? err.message : undefined;
  return message ? String(message) : String(err);
}

/**
 * Self-update the global install via the toolchain it was installed with. jeo ships as a
 * `#!/usr/bin/env bun` script so bun is the common case; npm is tried last, and only when the
 * active jeo lives under npm's global root (see installCandidates). The origin is resolved once,
 * before the first spawn.
 */
export function runInstall(version: string | undefined, io: InstallIo): InstallResult {
  const target = `jeo-code@${version ?? "latest"}`;
  const origin = io.origin();
  let lastErr = "";
  for (const cmd of installCandidates(target, origin)) {
    try {
      const proc = io.spawn(cmd);
      if (proc.success) {
        // A zero exit is NOT proof the user's `jeo` moved: npm's global prefix is
        // often a different directory than the bun prefix PATH actually resolves,
        // so an npm fallback can "succeed" while the active binary is untouched.
        // Only stop once the binary on PATH really reports the requested version —
        // unless the active version cannot be read at all (null). A null means
        // `jeo --version` could not even run (e.g. a Windows `.cmd`/`.exe` shim
        // the bare spawn cannot resolve); re-running the installer cannot fix an
        // unreadable binary, so the installer's zero exit is trusted. A positively
        // stale version (a real older string) is what retries and fails the update.
        const active = io.activeVersion();
        if (!version || active === null || active === version) return { success: true };
        lastErr = `${cmd[0]} reported success but the active 'jeo' is still ${active ?? "unknown"}`;
        continue;
      }
      lastErr = `${cmd[0]} exited with code ${proc.exitCode}`;
    } catch (err) {
      lastErr = `${cmd[0]} unavailable: ${errorText(err)}`;
    }
  }
  return { success: false, stderr: lastErr, manual: manualInstallLines(target, origin) };
}

/**
 * How to ask the `jeo` on PATH for its version. On Windows the bun-global bin
 * can be a `jeo.exe` stub or a `cmd` shim, which a bare `["jeo", ...]` spawn
 * often cannot resolve, so a `/c` form is tried as well. Pure so both shapes
 * are unit-testable without spawning.
 */
export function jeoVersionAttempts(platform: NodeJS.Platform): string[][] {
  const direct = ["jeo", "--version"];
  if (platform !== "win32") return [direct];
  return [direct, ["jeo.exe", "--version"], ["cmd", "/d", "/s", "/c", "jeo --version"]];
}

/** Version of the `jeo` binary PATH actually resolves, or null when unreadable. */
function readActiveVersion(): string | null {
  for (const argv of jeoVersionAttempts(process.platform)) {
    try {
      const proc = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
      if (!proc.success) continue;
      const out = new TextDecoder().decode(proc.stdout);
      const m = out.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
      if (m) return m[1];
    } catch {
      // Try the next spelling; unreadable is reported only when every one fails.
    }
  }
  return null;
}
export const defaultDeps: UpdateDeps = {
  fetchJson: async (url: string, options?: { signal?: AbortSignal }) => {
    const res = await fetch(url, options);
    if (res.status === 404) {
      const err = new Error("Package not found on registry");
      (err as any).status = 404;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`HTTP status ${res.status}`);
      (err as any).status = res.status;
      throw err;
    }
    return res.json();
  },
  localVersion: () => {
    return pkg.version;
  },
  sharedGlobal: { locate: locateSharedGlobal },
  install: async (version?: string) =>
    runInstall(version, {
      spawn: cmd => Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" }),
      activeVersion: readActiveVersion,
      origin: () => detectInstallOrigin().origin,
    }),
  // Version of the `jeo` actually on PATH — may differ from this process's bundled
  // version after a self-update (e.g. npm installed into a prefix PATH does not
  // resolve). Detects the silent "installed but PATH unchanged" no-op.
  activeVersion: readActiveVersion
  ,
  showWhatsNew: () => {
    try {
      // Spawn the freshly-installed binary so it reads the NEW bundled CHANGELOG.
      Bun.spawnSync(["jeo", "whats-new"], { stdout: "inherit", stderr: "inherit" });
    } catch {
      // Notes are a courtesy; a spawn failure must never fail the update.
    }
  },
  refreshMessengers: quiet => {
    // Only profiles registered by `jeo messenger setup` have runtimes to move; everyone else sees nothing.
    if (!existsSync(messengerProfilesPath())) return null;
    try {
      if (!quiet) console.log("Refreshing messenger runtimes...");
      // The NEW binary knows its own launcher format and version, so it performs the refresh.
      const proc = Bun.spawnSync(["jeo", "messenger", "update"], quiet ? { stdout: "ignore", stderr: "ignore" } : { stdout: "inherit", stderr: "inherit" });
      if (!proc.success && !quiet) console.error("Messenger runtimes were not all refreshed; run 'jeo messenger update' to retry.");
      return proc.success;
    } catch {
      if (!quiet) console.error("Messenger runtimes were not refreshed; run 'jeo messenger update' to retry.");
      return false;
    }
  }
};

export async function runUpdateCommand(args: string[] = []): Promise<void> {
  return runUpdateCommandWith(args, defaultDeps);
}

/** What the guard found in the shared bun global before the installer ran (the `preflight` JSON key). */
interface SharedPreflight {
  globalDir: string;
  externalCount: number;
  lockfile: LockStatus;
  uncovered: string[];
  allowedUnlocked: boolean;
}

interface SharedArmed {
  kind: "armed";
  dir: string;
  /** Manifest dependency names other than jeo-code, as they were before the install. */
  beforeNames: string[];
  /** Installed versions captured BEFORE the install; settle never re-reads them from disk. */
  before: InstalledSnapshot;
  /** Null when the manifest has no packages besides jeo-code (nothing to guard, nothing to report). */
  preflight: SharedPreflight | null;
}

type SharedArm = { kind: "off" } | SharedArmed;
type SharedBegin = SharedArm | { kind: "refused"; preflight: SharedPreflight; error: string; lines: string[] };

interface SharedSettled {
  dir: string;
  changes: ExternalChange[];
  /** `shared global unchanged: ...`, only when a shared global with external packages was inspected and nothing moved. */
  summary: string | null;
  preflight: SharedPreflight | null;
  driftError: string | null;
}

function skipShared(hasJson: boolean, reason: string): SharedBegin {
  if (!hasJson) console.log(`Shared bun global not inspected (${reason}); the isolation check is skipped.`);
  return { kind: "off" };
}

/**
 * Runs at the start of the install branch, before any installer. Refuses when the shared bun global lists
 * packages besides jeo-code and its bun.lock cannot pin them (bun would re-resolve and could move them);
 * otherwise captures the installed versions that settleShared compares against after the install.
 */
function beginShared(deps: UpdateDeps, opts: { hasJson: boolean; allowUnlocked: boolean }): SharedBegin {
  if (!deps.sharedGlobal) return { kind: "off" };
  const located = deps.sharedGlobal.locate();
  if (!located.ok) return skipShared(opts.hasJson, located.reason);
  const manifest = readManifestDeps(located.dir);
  if (!manifest.ok) return skipShared(opts.hasJson, "manifest-unreadable");
  const dir = located.dir;
  const external = manifest.deps.external;
  const before = snapshotInstalled(dir, external);
  if (external.length === 0) return { kind: "armed", dir, beforeNames: external, before, preflight: null };
  const lock = checkLockCoverage(dir, external);
  const unlocked = lock.status !== "ok";
  const preflight: SharedPreflight = {
    globalDir: dir,
    externalCount: external.length,
    lockfile: lock.status,
    uncovered: lock.uncovered,
    allowedUnlocked: unlocked && opts.allowUnlocked,
  };
  if (!unlocked) return { kind: "armed", dir, beforeNames: external, before, preflight };
  const names = lock.uncovered.join(", ");
  if (!opts.allowUnlocked) {
    const problem =
      lock.status === "missing"
        ? "is missing"
        : lock.status === "incomplete"
          ? `has no resolved entry for ${names}`
          : `could not be read${lock.detail ? ` (${lock.detail})` : ""}`;
    return {
      kind: "refused",
      preflight,
      error: `shared bun global lockfile ${lock.status} (${names}); refusing to run any installer, re-run with --allow-unlocked-global to override`,
      lines: [
        `[REFUSED] jeo update did not run: the shared bun global at ${dir} has packages besides jeo-code but its bun.lock ${problem}.`,
        `  bun would re-resolve every package in that directory and could move: ${names}`,
        "  Nothing was installed or changed.",
        `  Restore ${lock.path} (for example from a backup), or accept the re-resolution with: jeo update --allow-unlocked-global`,
        ...(lock.legacyBinaryLock ? ["  (a binary bun.lockb is not accepted)"] : []),
      ],
    };
  }
  if (!opts.hasJson) console.warn(`Warning: bun.lock ${lock.status} for: ${names}; --allow-unlocked-global lets bun re-resolve them, drift will be reported.`);
  return { kind: "armed", dir, beforeNames: external, before, preflight };
}

/**
 * Runs exactly once, right after the installer returned or threw. The before map is the one captured by
 * beginShared (re-reading it here would see post-install versions and could never show drift); only the
 * after map is read from disk.
 */
function settleShared(arm: SharedArm): SharedSettled {
  if (arm.kind === "off") return { dir: "", changes: [], summary: null, preflight: null, driftError: null };
  const manifest = readManifestDeps(arm.dir);
  const afterNames = manifest.ok ? manifest.deps.external : arm.beforeNames;
  const names = [...new Set([...arm.beforeNames, ...afterNames])];
  const before: InstalledSnapshot = Object.fromEntries(names.map(name => [name, Object.hasOwn(arm.before, name) ? arm.before[name] : null]));
  const after = snapshotInstalled(arm.dir, names, new Set(afterNames));
  const changes = diffInstalled(before, after);
  return {
    dir: arm.dir,
    changes,
    summary: changes.length === 0 && arm.preflight !== null ? formatUnchangedSummary(after) : null,
    preflight: arm.preflight,
    driftError: changes.length > 0 ? `shared bun global changed: ${changes.map(formatChangeLine).join("; ")}` : null,
  };
}

/** `externalChanges` and `preflight` JSON keys, present only when a shared global with external packages was inspected. */
function sharedJson(s: SharedSettled): { externalChanges?: ExternalChange[]; preflight?: SharedPreflight } {
  if (s.preflight === null && s.changes.length === 0) return {};
  return { externalChanges: s.changes, ...(s.preflight === null ? {} : { preflight: s.preflight }) };
}

/** The human drift report: what moved and the commands that would put it back. They are printed, never run. */
function printSharedDrift(s: SharedSettled, version: string | null, installed: boolean): void {
  console.error(
    installed
      ? `[FAILED] jeo-code@${version} was installed, but the shared bun global at ${s.dir} changed other packages:`
      : `[FAILED] the install of jeo-code@${version} did not finish cleanly, and the shared bun global at ${s.dir} changed other packages:`,
  );
  for (const change of s.changes) console.error(`  ${formatChangeLine(change)}`);
  console.error("jeo does not repair these. To put them back run:");
  for (const command of formatRestoreCommands(s.changes)) console.error(`  ${command}`);
  if (installed) console.error("Messenger runtimes were not refreshed; run 'jeo messenger update' after restoring.");
}

export async function runUpdateCommandWith(args: string[], deps: UpdateDeps): Promise<void> {
  const isHelp = args.includes("--help") || args.includes("-h");
  const hasInstall = args.includes("--install");
  const hasCheck = args.includes("--check");
  const hasJson = args.includes("--json");
  const hasStrict = args.includes("--strict");
  const allowUnlocked = args.includes("--allow-unlocked-global");

  const KNOWN_FLAGS = new Set(["--check", "--install", "--json", "--strict", "--allow-unlocked-global", "--version", "-h", "--help"]);
  // A semver-ish shape: MAJOR.MINOR.PATCH with optional -prerelease and/or +build metadata,
  // matching what the npm registry actually publishes (and what activeVersion() parses back out).
  const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

  if (isHelp) {
    printUsage();
    return;
  }

  // `--version <semver>` pins the exact npm release instead of always resolving `/latest`
  // (the recurrence-prevention escape hatch: pin a known-good release, or roll back off a
  // bad one). It consumes the following arg as its value, so unknown-flag scanning below
  // must skip that value instead of flagging it.
  const versionFlagIdx = args.indexOf("--version");
  let pinnedVersion: string | undefined;
  let pinnedVersionError: string | null = null;
  if (versionFlagIdx !== -1) {
    const value = args[versionFlagIdx + 1];
    if (value === undefined || value.startsWith("--")) {
      pinnedVersionError = "--version requires a semver value, e.g. --version 1.2.3";
    } else if (!SEMVER_RE.test(value)) {
      pinnedVersionError = `--version value "${value}" is not a valid semver (expected e.g. 1.2.3)`;
    } else {
      pinnedVersion = value;
    }
  }

  // Check for unknown flags (skipping --version's consumed value, valid or not — it was
  // already validated above, not a flag to re-check here).
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--version") {
      i++;
      continue;
    }
    if (!KNOWN_FLAGS.has(arg)) {
      console.log(`Unknown flag: ${arg}`);
      printUsage();
      process.exitCode = 1;
      return;
    }
  }

  const current = deps.localVersion();

  if (pinnedVersionError) {
    if (hasJson) {
      console.log(JSON.stringify({
        current,
        latest: null,
        upToDate: false,
        error: pinnedVersionError
      }));
    } else {
      console.error(`Error: ${pinnedVersionError}`);
    }
    process.exitCode = 1;
    return;
  }

  let latest: string | null = null;
  let upToDate = false;

  const registryUrl = pinnedVersion
    ? `https://registry.npmjs.org/jeo-code/${encodeURIComponent(pinnedVersion)}`
    : "https://registry.npmjs.org/jeo-code/latest";

  try {
    const signal = AbortSignal.timeout(10000);
    const data = await deps.fetchJson(registryUrl, { signal });
    if (!data || typeof data.version !== "string") {
      throw new Error("Invalid response format from npm registry");
    }
    if (pinnedVersion && data.version !== pinnedVersion) {
      // Defensive: the registry must echo back exactly the pinned version we asked for —
      // never silently install something else because of a registry quirk.
      throw new Error(`Registry returned version ${data.version}, expected pinned ${pinnedVersion}`);
    }
    latest = data.version as string;
    const cmp = compareVersions(current, latest);
    // Choice: pinning is an exact-match target (rollback-capable) — only skip the install
    // when current already equals the pin. Latest-mode keeps its "don't downgrade" rule.
    upToDate = pinnedVersion ? cmp === 0 : cmp >= 0;
  } catch (err: any) {
    const is404 = err.status === 404 || String(err.message).includes("404") || String(err.message).toLowerCase().includes("not found");
    if (is404) {
      if (hasJson) {
        console.log(JSON.stringify({
          current,
          latest: null,
          upToDate: pinnedVersion ? false : true,
          error: pinnedVersion ? `Version ${pinnedVersion} not found on registry` : "Package not found on registry"
        }));
      } else {
        console.log(pinnedVersion ? `Version ${pinnedVersion} not found on registry: jeo-code` : "Package not found on registry: jeo-code");
      }
      // A pinned version that doesn't exist on the registry is a real, actionable error —
      // unlike the bare-latest 404 case, this always exits nonzero regardless of --strict.
      if (pinnedVersion) {
        process.exitCode = 1;
      }
      return;
    } else {
      // Network failure
      const errMsg = err.message || String(err);
      const contextMsg = pinnedVersion
        ? `Network failure while resolving pinned version ${pinnedVersion}: ${errMsg}`
        : `Network failure: ${errMsg}`;
      if (hasJson) {
        console.log(JSON.stringify({
          current,
          latest: null,
          upToDate: false,
          error: contextMsg
        }));
      } else {
        if (hasStrict) {
          console.error(`Error: ${contextMsg}`);
        } else {
          console.warn(`Warning: ${contextMsg}`);
        }
      }
      if (hasStrict) {
        process.exitCode = 1;
      }
      return;
    }
  }

  // Default action is INSTALL (bare `jeo update` upgrades). `--check` forces a
  // check-only run; `--json` stays check-only too (programmatic status polling must
  // not trigger an install) unless `--install` is given explicitly.
  const shouldInstall = hasInstall || (!hasCheck && !hasJson);

  // We got the version successfully
  if (shouldInstall) {
    if (upToDate) {
      if (hasJson) {
        console.log(JSON.stringify({
          current,
          latest,
          upToDate: true,
          installed: false
        }));
      } else {
        console.log(pinnedVersion
          ? `jeo-code is already at the pinned version (${current}).`
          : `jeo-code is already up-to-date (${current}).`);
      }
    } else {
      const shared = beginShared(deps, { hasJson, allowUnlocked });
      if (shared.kind === "refused") {
        if (hasJson) {
          console.log(JSON.stringify({
            current,
            latest,
            upToDate: false,
            installed: false,
            error: shared.error,
            preflight: shared.preflight
          }));
        } else {
          for (const line of shared.lines) console.error(line);
        }
        process.exitCode = 1;
        return;
      }
      if (!hasJson) {
        console.log(pinnedVersion
          ? `Installing pinned version: ${current} -> ${latest}...`
          : `Installing update: ${current} -> ${latest}...`);
      }
      // Settled exactly once: right after the installer returns, or in the catch when it threw
      // (a throwing installer may have half-run). Messenger refresh never happens before this.
      let settled: SharedSettled | null = null;
      try {
        const result = await deps.install(latest ?? undefined);
        settled = settleShared(shared);
        const drift = settled.changes.length > 0;
        if (result.success) {
          // A package manager's zero exit does not prove the user's `jeo` moved: npm's
          // global prefix is frequently a different directory than the one PATH resolves,
          // so the install lands somewhere the user never runs. Verify the ACTIVE binary
          // and treat a still-stale one as a failed update (exit 1) rather than printing
          // a success line the machine contradicts.
          const active = deps.activeVersion?.();
          const stale = !!(active && latest && compareVersions(active, latest) < 0);
          if (hasJson) {
            const messengersRefreshed = stale || drift ? null : (deps.refreshMessengers?.(true) ?? null);
            console.log(JSON.stringify({
              current,
              latest,
              upToDate: false,
              installed: !stale,
              ...(messengersRefreshed === null ? {} : { messengersRefreshed }),
              ...(stale
                ? { activeVersion: active, error: "active jeo still reports an older version" }
                : drift ? { error: settled.driftError } : {}),
              ...sharedJson(settled),
            }));
            if (stale || drift) process.exitCode = 1;
          } else if (stale) {
            console.error(`[FAILED] Installed jeo-code@${latest}, but the active 'jeo' on PATH still reports ${active}.`);
            console.error(`The install landed in a prefix your PATH does not use. Fix it with one of:`);
            console.error(`  bun install -g jeo-code@${latest} --force`);
            console.error(`  npm install -g jeo-code@${latest}`);
            console.error(`Then confirm with: jeo --version`);
            if (drift) printSharedDrift(settled, latest, true);
            process.exitCode = 1;
          } else if (drift) {
            printSharedDrift(settled, latest, true);
            process.exitCode = 1;
          } else {
            console.log(`Successfully installed jeo-code@${latest}`);
            if (settled.summary) console.log(settled.summary);
            deps.refreshMessengers?.(false);
            deps.showWhatsNew?.();
          }
        } else {
          // A nonzero bun/npm exit is NOT always a
          // real failure — Bun tarball-extraction errors can exit nonzero AFTER the
          // requested version actually landed. Before reporting failure, verify the
          // active `jeo` on PATH: if it now reports >= latest, treat it as recovered.
          const recovered = deps.activeVersion?.();
          if (recovered && latest && compareVersions(recovered, latest) >= 0) {
            if (hasJson) {
              const messengersRefreshed = drift ? null : (deps.refreshMessengers?.(true) ?? null);
              console.log(JSON.stringify({
                current,
                latest,
                upToDate: false,
                installed: true,
                recovered: true,
                ...(messengersRefreshed === null ? {} : { messengersRefreshed }),
                ...(drift ? { error: settled.driftError } : {}),
                ...sharedJson(settled),
              }));
              if (drift) process.exitCode = 1;
            } else if (drift) {
              printSharedDrift(settled, latest, true);
              process.exitCode = 1;
            } else {
              console.log(`Successfully installed jeo-code@${latest} (package manager reported an error, but the runtime verified clean).`);
              if (settled.summary) console.log(settled.summary);
              deps.refreshMessengers?.(false);
              deps.showWhatsNew?.();
            }
          } else {
            if (hasJson) {
              console.log(JSON.stringify({
                current,
                latest,
                upToDate: false,
                installed: false,
                error: "Installation failed",
                ...sharedJson(settled),
              }));
            } else {
              console.error("Failed to install update.");
              if (result.manual && result.manual.length > 0) {
                console.error("Try manually:");
                for (const line of result.manual) console.error(`  ${line}`);
              }
              if (drift) printSharedDrift(settled, latest, false);
            }
            process.exitCode = 1;
          }
        }
      } catch (installErr) {
        settled ??= settleShared(shared);
        const installErrMsg = errorText(installErr);
        if (hasJson) {
          console.log(JSON.stringify({
            current,
            latest,
            upToDate: false,
            installed: false,
            error: `Installation error: ${installErrMsg}`,
            ...sharedJson(settled),
          }));
        } else {
          console.error(`Failed to install update: ${installErrMsg}`);
          if (settled.changes.length > 0) printSharedDrift(settled, latest, false);
        }
        process.exitCode = 1;
      }
    }
  } else {
    // Just checking
    if (upToDate) {
      if (hasJson) {
        console.log(JSON.stringify({
          current,
          latest,
          upToDate: true
        }));
      } else {
        console.log(pinnedVersion
          ? `jeo-code is already at the pinned version (${current}).`
          : `jeo-code is up-to-date (${current}).`);
      }
    } else {
      if (hasJson) {
        console.log(JSON.stringify({
          current,
          latest,
          upToDate: false
        }));
      } else {
        console.log(pinnedVersion
          ? `Pinned version ${latest} differs from current (${current}).`
          : `Newer version available: ${latest} (current: ${current}).`);
        console.log(pinnedVersion
          ? `Run 'jeo update --version ${latest}' to install it.`
          : "Run 'jeo update' to install it.");
      }
    }
  }
}

function printUsage() {
  console.log("Usage: jeo update [options]");
  console.log("");
  console.log("Check for and install updates for jeo-code.");
  console.log("");
  console.log("Options:");
  console.log("  (default)    Check and install if a newer version is available");
  console.log("  --check      Only check; do not install");
  console.log("  --install    Force install if newer (also used with --json)");
  console.log("  --version <semver>  Pin an exact npm release instead of resolving latest");
  console.log("                      (e.g. --version 1.2.3); combine with --install to apply it");
  console.log("  --json       Output result in JSON format");
  console.log("  --strict     Exit with code 1 on network/registry errors");
  console.log("  --allow-unlocked-global  Proceed even if the shared bun global bun.lock does not cover its other packages (drift is still reported)");
  console.log("  -h, --help   Show this help message");
}
