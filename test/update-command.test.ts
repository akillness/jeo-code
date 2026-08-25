import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { runUpdateCommandWith, compareVersions, installCandidates, type UpdateDeps } from "../src/commands/update";

let logged: string[] = [];
let errored: string[] = [];
let warned: string[] = [];

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

beforeEach(() => {
  logged = [];
  errored = [];
  warned = [];
  console.log = (...args: any[]) => {
    logged.push(args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" "));
  };
  console.error = (...args: any[]) => {
    errored.push(args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" "));
  };
  console.warn = (...args: any[]) => {
    warned.push(args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" "));
  };
  process.exitCode = 0;
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  console.warn = originalWarn;
  process.exitCode = 0;
});

test("compareVersions - edge cases", () => {
  expect(compareVersions("1.0.10", "1.0.9")).toBe(1);
  expect(compareVersions("1.0.9", "1.0.10")).toBe(-1);
  expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  expect(compareVersions("1.0", "1.0.0")).toBe(0);
  expect(compareVersions("1.0.0-alpha", "1.0.0")).toBe(-1);
  expect(compareVersions("1.0.0", "1.0.0-alpha")).toBe(1);
  expect(compareVersions("1.0.0-beta", "1.0.0-alpha")).toBe(1);
  expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
  expect(compareVersions("1.0.0-alpha+meta", "1.0.0-alpha+other")).toBe(0);
  expect(compareVersions("1.0.0+meta", "1.0.0")).toBe(0);
});

test("update - up-to-date path", async () => {
  const deps: UpdateDeps = {
    fetchJson: async () => ({ version: "0.1.0" }),
    localVersion: () => "0.1.0",
    install: async () => ({ success: true })
  };

  await runUpdateCommandWith([], deps);

  expect(logged.some(line => line.includes("already up-to-date"))).toBe(true);
  expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
});

test("update - bare command INSTALLS when newer (default action)", async () => {
  let installedWith: string | undefined = "UNCALLED";
  const deps: UpdateDeps = {
    fetchJson: async () => ({ version: "0.2.0" }),
    localVersion: () => "0.1.0",
    install: async (version?: string) => { installedWith = version; return { success: true }; },
    showWhatsNew: () => {},
  };

  await runUpdateCommandWith([], deps);

  // Bare `jeo update` now performs the install (passing the resolved latest version),
  // instead of merely printing a manual `bun install` hint.
  expect(installedWith).toBe("0.2.0");
  expect(logged.some(line => line.includes("Successfully installed jeo-code@0.2.0"))).toBe(true);
  expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
});

test("update - --check only checks and suggests 'jeo update' (no install)", async () => {
  let installed = false;
  const deps: UpdateDeps = {
    fetchJson: async () => ({ version: "0.2.0" }),
    localVersion: () => "0.1.0",
    install: async () => { installed = true; return { success: true }; },
  };

  await runUpdateCommandWith(["--check"], deps);

  expect(installed).toBe(false);
  expect(logged.some(line => line.includes("Newer version available: 0.2.0"))).toBe(true);
  expect(logged.some(line => line.includes("Run 'jeo update' to install"))).toBe(true);
  expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
});

test("update - 404 friendly", async () => {
  const deps: UpdateDeps = {
    fetchJson: async () => {
      const err = new Error("Not Found");
      (err as any).status = 404;
      throw err;
    },
    localVersion: () => "0.1.0",
    install: async () => ({ success: true })
  };

  await runUpdateCommandWith([], deps);

  expect(logged.some(line => line.includes("Package not found on registry: jeo-code"))).toBe(true);
  expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
});

test("update - network error warns exit 0", async () => {
  const deps: UpdateDeps = {
    fetchJson: async () => {
      throw new Error("fetch failed");
    },
    localVersion: () => "0.1.0",
    install: async () => ({ success: true })
  };

  await runUpdateCommandWith([], deps);

  expect(warned.some(line => line.includes("Warning: Network failure: fetch failed"))).toBe(true);
  expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
});

