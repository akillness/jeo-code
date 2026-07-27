import pkg from "../../package.json";

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

export interface UpdateDeps {
  fetchJson: (url: string, options?: { signal?: AbortSignal }) => Promise<any>;
  localVersion: () => string;
  install: (version?: string) => Promise<{ success: boolean; stdout?: string; stderr?: string }>;
  /** Display release notes after a successful self-update (best-effort, no-op in tests). */
  showWhatsNew?: () => void;
  /** Version of the `jeo` actually on PATH, read after install to catch a silent no-op
   *  (installed but PATH still points at a different/older binary). Optional in tests. */
  activeVersion?: () => string | null;
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
  install: async (version?: string) => {
    // Self-update the global install via the SAME toolchain it was installed with. jeo
    // ships as a `#!/usr/bin/env bun` script so bun is the common case, but npm-installed
    // globals exist too — try bun first, fall back to npm (and tolerate either missing).
    // `@<version>` (the resolved latest) forces the newest publish past a stale global cache.
    const target = `jeo-code@${version ?? "latest"}`;
    const managers: string[][] = [
      ["bun", "install", "-g", target],
      ["npm", "install", "-g", target],
    ];
    let lastErr = "";
    for (const cmd of managers) {
      try {
        const proc = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
        if (proc.success) return { success: true };
        lastErr = `${cmd[0]} exited with code ${proc.exitCode}`;
      } catch (err: any) {
        lastErr = `${cmd[0]} unavailable: ${err?.message ?? String(err)}`;
      }
    }
    return { success: false, stderr: lastErr };
  }
,
  activeVersion: () => {
    // Read the version of the `jeo` actually on PATH (may differ from this process's bundled
    // version after a self-update, e.g. when bun installed to ~/.bun/bin but PATH prefers an
    // npm global). Used to detect a silent "installed but PATH unchanged" no-op.
    try {
      const proc = Bun.spawnSync(["jeo", "--version"], { stdout: "pipe", stderr: "pipe" });
      if (!proc.success) return null;
      const out = new TextDecoder().decode(proc.stdout);
      const m = out.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }
  ,
  showWhatsNew: () => {
    try {
      // Spawn the freshly-installed binary so it reads the NEW bundled CHANGELOG.
      Bun.spawnSync(["jeo", "whats-new"], { stdout: "inherit", stderr: "inherit" });
    } catch {
      // Notes are a courtesy; a spawn failure must never fail the update.
    }
  }
};

export async function runUpdateCommand(args: string[] = []): Promise<void> {
  return runUpdateCommandWith(args, defaultDeps);
}

export async function runUpdateCommandWith(args: string[], deps: UpdateDeps): Promise<void> {
  const isHelp = args.includes("--help") || args.includes("-h");
  const hasInstall = args.includes("--install");
  const hasCheck = args.includes("--check");
  const hasJson = args.includes("--json");
  const hasStrict = args.includes("--strict");

  const KNOWN_FLAGS = new Set(["--check", "--install", "--json", "--strict", "--version", "-h", "--help"]);
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
      if (!hasJson) {
        console.log(pinnedVersion
          ? `Installing pinned version: ${current} -> ${latest}...`
          : `Installing update: ${current} -> ${latest}...`);
      }
      try {
        const result = await deps.install(latest ?? undefined);
        if (result.success) {
          if (hasJson) {
            console.log(JSON.stringify({
              current,
              latest,
              upToDate: false,
              installed: true
            }));
          } else {
            console.log(`Successfully installed jeo-code@${latest}`);
            // Verify the `jeo` on PATH actually picked up the new install — a bun-vs-npm or
            // PATH mismatch can leave an older binary in front, which looks like "update did
            // nothing". Surface that loudly with the manual fix instead of failing silently.
            const active = deps.activeVersion?.();
            if (active && latest && compareVersions(active, latest) < 0) {
              console.warn(`Warning: installed ${latest}, but the active 'jeo' on PATH still reports ${active}.`);
              console.warn(`Your PATH points at a different install. Fix it with one of:`);
              console.warn(`  npm install -g jeo-code@${latest}`);
              console.warn(`  bun install -g jeo-code@${latest}`);
            }
            deps.showWhatsNew?.();
          }
        } else {
          // gajae-code 0.7.8 parity (#1280): a nonzero bun/npm exit is NOT always a
          // real failure — Bun tarball-extraction errors can exit nonzero AFTER the
          // requested version actually landed. Before reporting failure, verify the
          // active `jeo` on PATH: if it now reports >= latest, treat it as recovered.
          const recovered = deps.activeVersion?.();
          if (recovered && latest && compareVersions(recovered, latest) >= 0) {
            if (hasJson) {
              console.log(JSON.stringify({
                current,
                latest,
                upToDate: false,
                installed: true,
                recovered: true
              }));
            } else {
              console.log(`Successfully installed jeo-code@${latest} (package manager reported an error, but the runtime verified clean).`);
              deps.showWhatsNew?.();
            }
          } else {
            if (hasJson) {
              console.log(JSON.stringify({
                current,
                latest,
                upToDate: false,
                installed: false,
                error: "Installation failed"
              }));
            } else {
              console.error("Failed to install update.");
            }
            process.exitCode = 1;
          }
        }
      } catch (installErr: any) {
        const installErrMsg = installErr.message || String(installErr);
        if (hasJson) {
          console.log(JSON.stringify({
            current,
            latest,
            upToDate: false,
            installed: false,
            error: `Installation error: ${installErrMsg}`
          }));
        } else {
          console.error(`Failed to install update: ${installErrMsg}`);
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
  console.log("  -h, --help   Show this help message");
}
