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
  install: () => Promise<{ success: boolean; stdout?: string; stderr?: string }>;
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
  install: async () => {
    const proc = Bun.spawnSync(["bun", "install", "-g", "jeo-code"], {
      stdout: "inherit",
      stderr: "inherit",
    });
    return { success: proc.success };
  }
};

export async function runUpdateCommand(args: string[] = []): Promise<void> {
  return runUpdateCommandWith(args, defaultDeps);
}

export async function runUpdateCommandWith(args: string[], deps: UpdateDeps): Promise<void> {
  const isHelp = args.includes("--help") || args.includes("-h");
  const hasInstall = args.includes("--install");
  const hasJson = args.includes("--json");
  const hasStrict = args.includes("--strict");

  const KNOWN_FLAGS = new Set(["--check", "--install", "--json", "--strict", "-h", "--help"]);

  if (isHelp) {
    printUsage();
    return;
  }

  // Check for unknown flags
  for (const arg of args) {
    if (!KNOWN_FLAGS.has(arg)) {
      console.log(`Unknown flag: ${arg}`);
      printUsage();
      process.exitCode = 1;
      return;
    }
  }

  const current = deps.localVersion();
  let latest: string | null = null;
  let upToDate = false;

  try {
    const signal = AbortSignal.timeout(10000);
    const data = await deps.fetchJson("https://registry.npmjs.org/jeo-code/latest", { signal });
    if (!data || typeof data.version !== "string") {
      throw new Error("Invalid response format from npm registry");
    }
    latest = data.version as string;
    const cmp = compareVersions(current, latest);
    upToDate = cmp >= 0;
  } catch (err: any) {
    const is404 = err.status === 404 || String(err.message).includes("404") || String(err.message).toLowerCase().includes("not found");
    if (is404) {
      if (hasJson) {
        console.log(JSON.stringify({
          current,
          latest: null,
          upToDate: true,
          error: "Package not found on registry"
        }));
      } else {
        console.log("Package not found on registry: jeo-code");
      }
      return;
    } else {
      // Network failure
      const errMsg = err.message || String(err);
      if (hasJson) {
        console.log(JSON.stringify({
          current,
          latest: null,
          upToDate: false,
          error: `Network failure: ${errMsg}`
        }));
      } else {
        if (hasStrict) {
          console.error(`Error: Network failure: ${errMsg}`);
        } else {
          console.warn(`Warning: Network failure: ${errMsg}`);
        }
      }
      if (hasStrict) {
        process.exitCode = 1;
      }
      return;
    }
  }

  // We got the version successfully
  if (hasInstall) {
    if (upToDate) {
      if (hasJson) {
        console.log(JSON.stringify({
          current,
          latest,
          upToDate: true,
          installed: false
        }));
      } else {
        console.log(`jeo-code is up-to-date (${current}). Skipping installation.`);
      }
    } else {
      if (!hasJson) {
        console.log(`Installing update: ${current} -> ${latest}...`);
      }
      try {
        const result = await deps.install();
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
        console.log(`jeo-code is up-to-date (${current}).`);
      }
    } else {
      if (hasJson) {
        console.log(JSON.stringify({
          current,
          latest,
          upToDate: false
        }));
      } else {
        console.log(`Newer version available: ${latest} (current: ${current}).`);
        console.log("Run 'bun install -g jeo-code' to upgrade.");
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
  console.log("  --check      Check for updates (default)");
  console.log("  --install    Check and install if newer");
  console.log("  --json       Output result in JSON format");
  console.log("  --strict     Exit with code 1 on network/registry errors");
  console.log("  -h, --help   Show this help message");
}