test("update - network error with --strict exitCode 1", async () => {
  const deps: UpdateDeps = {
    fetchJson: async () => {
      throw new Error("fetch failed");
    },
    localVersion: () => "0.1.0",
    install: async () => ({ success: true })
  };

  await runUpdateCommandWith(["--strict"], deps);

  expect(errored.some(line => line.includes("Error: Network failure: fetch failed"))).toBe(true);
  expect(process.exitCode).toBe(1);
});

test("update - --install skips when already current", async () => {
  let installCalled = false;
  const deps: UpdateDeps = {
    fetchJson: async () => ({ version: "0.1.0" }),
    localVersion: () => "0.1.0",
    install: async () => {
      installCalled = true;
      return { success: true };
    }
  };

  await runUpdateCommandWith(["--install"], deps);

  expect(installCalled).toBe(false);
  expect(logged.some(line => line.includes("already up-to-date"))).toBe(true);
  expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
});

test("update - --install triggers when newer and succeeds", async () => {
  let installCalled = false;
  const deps: UpdateDeps = {
    fetchJson: async () => ({ version: "0.2.0" }),
    localVersion: () => "0.1.0",
    install: async () => {
      installCalled = true;
      return { success: true };
    }
  };

  await runUpdateCommandWith(["--install"], deps);

  expect(installCalled).toBe(true);
  expect(logged.some(line => line.includes("Successfully installed jeo-code@0.2.0"))).toBe(true);
  expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
});

test("update - --install triggers when newer and fails", async () => {
  let installCalled = false;
  const deps: UpdateDeps = {
    fetchJson: async () => ({ version: "0.2.0" }),
    localVersion: () => "0.1.0",
    install: async () => {
      installCalled = true;
      return { success: false };
    }
  };

  await runUpdateCommandWith(["--install"], deps);

  expect(installCalled).toBe(true);
  expect(errored.some(line => line.includes("Failed to install update"))).toBe(true);
  expect(process.exitCode).toBe(1);
});

// gajae-code 0.7.8 parity (#1280): a nonzero bun/npm exit is recoverable when the
// requested version actually landed — verified by the active runtime on PATH.
test("update - install reports failure but runtime verifies → recovered success", async () => {
  let whatsNewShown = false;
  const deps: UpdateDeps = {
    fetchJson: async () => ({ version: "0.2.0" }),
    localVersion: () => "0.1.0",
    install: async () => ({ success: false, stderr: "bun: tarball extraction error" }),
    activeVersion: () => "0.2.0", // the version actually landed despite the nonzero exit
    showWhatsNew: () => { whatsNewShown = true; },
  };

  await runUpdateCommandWith(["--install"], deps);

  expect(logged.some(line => line.includes("Successfully installed jeo-code@0.2.0"))).toBe(true);
  expect(errored.some(line => line.includes("Failed to install update"))).toBe(false);
  expect(whatsNewShown).toBe(true);
  expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
});

// The recovery must NOT fire when the runtime still reports the old version.
test("update - install fails and runtime still old → real failure (exit 1)", async () => {
  const deps: UpdateDeps = {
    fetchJson: async () => ({ version: "0.2.0" }),
    localVersion: () => "0.1.0",
    install: async () => ({ success: false }),
    activeVersion: () => "0.1.0", // still the old binary — genuine failure
  };

  await runUpdateCommandWith(["--install"], deps);

  expect(errored.some(line => line.includes("Failed to install update"))).toBe(true);
  expect(process.exitCode).toBe(1);
});

test("update - --json shape (up-to-date)", async () => {
  const deps: UpdateDeps = {
    fetchJson: async () => ({ version: "0.1.0" }),
    localVersion: () => "0.1.0",
    install: async () => ({ success: true })
  };

  await runUpdateCommandWith(["--json"], deps);

  expect(logged.length).toBe(1);
  const parsed = JSON.parse(logged[0]);
  expect(parsed).toEqual({
    current: "0.1.0",
    latest: "0.1.0",
    upToDate: true
  });
  expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
});

