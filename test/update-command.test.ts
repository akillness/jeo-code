import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { runUpdateCommandWith, compareVersions, type UpdateDeps } from "../src/commands/update";

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
