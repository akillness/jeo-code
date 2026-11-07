import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installCandidates, jeoVersionAttempts, manualInstallLines, runInstall, runUpdateCommandWith, type InstallIo, type InstallResult, type UpdateDeps } from "../src/commands/update";
import { detectInstallOrigin, locateSharedGlobal, type InstallOrigin, type LocatedGlobal } from "../src/util/shared-global";

// Every fixture lives under this root; the real ~/.bun, ~/.npmrc and installers are never touched.
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jeo-update-shared-global-test-")));
let counter = 0;
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function mk(label: string): string {
  const dir = path.join(ROOT, `${label}-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeText(file: string, text: string, mode?: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode !== undefined) fs.chmodSync(file, mode);
  return file;
}

function writeJson(file: string, value: unknown): string {
  return writeText(file, JSON.stringify(value, null, 2));
}

type LockMode = "none" | "full" | "corrupt" | "binary" | { omit: string[] };

/** bun.lock in the real shape: JSONC with trailing commas, a root workspace mirror, own-keyed `packages` tuples and a nested key. */
function lockText(manifest: Record<string, string>, installed: Record<string, string>, omit: readonly string[]): string {
  const names = Object.keys(manifest);
  const covered = names.filter(name => !omit.includes(name));
  const workspace = names.map(name => `        ${JSON.stringify(name)}: ${JSON.stringify(manifest[name])},`).join("\n");
  const entries = covered
    .map(name => `    ${JSON.stringify(name)}: [${JSON.stringify(`${name}@${installed[name] ?? "1.0.0"}`)}, "", { "dependencies": {} }, "sha512-ab/cd+ef=="],`)
    .join("\n");
  return `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "dependencies": {
${workspace}
      },
    },
  },
  "packages": {
${entries}

    "jeo-code/zod": ["zod@4.0.0", "", {}, "sha512-zz/zz=="],
  },
}
`;
}

function setVersion(dir: string, name: string, version: string): void {
  writeJson(path.join(dir, "node_modules", name, "package.json"), { name, version });
}

function makeGlobal(dir: string, o: { manifest: Record<string, string>; lock: LockMode; installed: Record<string, string> }): string {
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, "package.json"), { dependencies: o.manifest });
  if (o.lock === "full") writeText(path.join(dir, "bun.lock"), lockText(o.manifest, o.installed, []));
  else if (o.lock === "corrupt") writeText(path.join(dir, "bun.lock"), "{ not json");
  else if (o.lock === "binary") writeText(path.join(dir, "bun.lockb"), "binary lock");
  else if (typeof o.lock === "object") writeText(path.join(dir, "bun.lock"), lockText(o.manifest, o.installed, o.lock.omit));
  for (const [name, version] of Object.entries(o.installed)) setVersion(dir, name, version);
  return dir;
}

/** sha256 over relative paths, file bytes and symlink targets: any create, change or delete changes it. */
function hashTree(dir: string): string {
  const hash = createHash("sha256");
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const rel = path.relative(dir, full);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) hash.update(`L:${rel}:${fs.readlinkSync(full)}\n`);
      else if (stat.isDirectory()) {
        hash.update(`D:${rel}\n`);
        walk(full);
      } else {
        hash.update(`F:${rel}:`);
        hash.update(fs.readFileSync(full));
        hash.update("\n");
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}

const MANIFEST = { "jeo-code": "0.1.0", "jeopi-cli": "16.6.18", "oh-my-agent": "^10.23.2" };
const INSTALLED = { "jeo-code": "0.1.0", "jeopi-cli": "16.6.18", "oh-my-agent": "10.23.2" };
const SUMMARY = "shared global unchanged: 2 packages (jeopi-cli 16.6.18, oh-my-agent 10.23.2)";

function fixture(label: string, lock: LockMode, manifest: Record<string, string> = MANIFEST, installed: Record<string, string> = INSTALLED): string {
  return makeGlobal(mk(label), { manifest, lock, installed });
}

// Console capture in the style of test/update-command.test.ts, plus one timeline that also records the deps' calls.
let logged: string[] = [];
let errored: string[] = [];
let warned: string[] = [];
let timeline: string[] = [];
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const render = (args: unknown[]): string => args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");

beforeEach(() => {
  logged = [];
  errored = [];
  warned = [];
  timeline = [];
  console.log = (...args: unknown[]) => {
    logged.push(render(args));
    timeline.push(`log:${render(args)}`);
  };
  console.error = (...args: unknown[]) => {
    errored.push(render(args));
    timeline.push(`error:${render(args)}`);
  };
  console.warn = (...args: unknown[]) => {
    warned.push(render(args));
    timeline.push(`warn:${render(args)}`);
  };
  process.exitCode = 0;
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  console.warn = originalWarn;
  process.exitCode = 0;
});

interface Counts {
  installs: number;
  locates: number;
  refreshes: boolean[];
  whatsNew: number;
}

interface SetupOptions {
  install?: () => InstallResult | Promise<InstallResult>;
  current?: string;
  latest?: string;
  /** What `activeVersion()` reports; defaults to `latest`, null = unreadable. */
  active?: string | null;
  refresh?: boolean | null;
  onRefresh?: () => void;
  fetchJson?: UpdateDeps["fetchJson"];
}

/** UpdateDeps with a counting installer, recorders for refresh and whats-new, and an optional sharedGlobal locator. */
function setup(locate: (() => LocatedGlobal) | null, o: SetupOptions = {}): { deps: UpdateDeps; counts: Counts } {
  const counts: Counts = { installs: 0, locates: 0, refreshes: [], whatsNew: 0 };
  const latest = o.latest ?? "0.2.0";
  const deps: UpdateDeps = {
    fetchJson: o.fetchJson ?? (async url => ({ version: url.endsWith("/latest") ? latest : decodeURIComponent(url.slice(url.lastIndexOf("/") + 1)) })),
    localVersion: () => o.current ?? "0.1.0",
    install: async () => {
      counts.installs++;
      timeline.push("install");
      return o.install ? o.install() : { success: true };
    },
    activeVersion: () => (o.active === undefined ? latest : o.active),
    refreshMessengers: quiet => {
      counts.refreshes.push(quiet);
      timeline.push(`refresh:${quiet}`);
      o.onRefresh?.();
      return o.refresh === undefined ? true : o.refresh;
    },
    showWhatsNew: () => {
      counts.whatsNew++;
      timeline.push("whats-new");
    },
  };
  if (locate) {
    deps.sharedGlobal = {
      locate: () => {
        counts.locates++;
        return locate();
      },
    };
  }
  return { deps, counts };
}

const at = (dir: string) => (): LocatedGlobal => ({ ok: true, dir });
const jeoOnly = (dir: string) => (): InstallResult => {
  setVersion(dir, "jeo-code", "0.2.0");
  return { success: true };
};
/** Moves jeo-code (as a normal update does) AND one other package (the drift the guard must catch). */
const drifting = (dir: string, installer: () => InstallResult = () => ({ success: true })) => (): InstallResult => {
  setVersion(dir, "jeo-code", "0.2.0");
  setVersion(dir, "jeopi-cli", "16.6.19");
  return installer();
};

function onlyJson(): Record<string, unknown> {
  expect(logged).toHaveLength(1);
  return JSON.parse(logged[0]!);
}

const allOutput = (): string => [...logged, ...errored, ...warned].join("\n");

async function capture(args: string[], deps: UpdateDeps): Promise<{ logged: string[]; errored: string[]; warned: string[]; exitCode: number }> {
  logged = [];
  errored = [];
  warned = [];
  process.exitCode = 0;
  await runUpdateCommandWith(args, deps);
  return { logged: [...logged], errored: [...errored], warned: [...warned], exitCode: Number(process.exitCode ?? 0) };
}

describe("preflight refusal (AC-1, AC-2)", () => {
  test("AC-1: missing bun.lock refuses before any installer", async () => {
    const dir = fixture("ac1", "none");
    const before = hashTree(dir);
    const human = setup(at(dir), { install: jeoOnly(dir) });
    await runUpdateCommandWith(["--install"], human.deps);
    expect(human.counts.installs).toBe(0);
    expect(process.exitCode).toBe(1);
    const text = allOutput();
    for (const needle of ["jeopi-cli", "oh-my-agent", "--allow-unlocked-global", "[REFUSED]", "bun.lock is missing", "Nothing was installed or changed."]) expect(text).toContain(needle);
    expect(logged.some(line => line.startsWith("Installing"))).toBe(false);
    expect(human.counts.refreshes).toEqual([]);
    expect(human.counts.whatsNew).toBe(0);
    expect(hashTree(dir)).toBe(before);

    logged = [];
    errored = [];
    process.exitCode = 0;
    const json = setup(at(dir), { install: jeoOnly(dir) });
    await runUpdateCommandWith(["--json", "--install"], json.deps);
    expect(json.counts.installs).toBe(0);
    expect(process.exitCode).toBe(1);
    const payload = onlyJson();
    expect(Object.keys(payload)).toEqual(["current", "latest", "upToDate", "installed", "error", "preflight"]);
    expect(payload.installed).toBe(false);
    expect(payload.upToDate).toBe(false);
    expect(String(payload.error)).toContain("lockfile");
    expect(String(payload.error)).toContain("--allow-unlocked-global");
    expect(payload.preflight).toEqual({ globalDir: dir, externalCount: 2, lockfile: "missing", uncovered: ["jeopi-cli", "oh-my-agent"], allowedUnlocked: false });
    expect(errored).toEqual([]);
    expect(hashTree(dir)).toBe(before);
  });

  test("AC-2: incomplete bun.lock refuses", async () => {
    const dir = fixture("ac2", { omit: ["oh-my-agent"] });
    const before = hashTree(dir);
    const human = setup(at(dir), { install: jeoOnly(dir) });
    await runUpdateCommandWith(["--install"], human.deps);
    expect(human.counts.installs).toBe(0);
    expect(process.exitCode).toBe(1);
    expect(errored.join("\n")).toContain("its bun.lock has no resolved entry for oh-my-agent.");
    expect(errored.join("\n")).toContain("could move: oh-my-agent");
    expect(errored.join("\n")).not.toContain("jeopi-cli");
    expect(hashTree(dir)).toBe(before);

    logged = [];
    const json = setup(at(dir), { install: jeoOnly(dir) });
    await runUpdateCommandWith(["--json", "--install"], json.deps);
    expect(json.counts.installs).toBe(0);
    const payload = onlyJson();
    expect(payload.installed).toBe(false);
    expect(String(payload.error)).toContain("lockfile incomplete (oh-my-agent)");
    expect(payload.preflight).toMatchObject({ lockfile: "incomplete", uncovered: ["oh-my-agent"], allowedUnlocked: false });
    expect(hashTree(dir)).toBe(before);
  });

  test("an unreadable bun.lock refuses and a binary bun.lockb is called out", async () => {
    const corrupt = fixture("corrupt", "corrupt");
    const run = setup(at(corrupt));
    await runUpdateCommandWith(["--install"], run.deps);
    expect(run.counts.installs).toBe(0);
    expect(process.exitCode).toBe(1);
    expect(errored.join("\n")).toContain("could not be read");
    expect(errored.join("\n")).not.toContain("bun.lockb");

    errored = [];
    process.exitCode = 0;
    const binary = fixture("binary", "binary");
    const second = setup(at(binary));
    await runUpdateCommandWith(["--install"], second.deps);
    expect(second.counts.installs).toBe(0);
    expect(errored.join("\n")).toContain("bun.lock is missing");
    expect(errored.join("\n")).toContain("(a binary bun.lockb is not accepted)");

    logged = [];
    process.exitCode = 0;
    const json = setup(at(corrupt));
    await runUpdateCommandWith(["--json", "--install"], json.deps);
    expect(onlyJson().preflight).toMatchObject({ lockfile: "unreadable", uncovered: ["jeopi-cli", "oh-my-agent"] });
  });
});

describe("preflight pass (AC-3)", () => {
  test("AC-3: full lock proceeds", async () => {
    const dir = fixture("ac3-full", "full");
    const run = setup(at(dir), { install: jeoOnly(dir) });
    await runUpdateCommandWith(["--install"], run.deps);
    expect(run.counts.installs).toBe(1);
    expect(process.exitCode).toBe(0);
    expect(logged).toContain("Successfully installed jeo-code@0.2.0");
    expect(errored).toEqual([]);
    expect(warned).toEqual([]);
  });

  test("AC-3: jeo-code-only manifest without a lock is never refused", async () => {
    const dir = fixture("ac3-self", "none", { "jeo-code": "0.1.0" }, { "jeo-code": "0.1.0" });
    const human = setup(at(dir), { install: jeoOnly(dir) });
    await runUpdateCommandWith(["--install"], human.deps);
    expect(human.counts.installs).toBe(1);
    expect(process.exitCode).toBe(0);
    // Byte-identical to a run with no shared global configured: nothing new is printed.
    expect(logged).toEqual(["Installing update: 0.1.0 -> 0.2.0...", "Successfully installed jeo-code@0.2.0"]);
    expect(errored).toEqual([]);
    expect(warned).toEqual([]);

    logged = [];
    const json = setup(at(dir), { install: jeoOnly(dir) });
    await runUpdateCommandWith(["--json", "--install"], json.deps);
    expect(json.counts.installs).toBe(1);
    const payload = onlyJson();
    expect(payload).toEqual({ current: "0.1.0", latest: "0.2.0", upToDate: false, installed: true, messengersRefreshed: true });
    expect(payload).not.toHaveProperty("preflight");
    expect(payload).not.toHaveProperty("externalChanges");
  });

  test("a manifest with no dependencies at all is not inspected further", async () => {
    const dir = mk("no-deps");
    writeJson(path.join(dir, "package.json"), { name: "global" });
    const run = setup(at(dir));
    await runUpdateCommandWith(["--install"], run.deps);
    expect(run.counts.installs).toBe(1);
    expect(logged).toEqual(["Installing update: 0.1.0 -> 0.2.0...", "Successfully installed jeo-code@0.2.0"]);
  });

  test("AC-3: --allow-unlocked-global skips only the refusal", async () => {
    const dir = fixture("ac3-flag", "none");
    const human = setup(at(dir), { install: jeoOnly(dir) });
    await runUpdateCommandWith(["--install", "--allow-unlocked-global"], human.deps);
    expect(human.counts.installs).toBe(1);
    expect(process.exitCode).toBe(0);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("bun.lock missing for: jeopi-cli, oh-my-agent");
    expect(warned[0]).toContain("--allow-unlocked-global");
    // The postflight still ran and found nothing moved.
    expect(logged).toContain(SUMMARY);
    expect(errored).toEqual([]);

    logged = [];
    const json = setup(at(dir), { install: jeoOnly(dir) });
    await runUpdateCommandWith(["--json", "--install", "--allow-unlocked-global"], json.deps);
    expect(json.counts.installs).toBe(1);
    const payload = onlyJson();
    expect(payload.preflight).toEqual({ globalDir: dir, externalCount: 2, lockfile: "missing", uncovered: ["jeopi-cli", "oh-my-agent"], allowedUnlocked: true });
    expect(payload.externalChanges).toEqual([]);
  });

  test("--allow-unlocked-global still runs the postflight and reports drift", async () => {
    const dir = fixture("ac3-flag-drift", "none");
    const run = setup(at(dir), { install: drifting(dir) });
    await runUpdateCommandWith(["--install", "--allow-unlocked-global"], run.deps);
    expect(run.counts.installs).toBe(1);
    expect(process.exitCode).toBe(1);
    expect(errored.join("\n")).toContain("jeopi-cli 16.6.18 -> 16.6.19");
    expect(logged.some(line => line.startsWith("Successfully installed"))).toBe(false);
  });
});

describe("postflight drift (AC-4)", () => {
  test("AC-4: drift in another package fails", async () => {
    const dir = fixture("ac4", "full");
    const human = setup(at(dir), { install: drifting(dir) });
    await runUpdateCommandWith(["--install"], human.deps);
    expect(process.exitCode).toBe(1);
    const errors = errored.join("\n");
    expect(errors).toContain("[FAILED] jeo-code@0.2.0 was installed, but the shared bun global at ");
    expect(errors).toContain("  jeopi-cli 16.6.18 -> 16.6.19");
    expect(errors).toContain("jeo does not repair these. To put them back run:");
    expect(errors).toContain("  bun install -g jeopi-cli@16.6.18");
    expect(errors).toContain("Messenger runtimes were not refreshed; run 'jeo messenger update' after restoring.");
    expect(allOutput()).not.toContain("Successfully installed");
    expect(logged.some(line => line.startsWith("shared global unchanged"))).toBe(false);
    expect(human.counts.refreshes).toEqual([]);
    expect(human.counts.whatsNew).toBe(0);

    logged = [];
    process.exitCode = 0;
    const json = setup(at(dir), { install: drifting(dir) });
    // The first run left 16.6.19 on disk, so re-seed the fixture the way a fresh machine would look.
    setVersion(dir, "jeopi-cli", "16.6.18");
    setVersion(dir, "jeo-code", "0.1.0");
    await runUpdateCommandWith(["--json", "--install"], json.deps);
    expect(process.exitCode).toBe(1);
    const payload = onlyJson();
    expect(Object.keys(payload)).toEqual(["current", "latest", "upToDate", "installed", "error", "externalChanges", "preflight"]);
    expect(payload.installed).toBe(true);
    expect(payload.error).toBe("shared bun global changed: jeopi-cli 16.6.18 -> 16.6.19");
    expect(payload.externalChanges).toEqual([{ name: "jeopi-cli", from: "16.6.18", to: "16.6.19" }]);
    expect(payload).not.toHaveProperty("messengersRefreshed");
    expect(json.counts.refreshes).toEqual([]);
  });

  test("postflight drift: the before map is the pre-install map", async () => {
    const dir = fixture("ac4-before", "full");
    const seenByInstaller: (string | null)[] = [];
    const jeopiManifest = path.join(dir, "node_modules", "jeopi-cli", "package.json");
    const run = setup(at(dir), {
      install: () => {
        // The installer observes the pre-install state, then rewrites it, exactly like a package manager would.
        seenByInstaller.push(JSON.parse(fs.readFileSync(jeopiManifest, "utf8")).version);
        setVersion(dir, "jeo-code", "0.2.0");
        setVersion(dir, "jeopi-cli", "16.6.19");
        return { success: true };
      },
    });
    await runUpdateCommandWith(["--install"], run.deps);
    // A settle that re-read the disk for `before` would see 16.6.19 on both sides and report nothing.
    expect(seenByInstaller).toEqual(["16.6.18"]);
    expect(JSON.parse(fs.readFileSync(jeopiManifest, "utf8")).version).toBe("16.6.19");
    expect(process.exitCode).toBe(1);
    expect(errored).toContain("  jeopi-cli 16.6.18 -> 16.6.19");
    expect(errored).toContain("  bun install -g jeopi-cli@16.6.18");
  });

  test("AC-4: a jeo-code change is not drift", async () => {
    const dir = fixture("ac4-self", "full");
    const run = setup(at(dir), { install: jeoOnly(dir) });
    await runUpdateCommandWith(["--json", "--install"], run.deps);
    expect(process.exitCode).toBe(0);
    const payload = onlyJson();
    expect(payload.externalChanges).toEqual([]);
    expect(payload).not.toHaveProperty("error");
    expect(JSON.stringify(payload)).not.toContain("0.1.0 ->");
  });

  test("AC-4: a removed dependency is reported", async () => {
    const dir = fixture("ac4-removed", "full");
    const run = setup(at(dir), {
      install: () => {
        setVersion(dir, "jeo-code", "0.2.0");
        fs.rmSync(path.join(dir, "node_modules", "oh-my-agent"), { recursive: true });
        return { success: true };
      },
    });
    await runUpdateCommandWith(["--install"], run.deps);
    expect(process.exitCode).toBe(1);
    expect(errored).toContain("  oh-my-agent 10.23.2 -> (removed)");
    expect(errored).toContain("  bun install -g oh-my-agent@10.23.2");
  });

  test("AC-4: a dependency dropped from the manifest is reported as removed", async () => {
    const dir = fixture("ac4-dropped", "full");
    const run = setup(at(dir), {
      install: () => {
        setVersion(dir, "jeo-code", "0.2.0");
        writeJson(path.join(dir, "package.json"), { dependencies: { "jeo-code": "0.2.0", "jeopi-cli": "16.6.18" } });
        // The package manager left the directory behind; the manifest no longer lists it.
        return { success: true };
      },
    });
    await runUpdateCommandWith(["--json", "--install"], run.deps);
    expect(process.exitCode).toBe(1);
    expect(onlyJson().externalChanges).toEqual([{ name: "oh-my-agent", from: "10.23.2", to: null }]);
  });

  test("AC-4: an added dependency is reported", async () => {
    const dir = fixture("ac4-added", "full");
    const run = setup(at(dir), {
      install: () => {
        setVersion(dir, "jeo-code", "0.2.0");
        writeJson(path.join(dir, "package.json"), { dependencies: { ...MANIFEST, "new-tool": "^1.0.0" } });
        setVersion(dir, "new-tool", "1.0.0");
        return { success: true };
      },
    });
    await runUpdateCommandWith(["--install"], run.deps);
    expect(process.exitCode).toBe(1);
    expect(errored).toContain("  new-tool (not installed) -> 1.0.0");
    expect(errored).toContain("  bun remove -g new-tool");
  });

  test("a jeo-code-only manifest that gains a dependency during install is reported without a preflight key", async () => {
    const dir = fixture("ac4-self-added", "none", { "jeo-code": "0.1.0" }, { "jeo-code": "0.1.0" });
    const run = setup(at(dir), {
      install: () => {
        setVersion(dir, "jeo-code", "0.2.0");
        writeJson(path.join(dir, "package.json"), { dependencies: { "jeo-code": "0.2.0", "new-tool": "^1.0.0" } });
        setVersion(dir, "new-tool", "1.0.0");
        return { success: true };
      },
    });
    await runUpdateCommandWith(["--json", "--install"], run.deps);
    expect(process.exitCode).toBe(1);
    const payload = onlyJson();
    expect(payload.externalChanges).toEqual([{ name: "new-tool", from: null, to: "1.0.0" }]);
    expect(payload).not.toHaveProperty("preflight");
  });

  test("restore commands are printed and never executed", async () => {
    const dir = fixture("ac4-c1", "full");
    const spawnSync = spyOn(Bun, "spawnSync");
    const spawn = spyOn(Bun, "spawn");
    try {
      const run = setup(at(dir), { install: drifting(dir) });
      await runUpdateCommandWith(["--install"], run.deps);
      expect(errored).toContain("  bun install -g jeopi-cli@16.6.18");
      expect(spawnSync).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawnSync.mockRestore();
      spawn.mockRestore();
    }
  });
});

describe("clean update (AC-5)", () => {
  test("AC-5: clean update reports shared global unchanged", async () => {
    const dir = fixture("ac5", "full");
    const human = setup(at(dir), { install: jeoOnly(dir) });
    await runUpdateCommandWith(["--install"], human.deps);
    expect(process.exitCode).toBe(0);
    expect(logged.join("\n")).toContain("shared global unchanged: ");
    expect(logged.join("\n")).toContain("jeopi-cli 16.6.18");
    // success line -> summary -> refresh -> release notes; nothing is refreshed before the postflight settled.
    expect(timeline).toEqual([
      "log:Installing update: 0.1.0 -> 0.2.0...",
      "install",
      "log:Successfully installed jeo-code@0.2.0",
      `log:${SUMMARY}`,
      "refresh:false",
      "whats-new",
    ]);

    logged = [];
    const json = setup(at(dir), { install: jeoOnly(dir) });
    setVersion(dir, "jeo-code", "0.1.0");
    await runUpdateCommandWith(["--json", "--install"], json.deps);
    const payload = onlyJson();
    expect(Object.keys(payload)).toEqual(["current", "latest", "upToDate", "installed", "messengersRefreshed", "externalChanges", "preflight"]);
    expect(payload.installed).toBe(true);
    expect(payload.externalChanges).toEqual([]);
    expect(payload.preflight).toEqual({ globalDir: dir, externalCount: 2, lockfile: "ok", uncovered: [], allowedUnlocked: false });
    expect(json.counts.refreshes).toEqual([true]);
  });

  test("a refresh that touches the shared global after the postflight settled is never blamed on the update", async () => {
    const dir = fixture("ac5-refresh", "full");
    const run = setup(at(dir), {
      install: jeoOnly(dir),
      onRefresh: () => setVersion(dir, "jeopi-cli", "99.0.0"),
    });
    await runUpdateCommandWith(["--install"], run.deps);
    expect(process.exitCode).toBe(0);
    expect(logged).toContain(SUMMARY);
    expect(errored).toEqual([]);
  });
});

describe("branch table", () => {
  test("stale active jeo with drift keeps the stale failure and adds the drift block", async () => {
    const dir = fixture("branch-stale", "full");
    const human = setup(at(dir), { install: drifting(dir), active: "0.1.0" });
    await runUpdateCommandWith(["--install"], human.deps);
    expect(process.exitCode).toBe(1);
    const errors = errored.join("\n");
    expect(errors).toContain("[FAILED] Installed jeo-code@0.2.0, but the active 'jeo' on PATH still reports 0.1.0.");
    expect(errors).toContain("  jeopi-cli 16.6.18 -> 16.6.19");
    expect(errors).toContain("  bun install -g jeopi-cli@16.6.18");
    expect(human.counts.refreshes).toEqual([]);
    expect(human.counts.whatsNew).toBe(0);

    setVersion(dir, "jeopi-cli", "16.6.18");
    setVersion(dir, "jeo-code", "0.1.0");
    logged = [];
    process.exitCode = 0;
    const json = setup(at(dir), { install: drifting(dir), active: "0.1.0" });
    await runUpdateCommandWith(["--json", "--install"], json.deps);
    const payload = onlyJson();
    expect(payload).toMatchObject({ installed: false, activeVersion: "0.1.0", error: "active jeo still reports an older version" });
    expect(payload.externalChanges).toEqual([{ name: "jeopi-cli", from: "16.6.18", to: "16.6.19" }]);
    expect(json.counts.refreshes).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("stale active jeo without drift keeps the existing failure and appends the summary keys", async () => {
    const dir = fixture("branch-stale-clean", "full");
    const run = setup(at(dir), { install: jeoOnly(dir), active: "0.1.0" });
    await runUpdateCommandWith(["--json", "--install"], run.deps);
    const payload = onlyJson();
    expect(Object.keys(payload)).toEqual(["current", "latest", "upToDate", "installed", "activeVersion", "error", "externalChanges", "preflight"]);
    expect(process.exitCode).toBe(1);
  });

  test("recovered install with drift fails instead of announcing success", async () => {
    const dir = fixture("branch-recovered-drift", "full");
    const human = setup(at(dir), { install: () => (drifting(dir)(), { success: false }) });
    await runUpdateCommandWith(["--install"], human.deps);
    expect(process.exitCode).toBe(1);
    expect(allOutput()).not.toContain("Successfully installed");
    expect(errored).toContain("  jeopi-cli 16.6.18 -> 16.6.19");
    expect(human.counts.refreshes).toEqual([]);
    expect(human.counts.whatsNew).toBe(0);

    setVersion(dir, "jeopi-cli", "16.6.18");
    logged = [];
    process.exitCode = 0;
    const json = setup(at(dir), { install: () => (drifting(dir)(), { success: false }) });
    await runUpdateCommandWith(["--json", "--install"], json.deps);
    const payload = onlyJson();
    expect(Object.keys(payload)).toEqual(["current", "latest", "upToDate", "installed", "recovered", "error", "externalChanges", "preflight"]);
    expect(payload).toMatchObject({ installed: true, recovered: true, error: "shared bun global changed: jeopi-cli 16.6.18 -> 16.6.19" });
    expect(json.counts.refreshes).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("recovered install without drift keeps its wording, then the summary, refresh and release notes", async () => {
    const dir = fixture("branch-recovered-clean", "full");
    const run = setup(at(dir), { install: () => (jeoOnly(dir)(), { success: false }) });
    await runUpdateCommandWith(["--install"], run.deps);
    expect(process.exitCode).toBe(0);
    expect(timeline).toEqual([
      "log:Installing update: 0.1.0 -> 0.2.0...",
      "install",
      "log:Successfully installed jeo-code@0.2.0 (package manager reported an error, but the runtime verified clean).",
      `log:${SUMMARY}`,
      "refresh:false",
      "whats-new",
    ]);
  });

  test("failure with drift keeps the generic error and prints the manual commands and the drift block", async () => {
    const dir = fixture("branch-failure", "full");
    const manual = ["bun install -g jeo-code@0.2.0 --force", "(npm was not tried: the active jeo is under the bun global install)"];
    const human = setup(at(dir), { install: () => (drifting(dir)(), { success: false, stderr: "bun exited with code 1", manual }), active: "0.1.0" });
    await runUpdateCommandWith(["--install"], human.deps);
    expect(process.exitCode).toBe(1);
    const errors = errored.join("\n");
    expect(errors).toContain("Failed to install update.");
    expect(errors).toContain("Try manually:");
    expect(errors).toContain("  bun install -g jeo-code@0.2.0 --force");
    expect(errors).toContain("  (npm was not tried: the active jeo is under the bun global install)");
    expect(errors).toContain("the install of jeo-code@0.2.0 did not finish cleanly, and the shared bun global at ");
    expect(errors).toContain("  jeopi-cli 16.6.18 -> 16.6.19");
    expect(errors).not.toContain("Messenger runtimes were not refreshed");
    expect(human.counts.refreshes).toEqual([]);

    setVersion(dir, "jeopi-cli", "16.6.18");
    logged = [];
    process.exitCode = 0;
    const json = setup(at(dir), { install: () => (drifting(dir)(), { success: false, manual }), active: "0.1.0" });
    await runUpdateCommandWith(["--json", "--install"], json.deps);
    const payload = onlyJson();
    expect(payload).toMatchObject({ installed: false, error: "Installation failed" });
    expect(payload).not.toHaveProperty("manual");
    expect(payload.externalChanges).toEqual([{ name: "jeopi-cli", from: "16.6.18", to: "16.6.19" }]);
    expect(process.exitCode).toBe(1);
  });

  test("failure without a shared global prints the manual commands only when the installer supplied them", async () => {
    const plain = setup(null, { install: () => ({ success: false }), active: "0.1.0" });
    await runUpdateCommandWith(["--install"], plain.deps);
    expect(errored).toEqual(["Failed to install update."]);

    errored = [];
    process.exitCode = 0;
    const withManual = setup(null, { install: () => ({ success: false, manual: ["bun install -g jeo-code@0.2.0 --force"] }), active: "0.1.0" });
    await runUpdateCommandWith(["--install"], withManual.deps);
    expect(errored).toEqual(["Failed to install update.", "Try manually:", "  bun install -g jeo-code@0.2.0 --force"]);
  });

  test("a throwing installer is settled once: drift is reported next to the original error", async () => {
    const dir = fixture("branch-throw", "full");
    const human = setup(at(dir), {
      install: () => {
        drifting(dir)();
        throw new Error("boom");
      },
    });
    await runUpdateCommandWith(["--install"], human.deps);
    expect(process.exitCode).toBe(1);
    const errors = errored.join("\n");
    expect(errors).toContain("Failed to install update: boom");
    expect(errors).toContain("  jeopi-cli 16.6.18 -> 16.6.19");
    expect(errors).toContain("  bun install -g jeopi-cli@16.6.18");
    expect(human.counts.refreshes).toEqual([]);

    setVersion(dir, "jeopi-cli", "16.6.18");
    logged = [];
    process.exitCode = 0;
    const json = setup(at(dir), {
      install: () => {
        drifting(dir)();
        throw new Error("boom");
      },
    });
    await runUpdateCommandWith(["--json", "--install"], json.deps);
    const payload = onlyJson();
    expect(payload).toMatchObject({ installed: false, error: "Installation error: boom" });
    expect(payload.externalChanges).toEqual([{ name: "jeopi-cli", from: "16.6.18", to: "16.6.19" }]);
  });

  test("a throwing installer that changed nothing reports an empty externalChanges", async () => {
    const dir = fixture("branch-throw-clean", "full");
    const run = setup(at(dir), {
      install: () => {
        throw new Error("offline");
      },
    });
    await runUpdateCommandWith(["--json", "--install"], run.deps);
    const payload = onlyJson();
    expect(payload).toMatchObject({ installed: false, error: "Installation error: offline", externalChanges: [] });
    expect(process.exitCode).toBe(1);
  });

  test.each([
    { name: "clean", drift: false },
    { name: "drifting", drift: true },
  ])("pinned --version X --install runs both flights ($name)", async ({ drift }) => {
    const dir = fixture(`branch-pinned-${drift}`, "full", MANIFEST, { ...INSTALLED, "jeo-code": "0.3.0" });
    const run = setup(at(dir), {
      current: "0.3.0",
      active: "0.2.0",
      install: drift ? drifting(dir) : jeoOnly(dir),
    });
    await runUpdateCommandWith(["--install", "--version", "0.2.0"], run.deps);
    expect(run.counts.locates).toBe(1);
    expect(run.counts.installs).toBe(1);
    expect(logged[0]).toBe("Installing pinned version: 0.3.0 -> 0.2.0...");
    if (drift) {
      expect(process.exitCode).toBe(1);
      expect(errored).toContain("  jeopi-cli 16.6.18 -> 16.6.19");
    } else {
      expect(process.exitCode).toBe(0);
      expect(logged).toContain(SUMMARY);
    }
  });

  test("pinned refusal happens before the Installing line", async () => {
    const dir = fixture("branch-pinned-refused", "none");
    const run = setup(at(dir), { current: "0.3.0", active: "0.2.0" });
    await runUpdateCommandWith(["--install", "--version", "0.2.0"], run.deps);
    expect(run.counts.installs).toBe(0);
    expect(logged).toEqual([]);
    expect(errored[0]).toContain("[REFUSED]");
    expect(process.exitCode).toBe(1);
  });

  const neverConsulted: { name: string; args: string[]; current?: string; fetch?: UpdateDeps["fetchJson"] }[] = [
    { name: "--check", args: ["--check"] },
    { name: "--check with --allow-unlocked-global", args: ["--check", "--allow-unlocked-global"] },
    { name: "--json without --install", args: ["--json"] },
    { name: "--json --check", args: ["--json", "--check"] },
    { name: "up to date with --install", args: ["--install"], current: "0.2.0" },
    { name: "up to date with --install --json", args: ["--json", "--install"], current: "0.2.0" },
    { name: "pinned to the current version", args: ["--install", "--version", "0.2.0"], current: "0.2.0" },
    { name: "--help", args: ["--help"] },
    { name: "an unknown flag", args: ["--bogus"] },
    { name: "a bad --version", args: ["--version", "nope"] },
    {
      name: "a registry 404",
      args: ["--install"],
      fetch: async () => {
        throw Object.assign(new Error("Package not found on registry"), { status: 404 });
      },
    },
    {
      name: "a network failure",
      args: ["--install"],
      fetch: async () => {
        throw new Error("offline");
      },
    },
  ];

  test.each(neverConsulted)("the shared global is never consulted for $name", async ({ args, current, fetch }) => {
    const dir = fixture("branch-never", "none");
    const before = hashTree(dir);
    const run = setup(at(dir), { current, fetchJson: fetch, install: jeoOnly(dir) });
    await runUpdateCommandWith(args, run.deps);
    expect(run.counts.locates).toBe(0);
    expect(run.counts.installs).toBe(0);
    expect(allOutput()).not.toContain("Shared bun global");
    expect(allOutput()).not.toContain("shared global");
    expect(allOutput()).not.toContain("[REFUSED]");
    expect(hashTree(dir)).toBe(before);
  });

  test("--check and --json output is byte-identical with and without a shared global, and the flag is ignored", async () => {
    const dir = fixture("branch-identical", "none");
    for (const args of [["--check"], ["--json"], ["--json", "--check"]]) {
      const without = await capture(args, setup(null).deps);
      const withShared = await capture(args, setup(at(dir)).deps);
      const withFlag = await capture([...args, "--allow-unlocked-global"], setup(at(dir)).deps);
      expect(withShared).toEqual(without);
      expect(withFlag).toEqual(without);
    }
  });

  test("a locate failure prints one note for humans and nothing for --json, and the update proceeds", async () => {
    const run = setup(() => ({ ok: false, reason: "no-bun-global", detail: "/nowhere" }));
    await runUpdateCommandWith(["--install"], run.deps);
    expect(run.counts.installs).toBe(1);
    expect(process.exitCode).toBe(0);
    expect(logged).toEqual([
      "Shared bun global not inspected (no-bun-global); the isolation check is skipped.",
      "Installing update: 0.1.0 -> 0.2.0...",
      "Successfully installed jeo-code@0.2.0",
    ]);

    logged = [];
    const json = setup(() => ({ ok: false, reason: "windows" }));
    await runUpdateCommandWith(["--json", "--install"], json.deps);
    expect(json.counts.installs).toBe(1);
    const payload = onlyJson();
    expect(payload).toEqual({ current: "0.1.0", latest: "0.2.0", upToDate: false, installed: true, messengersRefreshed: true });
  });

  test("an unreadable manifest is reported like a locate failure", async () => {
    const dir = mk("branch-manifest");
    writeText(path.join(dir, "package.json"), "{ nope");
    const run = setup(at(dir));
    await runUpdateCommandWith(["--install"], run.deps);
    expect(run.counts.installs).toBe(1);
    expect(logged[0]).toBe("Shared bun global not inspected (manifest-unreadable); the isolation check is skipped.");
  });

  test("a locate result with an unparsable manifest never refuses", async () => {
    const dir = mk("branch-manifest-json");
    writeText(path.join(dir, "package.json"), "[]");
    const run = setup(at(dir));
    await runUpdateCommandWith(["--json", "--install"], run.deps);
    expect(run.counts.installs).toBe(1);
    expect(onlyJson()).toEqual({ current: "0.1.0", latest: "0.2.0", upToDate: false, installed: true, messengersRefreshed: true });
  });

  test("--help documents --allow-unlocked-global", async () => {
    await runUpdateCommandWith(["--help"], setup(null).deps);
    expect(logged.some(line => line.includes("--allow-unlocked-global") && line.includes("bun.lock"))).toBe(true);
  });
});

/** Fixture for the compiled-binary tests: HOME holds a bun global; the "compiled" entry is its own executable. */
function compiledFixture(label: string, lock: LockMode): { home: string; dir: string; exe: string; env: Record<string, string> } {
  const home = mk(label);
  const dir = makeGlobal(path.join(home, ".bun", "install", "global"), { manifest: MANIFEST, lock, installed: INSTALLED });
  return { home, dir, exe: path.join(home, "dist", "jeo"), env: { HOME: home, PATH: "" } };
}

describe("compiled binary", () => {
  test("compiled binary: a global without a lockfile is refused and 0 installers run", async () => {
    const { home, dir, exe, env } = compiledFixture("compiled-refused", "none");
    const before = hashTree(dir);
    // Real compiled detection: entry === execPath is what currentJeoCommand treats as a compiled binary, so the
    // origin is unknown, yet the global is still located and guarded because jeo update still runs bun into it.
    expect(detectInstallOrigin({ entry: exe, execPath: exe, env, home }).origin).toBe("unknown");
    expect(locateSharedGlobal({ env, home, entry: exe, execPath: exe })).toEqual({ ok: true, dir });
    const run = setup(() => locateSharedGlobal({ env, home, entry: exe, execPath: exe }), { install: jeoOnly(dir) });
    await runUpdateCommandWith(["--install"], run.deps);
    expect(run.counts.locates).toBe(1);
    expect(run.counts.installs).toBe(0);
    expect(process.exitCode).toBe(1);
    expect(errored.join("\n")).toContain("[REFUSED]");
    expect(errored.join("\n")).toContain("--allow-unlocked-global");
    expect(hashTree(dir)).toBe(before);
  });

  test("compiled binary: a covered lockfile proceeds with origin unknown (no npm candidate)", async () => {
    const { home, dir, exe, env } = compiledFixture("compiled-covered", "full");
    // The same layout run as a script from the bun global is classified bun-global: the compiled entry is what changes it.
    const bin = path.join(home, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const cli = writeText(path.join(dir, "node_modules", "jeo-code", "src", "cli.ts"), "#!/usr/bin/env bun\n", 0o755);
    fs.symlinkSync(cli, path.join(bin, "jeo"));
    const onPath = { HOME: home, PATH: bin };
    expect(detectInstallOrigin({ entry: path.join(home, "script.ts"), execPath: "/opt/bun/bin/bun", env: onPath, home }).origin).toBe("bun-global");
    expect(detectInstallOrigin({ entry: exe, execPath: exe, env: onPath, home }).origin).toBe("unknown");

    // Success path through the real runInstall: one bun spawn, never npm.
    const spawned: string[][] = [];
    const wire = (spawn: InstallIo["spawn"], active: string | null): UpdateDeps["install"] => async version =>
      runInstall(version, { spawn, activeVersion: () => active, origin: () => detectInstallOrigin({ entry: exe, execPath: exe, env, home }).origin });
    const ok = setup(() => locateSharedGlobal({ env, home, entry: exe, execPath: exe }));
    ok.deps.install = wire(cmd => {
      spawned.push(cmd);
      setVersion(dir, "jeo-code", "0.2.0");
      return { success: true };
    }, "0.2.0");
    await runUpdateCommandWith(["--install"], ok.deps);
    expect(process.exitCode).toBe(0);
    expect(spawned).toEqual([["bun", "install", "-g", "jeo-code@0.2.0"]]);
    expect(logged).toContain(SUMMARY);

    // Failure path: both bun forms fail and npm is never attempted; the manual commands are printed.
    spawned.length = 0;
    logged = [];
    errored = [];
    process.exitCode = 0;
    const bad = setup(() => locateSharedGlobal({ env, home, entry: exe, execPath: exe }), { active: "0.1.0" });
    bad.deps.install = wire(cmd => {
      spawned.push(cmd);
      return { success: false, exitCode: 1 };
    }, "0.1.0");
    await runUpdateCommandWith(["--install"], bad.deps);
    expect(spawned).toEqual([
      ["bun", "install", "-g", "jeo-code@0.2.0"],
      ["bun", "install", "-g", "jeo-code@0.2.0", "--force"],
    ]);
    expect(process.exitCode).toBe(1);
    expect(errored).toEqual([
      "Failed to install update.",
      "Try manually:",
      "  bun install -g jeo-code@0.2.0 --force",
      "  (npm was not tried: the active jeo is not under the npm global root; if it came from npm run: npm install -g jeo-code@0.2.0)",
    ]);
  });
});

const TARGET = "jeo-code@0.2.0";
const BUN = ["bun", "install", "-g", TARGET];
const BUN_FORCE = ["bun", "install", "-g", TARGET, "--force"];
const NPM = ["npm", "install", "-g", TARGET];

test("installCandidates by origin: bun-global yields the two bun forms", () => {
  expect(installCandidates(TARGET, "bun-global")).toEqual([BUN, BUN_FORCE]);
});

test("installCandidates by origin: npm-global appends npm last", () => {
  expect(installCandidates(TARGET, "npm-global")).toEqual([BUN, BUN_FORCE, NPM]);
});

test("installCandidates by origin: unknown yields the two bun forms", () => {
  expect(installCandidates(TARGET, "unknown")).toEqual([BUN, BUN_FORCE]);
});

test("installCandidates by origin: undefined keeps the legacy three", () => {
  expect(installCandidates(TARGET)).toEqual([BUN, BUN_FORCE, NPM]);
  expect(installCandidates(TARGET, undefined)).toEqual([BUN, BUN_FORCE, NPM]);
});

/** A recording InstallIo: spawn results come from `outcomes` in order (the last one repeats). */
function recordingIo(origin: InstallOrigin, outcomes: ({ success: boolean; exitCode?: number } | Error)[], active: string | null = null): { io: InstallIo; events: string[]; spawned: string[][] } {
  const events: string[] = [];
  const spawned: string[][] = [];
  const io: InstallIo = {
    spawn: cmd => {
      events.push("spawn");
      spawned.push(cmd);
      const outcome = outcomes[Math.min(spawned.length - 1, outcomes.length - 1)]!;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    activeVersion: () => active,
    origin: () => {
      events.push("origin");
      return origin;
    },
  };
  return { io, events, spawned };
}

test("runInstall never runs npm for a bun-global active jeo", () => {
  const { io, events, spawned } = recordingIo("bun-global", [{ success: false, exitCode: 1 }]);
  const result = runInstall("0.2.0", io);
  expect(spawned).toEqual([BUN, BUN_FORCE]);
  // The origin is resolved exactly once, before the first spawn.
  expect(events).toEqual(["origin", "spawn", "spawn"]);
  expect(result).toEqual({ success: false, stderr: "bun exited with code 1", manual: manualInstallLines(TARGET, "bun-global") });

  // A "successful" bun whose active jeo did not move continues to --force and still never reaches npm.
  const stale = recordingIo("bun-global", [{ success: true }], "0.1.0");
  const staleResult = runInstall("0.2.0", stale.io);
  expect(stale.spawned).toEqual([BUN, BUN_FORCE]);
  expect(staleResult.success).toBe(false);
  expect(staleResult.stderr).toBe("bun reported success but the active 'jeo' is still 0.1.0");
});

test("runInstall never runs npm for an unknown origin and a throwing bun is recorded as unavailable", () => {
  const { io, spawned } = recordingIo("unknown", [new Error("spawn bun ENOENT")]);
  const result = runInstall("0.2.0", io);
  expect(spawned).toEqual([BUN, BUN_FORCE]);
  expect(result.success).toBe(false);
  expect(result.stderr).toBe("bun unavailable: spawn bun ENOENT");
  expect(result.manual).toEqual(manualInstallLines(TARGET, "unknown"));
});

test("runInstall tries npm last for an npm-global active jeo and returns no manual lines when everything failed", () => {
  const failing = recordingIo("npm-global", [{ success: false, exitCode: 3 }]);
  const result = runInstall("0.2.0", failing.io);
  expect(failing.spawned).toEqual([BUN, BUN_FORCE, NPM]);
  expect(result).toEqual({ success: false, stderr: "npm exited with code 3", manual: [] });

  // bun fails twice, npm succeeds and the active jeo now reports the target.
  const recovered = recordingIo("npm-global", [{ success: false, exitCode: 1 }, { success: false, exitCode: 1 }, { success: true }], "0.2.0");
  expect(runInstall("0.2.0", recovered.io)).toEqual({ success: true });
  expect(recovered.spawned).toEqual([BUN, BUN_FORCE, NPM]);
});

test("runInstall stops at the first success that the active jeo confirms, and without a version skips the active check", () => {
  const first = recordingIo("bun-global", [{ success: true }], "0.2.0");
  expect(runInstall("0.2.0", first.io)).toEqual({ success: true });
  expect(first.spawned).toEqual([BUN]);

  const latest = recordingIo("bun-global", [{ success: true }], "0.0.1");
  expect(runInstall(undefined, latest.io)).toEqual({ success: true });
  expect(latest.spawned).toEqual([["bun", "install", "-g", "jeo-code@latest"]]);
});

test("runInstall failure under bun-global returns manual install lines", () => {
  const { io } = recordingIo("bun-global", [{ success: false, exitCode: 1 }]);
  expect(runInstall("0.2.0", io).manual).toEqual([
    "bun install -g jeo-code@0.2.0 --force",
    "(npm was not tried: the active jeo is under the bun global install)",
  ]);
});

test("runInstall failure under an unknown origin returns the manual lines with the npm hint", () => {
  const { io } = recordingIo("unknown", [{ success: false, exitCode: 1 }]);
  expect(runInstall("0.2.0", io).manual).toEqual([
    "bun install -g jeo-code@0.2.0 --force",
    "(npm was not tried: the active jeo is not under the npm global root; if it came from npm run: npm install -g jeo-code@0.2.0)",
  ]);
});

test("runInstall resolves the origin once even when every candidate fails", () => {
  const { io, events } = recordingIo("npm-global", [{ success: false, exitCode: 1 }]);
  runInstall("0.2.0", io);
  expect(events.filter(event => event === "origin")).toHaveLength(1);
  expect(events[0]).toBe("origin");
});

test("runInstall accepts an installer success when the active version is unreadable (Windows shim)", () => {
  // Regression: on Windows `bun install -g` succeeds ("N packages installed") yet a bare
  // `jeo --version` spawn can fail to resolve the bin, so activeVersion is null. That must
  // not burn the --force candidate and report a failure for a landed install.
  const { io, spawned } = recordingIo("unknown", [{ success: true }]); // active defaults to null
  expect(runInstall("0.2.0", io)).toEqual({ success: true });
  expect(spawned).toEqual([BUN]);
});

test("jeoVersionAttempts: POSIX asks jeo once, win32 retries exe and cmd spellings", () => {
  expect(jeoVersionAttempts("darwin")).toEqual([["jeo", "--version"]]);
  expect(jeoVersionAttempts("linux")).toEqual([["jeo", "--version"]]);
  expect(jeoVersionAttempts("win32")).toEqual([
    ["jeo", "--version"],
    ["jeo.exe", "--version"],
    ["cmd", "/d", "/s", "/c", "jeo --version"],
  ]);
});