test("update - --json shape (newer available)", async () => {
  const deps: UpdateDeps = {
    fetchJson: async () => ({ version: "0.2.0" }),
    localVersion: () => "0.1.0",
    install: async () => ({ success: true })
  };

  await runUpdateCommandWith(["--json"], deps);

  expect(logged.length).toBe(1);
  const parsed = JSON.parse(logged[0]);
  expect(parsed).toEqual({
    current: "0.1.0",
    latest: "0.2.0",
    upToDate: false
  });
  expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
});

test("update - --json shape (--install)", async () => {
  const deps: UpdateDeps = {
    fetchJson: async () => ({ version: "0.2.0" }),
    localVersion: () => "0.1.0",
    install: async () => ({ success: true })
  };

  await runUpdateCommandWith(["--json", "--install"], deps);

  expect(logged.length).toBe(1);
  const parsed = JSON.parse(logged[0]);
  expect(parsed).toEqual({
    current: "0.1.0",
    latest: "0.2.0",
    upToDate: false,
    installed: true
  });
  expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
});

test("update - --json shape (404 friendly)", async () => {
  const deps: UpdateDeps = {
    fetchJson: async () => {
      const err = new Error("Not Found");
      (err as any).status = 404;
      throw err;
    },
    localVersion: () => "0.1.0",
    install: async () => ({ success: true })
  };

  await runUpdateCommandWith(["--json"], deps);

  expect(logged.length).toBe(1);
  const parsed = JSON.parse(logged[0]);
  expect(parsed).toEqual({
    current: "0.1.0",
    latest: null,
    upToDate: true,
    error: "Package not found on registry"
  });
  expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
});

test("update - --json shape (network failure)", async () => {
  const deps: UpdateDeps = {
    fetchJson: async () => {
      throw new Error("fetch failed");
    },
    localVersion: () => "0.1.0",
    install: async () => ({ success: true })
  };

  await runUpdateCommandWith(["--json"], deps);

  expect(logged.length).toBe(1);
  const parsed = JSON.parse(logged[0]);
  expect(parsed).toEqual({
    current: "0.1.0",
    latest: null,
    upToDate: false,
    error: "Network failure: fetch failed"
  });
  expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
});

test("update - --json shape (network failure --strict)", async () => {
  const deps: UpdateDeps = {
    fetchJson: async () => {
      throw new Error("fetch failed");
    },
    localVersion: () => "0.1.0",
    install: async () => ({ success: true })
  };

  await runUpdateCommandWith(["--json", "--strict"], deps);

  expect(logged.length).toBe(1);
  const parsed = JSON.parse(logged[0]);
  expect(parsed).toEqual({
    current: "0.1.0",
    latest: null,
    upToDate: false,
    error: "Network failure: fetch failed"
  });
  expect(process.exitCode).toBe(1);
});

test("update - unknown flag exitCode 1", async () => {
  const deps: UpdateDeps = {
    fetchJson: async () => ({ version: "0.1.0" }),
    localVersion: () => "0.1.0",
    install: async () => ({ success: true })
  };

  await runUpdateCommandWith(["--invalid-flag"], deps);

  expect(logged.some(line => line.includes("Unknown flag: --invalid-flag"))).toBe(true);
  expect(process.exitCode).toBe(1);
});

test("update - --help", async () => {
  const deps: UpdateDeps = {
    fetchJson: async () => ({ version: "0.1.0" }),
    localVersion: () => "0.1.0",
    install: async () => ({ success: true })
  };

  await runUpdateCommandWith(["--help"], deps);

  expect(logged.some(line => line.includes("Usage: jeo update"))).toBe(true);
  expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
});

// Post-install verification: a package manager's zero exit does not prove the user's
// `jeo` moved (npm's global prefix is often not the one PATH resolves). An install
// that leaves an OLDER binary in front is a FAILED update, not a success with a note —
// reporting it as success is what made "I ran jeo update and nothing changed" invisible.
test("update: a successful install that leaves an older jeo on PATH fails loudly", async () => {
  const deps: UpdateDeps = {
    localVersion: () => "0.5.13",
    fetchJson: async () => ({ version: "0.5.16" }),
    install: async () => ({ success: true }),
    activeVersion: () => "0.5.13", // PATH still points at the old binary
  };
  await runUpdateCommandWith([], deps);
  expect(logged.some(l => l.includes("Successfully installed"))).toBe(false);
  expect(errored.some(l => l.includes("still reports 0.5.13"))).toBe(true);
  expect(errored.some(l => l.includes("bun install -g jeo-code@0.5.16 --force"))).toBe(true);
  expect(errored.some(l => l.includes("jeo --version"))).toBe(true);
  expect(process.exitCode).toBe(1);
});

test("update --json surfaces the stale-active-binary failure as machine-readable output", async () => {
  const deps: UpdateDeps = {
    localVersion: () => "0.5.13",
    fetchJson: async () => ({ version: "0.5.16" }),
    install: async () => ({ success: true }),
    activeVersion: () => "0.5.13",
  };
  await runUpdateCommandWith(["--json", "--install"], deps);
  const payload = JSON.parse([...logged].reverse().find(l => l.trim().startsWith("{"))!);
  expect(payload.installed).toBe(false);
  expect(payload.activeVersion).toBe("0.5.13");
  expect(process.exitCode).toBe(1);
});

test("installCandidates retries bun with --force before falling back to npm", () => {
  // Right after a publish, bun can hold a stale registry manifest and fail with
  // `No version matching "<v>" found ... (but package exists)`; --force re-resolves.
  expect(installCandidates("jeo-code@1.2.3")).toEqual([
    ["bun", "install", "-g", "jeo-code@1.2.3"],
    ["bun", "install", "-g", "jeo-code@1.2.3", "--force"],
    ["npm", "install", "-g", "jeo-code@1.2.3"],
  ]);
});

test("update: no PATH warning when the active jeo matches the installed version", async () => {
  const deps: UpdateDeps = {
    localVersion: () => "0.5.13",
    fetchJson: async () => ({ version: "0.5.16" }),
    install: async () => ({ success: true }),
    activeVersion: () => "0.5.16",
  };
  await runUpdateCommandWith([], deps);
  expect(logged.some(l => l.includes("Successfully installed jeo-code@0.5.16"))).toBe(true);
  expect(warned.some(l => l.includes("still reports"))).toBe(false);
});

test("update - --version pins the exact registry version (skips /latest) and installs it", async () => {
  let installedWith: string | undefined = "UNCALLED";
  let requestedUrl = "";
  const deps: UpdateDeps = {
    fetchJson: async (url: string) => {
      requestedUrl = url;
      return { version: "0.9.4" };
    },
    localVersion: () => "0.9.3",
    install: async (version?: string) => { installedWith = version; return { success: true }; },
  };

  await runUpdateCommandWith(["--version", "0.9.4", "--install"], deps);

  expect(requestedUrl).toBe("https://registry.npmjs.org/jeo-code/0.9.4");
  expect(requestedUrl.includes("latest")).toBe(false);
  expect(installedWith).toBe("0.9.4");
  expect(logged.some(line => line.includes("Successfully installed jeo-code@0.9.4"))).toBe(true);
  expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
});

test("update - --version rolls back even when current is newer (exact-match pin, not 'don't downgrade')", async () => {
  let installedWith: string | undefined = "UNCALLED";
  const deps: UpdateDeps = {
    fetchJson: async () => ({ version: "0.9.4" }),
    localVersion: () => "0.9.5",
    install: async (version?: string) => { installedWith = version; return { success: true }; },
  };

  await runUpdateCommandWith(["--version", "0.9.4", "--install"], deps);

  expect(installedWith).toBe("0.9.4");
  expect(logged.some(line => line.includes("Successfully installed jeo-code@0.9.4"))).toBe(true);
});

test("update - --check --version reports pinned diff without installing", async () => {
  let installCalled = false;
  const deps: UpdateDeps = {
    fetchJson: async () => ({ version: "0.9.4" }),
    localVersion: () => "0.9.3",
    install: async () => { installCalled = true; return { success: true }; },
  };

  await runUpdateCommandWith(["--check", "--version", "0.9.4"], deps);

  expect(installCalled).toBe(false);
  expect(logged.some(line => line.includes("Pinned version 0.9.4 differs from current (0.9.3)"))).toBe(true);
  expect(logged.some(line => line.includes("Run 'jeo update --version 0.9.4' to install it"))).toBe(true);
  expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
});

test("update - --check --version already at pinned version reports up-to-date, no install", async () => {
  let installCalled = false;
  const deps: UpdateDeps = {
    fetchJson: async () => ({ version: "0.9.4" }),
    localVersion: () => "0.9.4",
    install: async () => { installCalled = true; return { success: true }; },
  };

  await runUpdateCommandWith(["--check", "--version", "0.9.4"], deps);

  expect(installCalled).toBe(false);
  expect(logged.some(line => line.includes("already at the pinned version (0.9.4)"))).toBe(true);
});

test("update - --version with missing value errors clearly and never installs", async () => {
  let installCalled = false;
  const deps: UpdateDeps = {
    fetchJson: async () => { throw new Error("fetchJson should not be called"); },
    localVersion: () => "0.9.3",
    install: async () => { installCalled = true; return { success: true }; },
  };

  await runUpdateCommandWith(["--version"], deps);

  expect(installCalled).toBe(false);
  expect(errored.some(line => line.includes("--version requires a semver value"))).toBe(true);
  expect(process.exitCode).toBe(1);
});

test("update - --version with invalid semver shape errors clearly and never installs", async () => {
  let installCalled = false;
  const deps: UpdateDeps = {
    fetchJson: async () => { throw new Error("fetchJson should not be called"); },
    localVersion: () => "0.9.3",
    install: async () => { installCalled = true; return { success: true }; },
  };

  await runUpdateCommandWith(["--version", "not-a-version", "--install"], deps);

  expect(installCalled).toBe(false);
  expect(errored.some(line => line.includes('"not-a-version" is not a valid semver'))).toBe(true);
  expect(process.exitCode).toBe(1);
});

test("update - --version --json invalid value emits JSON error shape, still no install", async () => {
  let installCalled = false;
  const deps: UpdateDeps = {
    fetchJson: async () => { throw new Error("fetchJson should not be called"); },
    localVersion: () => "0.9.3",
    install: async () => { installCalled = true; return { success: true }; },
  };

  await runUpdateCommandWith(["--version", "1.2", "--json", "--install"], deps);

  expect(installCalled).toBe(false);
  expect(logged.length).toBe(1);
  const parsed = JSON.parse(logged[0]);
  expect(parsed.current).toBe("0.9.3");
  expect(parsed.upToDate).toBe(false);
  expect(String(parsed.error)).toContain("not a valid semver");
  expect(process.exitCode).toBe(1);
});

test("update - --version pointing at an unpublished release 404s with a clear, always-nonzero error", async () => {
  const deps: UpdateDeps = {
    fetchJson: async () => {
      const err = new Error("Not Found");
      (err as any).status = 404;
      throw err;
    },
    localVersion: () => "0.9.3",
    install: async () => ({ success: true }),
  };

  await runUpdateCommandWith(["--version", "9.9.9", "--install"], deps);

  expect(logged.some(line => line.includes("Version 9.9.9 not found on registry: jeo-code"))).toBe(true);
  expect(process.exitCode).toBe(1);
});

test("update - unknown flag after --version's value is still caught", async () => {
  const deps: UpdateDeps = {
    fetchJson: async () => ({ version: "0.9.4" }),
    localVersion: () => "0.9.3",
    install: async () => ({ success: true }),
  };

  await runUpdateCommandWith(["--version", "0.9.4", "--bogus"], deps);

  expect(logged.some(line => line.includes("Unknown flag: --bogus"))).toBe(true);
  expect(process.exitCode).toBe(1);
});
