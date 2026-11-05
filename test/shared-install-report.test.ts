import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runDoctorCommand, type DoctorDeps } from "../src/commands/doctor";
import {
  collectSharedInstallReport,
  findStaleLeftovers,
  listJeoOnPathWithVersions,
  sizeReport,
  type SharedInstallReport,
} from "../src/util/shared-install-report";

// Every fixture lives under this root. The real ~/.bun, PATH and HOME are never read or written:
// each test hands the collector an explicit env/home/platform.
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jeo-shared-install-report-test-")));
let counter = 0;
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function mk(label: string): string {
  const dir = path.join(ROOT, `${label}-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeText(file: string, text: string | Buffer, mode?: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode !== undefined) fs.chmodSync(file, mode);
  return file;
}

function writeJson(file: string, value: unknown): string {
  return writeText(file, JSON.stringify(value, null, 2));
}

function writeExec(file: string): string {
  return writeText(file, "#!/bin/sh\nexit 0\n", 0o755);
}

interface GlobalSpec {
  manifest: Record<string, string>;
  lock?: "none" | "full" | { omit: string[] };
  installed?: Record<string, string>;
}

/** `<home>/.bun/install/global` with a manifest, an optional bun.lock and installed package.json files. */
function makeGlobal(home: string, spec: GlobalSpec): string {
  const dir = path.join(home, ".bun", "install", "global");
  writeJson(path.join(dir, "package.json"), { name: "global", dependencies: spec.manifest });
  const lock = spec.lock ?? "full";
  if (lock !== "none") {
    const omit = lock === "full" ? [] : lock.omit;
    const packages = Object.fromEntries(
      Object.entries(spec.manifest)
        .filter(([name]) => !omit.includes(name))
        .map(([name, range]) => [name, [`${name}@${range}`, "", {}, "sha512-fixture"]]),
    );
    writeJson(path.join(dir, "bun.lock"), { lockfileVersion: 1, workspaces: { "": { dependencies: spec.manifest } }, packages });
  }
  for (const [name, version] of Object.entries(spec.installed ?? {})) {
    writeJson(path.join(dir, "node_modules", name, "package.json"), { name, version });
  }
  return fs.realpathSync(dir);
}

function fillPackage(globalDir: string, name: string, bytes: number): void {
  writeText(path.join(globalDir, "node_modules", name, "payload.bin"), Buffer.alloc(bytes, 1));
}

/** A jeo-code package at `root` with a `jeo` entry script; returns the script path. */
function installJeo(root: string, version: string): string {
  writeJson(path.join(root, "node_modules", "jeo-code", "package.json"), { name: "jeo-code", version });
  return writeExec(path.join(root, "node_modules", "jeo-code", "src", "cli.ts"));
}

/** A PATH directory whose `jeo` is a symlink to `target`. */
function linkBin(dir: string, target: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(target, path.join(dir, "jeo"));
  return dir;
}

function envFor(home: string, pathDirs: string[]): Record<string, string> {
  return { HOME: home, BUN_INSTALL: path.join(home, ".bun"), PATH: pathDirs.join(path.delimiter) };
}

function collect(home: string, pathDirs: string[] = [], extra: Parameters<typeof collectSharedInstallReport>[0] = {}): SharedInstallReport {
  return collectSharedInstallReport({ env: envFor(home, pathDirs), home, platform: "linux", ...extra });
}

/** sha256 over relative layout, modes, mtimes, sizes, file bytes and symlink targets of whole trees. */
function hashTree(roots: string[]): string {
  const hash = createHash("sha256");
  const visit = (p: string): void => {
    const st = fs.lstatSync(p);
    hash.update(`${p}|${st.mode}|${st.mtimeMs}|${st.size}\n`);
    if (st.isSymbolicLink()) hash.update(`->${fs.readlinkSync(p)}\n`);
    else if (st.isDirectory()) for (const name of fs.readdirSync(p).sort()) visit(path.join(p, name));
    else hash.update(fs.readFileSync(p));
  };
  for (const root of roots) visit(root);
  return hash.digest("hex");
}

const THREE_PACKAGES = { "jeo-code": "0.12.21", "jeopi-cli": "16.6.18", "oh-my-agent": "^10.23.2" };

describe("AC-7a: bun.lock status", () => {
  test("a missing bun.lock lists every external dependency as uncovered", () => {
    const home = mk("home");
    const dir = makeGlobal(home, { manifest: THREE_PACKAGES, lock: "none" });
    const report = collect(home);
    expect(report.skipped).toBeNull();
    expect(report.globalDir).toBe(dir);
    expect(report.manifest).toEqual({ dependencies: 3, external: 2 });
    expect(report.lockfile).toMatchObject({ status: "missing", uncovered: ["jeopi-cli", "oh-my-agent"], path: path.join(dir, "bun.lock") });
  });

  test("an incomplete bun.lock names exactly the dependency without a resolved entry", () => {
    const home = mk("home");
    makeGlobal(home, { manifest: THREE_PACKAGES, lock: { omit: ["oh-my-agent"] } });
    expect(collect(home).lockfile).toMatchObject({ status: "incomplete", uncovered: ["oh-my-agent"] });
  });

  test("a complete bun.lock is ok", () => {
    const home = mk("home");
    makeGlobal(home, { manifest: THREE_PACKAGES, lock: "full" });
    expect(collect(home).lockfile).toMatchObject({ status: "ok", uncovered: [] });
  });

  test("a compiled binary (entry === execPath) is not a skip reason: the report is produced as usual", () => {
    const home = mk("home");
    makeGlobal(home, { manifest: THREE_PACKAGES, lock: { omit: ["oh-my-agent"] } });
    const compiled = path.join(mk("compiled"), "jeo");
    const report = collect(home, [], { entry: compiled, execPath: compiled });
    expect(report.skipped).toBeNull();
    expect(report.lockfile).toMatchObject({ status: "incomplete", uncovered: ["oh-my-agent"] });
    expect(report.sizes).not.toBeNull();
  });

  test("a manifest with only jeo-code does not need a lock", () => {
    const home = mk("home");
    makeGlobal(home, { manifest: { "jeo-code": "0.12.21" }, lock: "none" });
    const report = collect(home);
    expect(report.manifest).toEqual({ dependencies: 1, external: 0 });
    expect(report.lockfile).toMatchObject({ status: "not-required", uncovered: [] });
  });
});

describe("collectSharedInstallReport skip reasons", () => {
  test("no bun global dir: skipped, every other section null, jeo on PATH still listed", () => {
    const home = mk("home");
    const cli = installJeo(mk("inst"), "0.12.21");
    const bin = linkBin(mk("bin"), cli);
    const report = collect(home, [bin]);
    expect(report).toMatchObject({ globalDir: null, skipped: "no-bun-global", manifest: null, lockfile: null, leftovers: null, sizes: null });
    expect(report.jeoOnPath.map(e => e.path)).toEqual([path.join(bin, "jeo")]);
  });

  test("windows: skipped and nothing on PATH is listed", () => {
    const home = mk("home");
    makeGlobal(home, { manifest: THREE_PACKAGES });
    const bin = linkBin(mk("bin"), installJeo(mk("inst"), "0.12.21"));
    const report = collectSharedInstallReport({ env: envFor(home, [bin]), home, platform: "win32" });
    expect(report).toMatchObject({ globalDir: null, skipped: "windows", jeoOnPath: [] });
  });

  test("an unparsable manifest and a non-object dependencies are both manifest-unreadable", () => {
    const corrupt = mk("home");
    writeText(path.join(corrupt, ".bun", "install", "global", "package.json"), "{ not json");
    expect(collect(corrupt)).toMatchObject({ globalDir: null, skipped: "manifest-unreadable", lockfile: null });

    const arrayDeps = mk("home");
    writeJson(path.join(arrayDeps, ".bun", "install", "global", "package.json"), { dependencies: ["a"] });
    expect(collect(arrayDeps)).toMatchObject({ globalDir: null, skipped: "manifest-unreadable", sizes: null });
  });

  test("a node_modules that is a plain file degrades to empty findings instead of throwing", () => {
    const home = mk("home");
    const dir = makeGlobal(home, { manifest: THREE_PACKAGES });
    writeText(path.join(dir, "node_modules"), "not a directory");
    const report = collect(home);
    expect(report.leftovers).toEqual({ backupFiles: [], possibleOrphans: [], orphanScanComplete: true });
    expect(report.sizes).toMatchObject({ top: [], totalBytes: 0, scannedEntries: 0, complete: true, capped: null });
  });
});

describe("AC-7b: jeo on PATH", () => {
  test("lists each realpath once in PATH order, first is active, an older install is stale", () => {
    const cliA = installJeo(mk("inst-a"), "0.12.21");
    const cliC = installJeo(mk("inst-c"), "0.9.10");
    const p1 = linkBin(mk("p1"), cliA);
    const p2 = linkBin(mk("p2"), cliA);
    const p3 = linkBin(mk("p3"), cliC);
    const missing = path.join(ROOT, "does-not-exist");
    const dirNamedJeo = mk("dir-named-jeo");
    fs.mkdirSync(path.join(dirNamedJeo, "jeo"));
    const notExecutable = mk("not-exec");
    writeText(path.join(notExecutable, "jeo"), "#!/bin/sh\n", 0o644);
    const pathDirs = [missing, dirNamedJeo, notExecutable, "relative/bin", "", p1, p2, p3];

    const entries = listJeoOnPathWithVersions({ PATH: pathDirs.join(path.delimiter) }, "linux");
    expect(entries).toEqual([
      { path: path.join(p1, "jeo"), realpath: cliA, version: "0.12.21", active: true, stale: false },
      { path: path.join(p3, "jeo"), realpath: cliC, version: "0.9.10", active: false, stale: true },
    ]);
  });

  test("a newer second install is stale too, and an equal version is not", () => {
    const active = linkBin(mk("p"), installJeo(mk("inst"), "0.12.21"));
    const newer = linkBin(mk("p"), installJeo(mk("inst"), "0.13.0"));
    const same = linkBin(mk("p"), installJeo(mk("inst"), "0.12.21"));
    const entries = listJeoOnPathWithVersions({ PATH: [active, newer, same].join(path.delimiter) }, "linux");
    expect(entries.map(e => [e.version, e.active, e.stale])).toEqual([
      ["0.12.21", true, false],
      ["0.13.0", false, true],
      ["0.12.21", false, false],
    ]);
  });

  test("no version is guessed when no jeo-code package.json is near: version null, never stale", () => {
    const lone = mk("lone");
    const script = writeExec(path.join(lone, "jeo.sh"));
    const loneBin = linkBin(mk("p"), script);
    const real = linkBin(mk("p"), installJeo(mk("inst"), "0.9.10"));
    const noVersionFirst = listJeoOnPathWithVersions({ PATH: [loneBin, real].join(path.delimiter) }, "linux");
    expect(noVersionFirst.map(e => [e.version, e.active, e.stale])).toEqual([
      [null, true, false],
      ["0.9.10", false, false],
    ]);
    const noVersionSecond = listJeoOnPathWithVersions({ PATH: [real, loneBin].join(path.delimiter) }, "linux");
    expect(noVersionSecond.map(e => [e.version, e.active, e.stale])).toEqual([
      ["0.9.10", true, false],
      [null, false, false],
    ]);
  });

  test("the package.json is found up to four directories above the entry script, not five, and other names are skipped", () => {
    const four = mk("four");
    writeJson(path.join(four, "package.json"), { name: "jeo-code", version: "1.2.3" });
    const deepFour = writeExec(path.join(four, "a", "b", "c", "d", "cli.ts"));
    const five = mk("five");
    writeJson(path.join(five, "package.json"), { name: "jeo-code", version: "1.2.3" });
    const deepFive = writeExec(path.join(five, "a", "b", "c", "d", "e", "cli.ts"));
    const other = mk("other");
    writeJson(path.join(other, "package.json"), { name: "jeo-code", version: "4.5.6" });
    writeJson(path.join(other, "src", "package.json"), { name: "not-jeo", version: "9.9.9" });
    const shadowed = writeExec(path.join(other, "src", "cli.ts"));

    const version = (script: string): string | null => listJeoOnPathWithVersions({ PATH: linkBin(mk("p"), script) }, "linux")[0]?.version ?? null;
    expect(version(deepFour)).toBe("1.2.3");
    expect(version(deepFive)).toBeNull();
    expect(version(shadowed)).toBe("4.5.6");
  });

  test("win32 lists nothing", () => {
    const bin = linkBin(mk("p"), installJeo(mk("inst"), "0.12.21"));
    expect(listJeoOnPathWithVersions({ PATH: bin }, "win32")).toEqual([]);
  });
});

describe("AC-7c: stale leftovers", () => {
  function leftoverFixture(): string {
    const dir = mk("leftovers");
    const nm = path.join(dir, "node_modules");
    // Declared by installed packages: the top-level `transitive-dep`, `@scope/declared` (a's dependencies),
    // `deep-top` (a NESTED package's dependencies), `opt-top` (optionalDependencies) and `peer-top` (peerDependencies).
    writeJson(path.join(nm, "a", "package.json"), { name: "a", dependencies: { "transitive-dep": "1", "@scope/declared": "1" } });
    writeJson(path.join(nm, "a", "node_modules", "inner", "package.json"), { name: "inner", dependencies: { "deep-top": "1" } });
    writeJson(path.join(nm, "b", "package.json"), { name: "b", optionalDependencies: { "opt-top": "1" }, peerDependencies: { "peer-top": "1" } });
    for (const name of ["transitive-dep", "@scope/declared", "deep-top", "opt-top", "peer-top", "@scope/orphan", "lonely"]) {
      writeJson(path.join(nm, name, "package.json"), { name, version: "1.0.0" });
    }
    // A symlink is classified from the Dirent plus one existence check, never descended into or read: the live
    // link's package.json declares `lonely`, which must NOT rescue `lonely` from being reported.
    const external = mk("external");
    writeJson(path.join(external, "package.json"), { name: "live", dependencies: { lonely: "1" } });
    fs.symlinkSync(external, path.join(nm, "live"));
    fs.symlinkSync(path.join(ROOT, "no-such-target"), path.join(nm, "dangling"));
    // Ignored: dot entries at both levels, and a plain file.
    writeText(path.join(nm, ".DS_Store"), "x");
    writeText(path.join(nm, ".bin", "tool"), "x");
    writeText(path.join(nm, ".cache", "entry"), "x");
    writeText(path.join(nm, "@scope", ".hidden", "package.json"), "{}");
    writeText(path.join(nm, "readme.txt"), "x");
    // Backup files in the global dir itself.
    writeText(path.join(dir, "package.json.jeopi-update-backup-x"), "{}");
    writeText(path.join(dir, "package.json.old-backup"), "{}");
    writeText(path.join(dir, "package.json.bak"), "{}");
    writeText(path.join(dir, "package.jsonbackup"), "{}");
    fs.mkdirSync(path.join(dir, "package.json.dir-backup"));
    return dir;
  }

  test("flags backup files and undeclared top-level packages; transitive, dot and plain-file entries are not flagged", () => {
    const dir = leftoverFixture();
    const report = findStaleLeftovers(dir, ["jeo-code", "a", "b"]);
    expect(report.backupFiles).toEqual(["package.json.jeopi-update-backup-x", "package.json.old-backup"]);
    expect(report.orphanScanComplete).toBe(true);
    expect(report.possibleOrphans).toEqual([
      { name: "@scope/orphan", kind: "directory" },
      { name: "dangling", kind: "dangling-symlink" },
      { name: "live", kind: "symlink" },
      { name: "lonely", kind: "directory" },
    ]);
    expect(report.possibleOrphans.some(o => o.name.startsWith("."))).toBe(false);
  });

  test("a manifest dependency is never an orphan, even when nothing declares it", () => {
    const dir = leftoverFixture();
    const report = findStaleLeftovers(dir, ["jeo-code", "a", "b", "lonely", "@scope/orphan"]);
    expect(report.possibleOrphans.map(o => o.name)).toEqual(["dangling", "live"]);
  });

  test("the declared-name scan stops at the manifest cap: incomplete and no orphans reported", () => {
    const dir = mk("cap");
    const nm = path.join(dir, "node_modules");
    writeJson(path.join(nm, "m", "package.json"), { name: "m" });
    writeJson(path.join(nm, "x", "package.json"), { name: "x" });
    writeJson(path.join(nm, "y", "package.json"), { name: "y" });
    expect(findStaleLeftovers(dir, ["m"], 3)).toMatchObject({ orphanScanComplete: true, possibleOrphans: [{ name: "x" }, { name: "y" }] });
    expect(findStaleLeftovers(dir, ["m"], 2)).toEqual({ backupFiles: [], possibleOrphans: [], orphanScanComplete: false });
  });

  test("nothing to classify means nothing to cap", () => {
    const dir = mk("cap-none");
    writeJson(path.join(dir, "node_modules", "m", "package.json"), { name: "m" });
    expect(findStaleLeftovers(dir, ["m"], 0)).toEqual({ backupFiles: [], possibleOrphans: [], orphanScanComplete: true });
  });

  test("collectSharedInstallReport passes the orphan cap through", () => {
    const home = mk("home");
    const dir = makeGlobal(home, { manifest: { "jeo-code": "0.12.21", m: "1" }, installed: { m: "1.0.0" } });
    writeJson(path.join(dir, "node_modules", "stray", "package.json"), { name: "stray" });
    expect(collect(home).leftovers?.possibleOrphans).toEqual([{ name: "stray", kind: "directory" }]);
    expect(collect(home, [], { orphanCapManifests: 1 }).leftovers).toEqual({ backupFiles: [], possibleOrphans: [], orphanScanComplete: false });
  });
});

describe("AC-7d: sizes", () => {
  const constantClock = (): number => 0;

  function sizeFixture(): { dir: string; linkBytes: number } {
    const dir = mk("sizes");
    const nm = path.join(dir, "node_modules");
    writeText(path.join(nm, "big", "a.bin"), Buffer.alloc(5000));
    writeText(path.join(nm, "big", "lib", "b.bin"), Buffer.alloc(3000));
    writeText(path.join(nm, "mid", "m.bin"), Buffer.alloc(4000));
    writeText(path.join(nm, "@scope", "pkg", "p.bin"), Buffer.alloc(2000));
    writeText(path.join(nm, "small-a", "s.txt"), Buffer.alloc(10));
    writeText(path.join(nm, "small-b", "s.txt"), Buffer.alloc(10));
    writeText(path.join(nm, "tiny", "t.txt"), Buffer.alloc(1));
    writeText(path.join(nm, ".bin", "tool"), Buffer.alloc(7));
    writeText(path.join(nm, "stray.txt"), Buffer.alloc(5));
    // A symlink counts its own size and its target is never walked.
    const external = mk("external");
    writeText(path.join(external, "huge.bin"), Buffer.alloc(100_000));
    fs.symlinkSync(external, path.join(nm, "link"));
    return { dir, linkBytes: fs.lstatSync(path.join(nm, "link")).size };
  }

  test("known file sizes give the top-5 order and the total; dot entries and stray files only count toward the total", () => {
    const { dir, linkBytes } = sizeFixture();
    const report = sizeReport(dir, { now: constantClock });
    const expectedTop = [
      { name: "big", bytes: 8000 },
      { name: "mid", bytes: 4000 },
      { name: "@scope/pkg", bytes: 2000 },
      { name: "link", bytes: linkBytes },
      { name: "small-a", bytes: 10 },
      { name: "small-b", bytes: 10 },
      { name: "tiny", bytes: 1 },
    ]
      .sort((a, b) => b.bytes - a.bytes || (a.name < b.name ? -1 : 1))
      .slice(0, 5);
    expect(report.top).toEqual(expectedTop);
    expect(report.top.slice(0, 3)).toEqual([
      { name: "big", bytes: 8000 },
      { name: "mid", bytes: 4000 },
      { name: "@scope/pkg", bytes: 2000 },
    ]);
    expect(report.totalBytes).toBe(8000 + 4000 + 2000 + linkBytes + 10 + 10 + 1 + 7 + 5);
    // Every Dirent is one entry: 9 at the root + .bin/tool + @scope/pkg + p.bin + big/{a.bin,lib} + b.bin + m.bin + 3 s.txt/t.txt.
    expect(report.scannedEntries).toBe(19);
    expect(report).toMatchObject({ complete: true, capped: null, elapsedMs: 0 });
  });

  test("the entry cap stops the scan early: capped 'entries', incomplete, partial figures", () => {
    const { dir } = sizeFixture();
    const full = sizeReport(dir, { now: constantClock });
    const capped = sizeReport(dir, { now: constantClock, capEntries: 3 });
    expect(capped).toMatchObject({ capped: "entries", complete: false, scannedEntries: 3 });
    expect(capped.totalBytes).toBeLessThan(full.totalBytes);
  });

  test("the entry cap is exact at the boundary: as many entries as exist completes, one fewer caps", () => {
    const { dir } = sizeFixture();
    expect(sizeReport(dir, { now: constantClock, capEntries: 19 })).toMatchObject({ complete: true, capped: null, scannedEntries: 19 });
    expect(sizeReport(dir, { now: constantClock, capEntries: 18 })).toMatchObject({ complete: false, capped: "entries", scannedEntries: 18 });
  });

  test("an injected clock past capMs caps the scan by time", () => {
    const dir = mk("time-cap");
    for (let i = 0; i < 300; i++) writeText(path.join(dir, "node_modules", "many", `f${i}.txt`), "x");
    // started = 0, the check before the first entry reads 0, the next check (after 256 entries) reads 10 000 > 1000.
    let calls = 0;
    const now = (): number => (calls++ < 2 ? 0 : 10_000);
    const report = sizeReport(dir, { now, capMs: 1000 });
    expect(report).toMatchObject({ capped: "time", complete: false, scannedEntries: 256, elapsedMs: 10_000 });
    expect(report.totalBytes).toBeLessThan(300);
  });

  test("a clock already past capMs before the first entry stops the scan immediately", () => {
    const { dir } = sizeFixture();
    let t = 0;
    const report = sizeReport(dir, { now: () => (t += 5000), capMs: 1000 });
    expect(report).toMatchObject({ capped: "time", complete: false, scannedEntries: 0, totalBytes: 0, top: [] });
  });

  test("without a node_modules the report is empty and complete", () => {
    expect(sizeReport(mk("empty"))).toMatchObject({ top: [], totalBytes: 0, scannedEntries: 0, complete: true, capped: null });
  });

  test("collectSharedInstallReport passes both size caps through", () => {
    const home = mk("home");
    const dir = makeGlobal(home, { manifest: THREE_PACKAGES });
    fillPackage(dir, "jeopi-cli", 100);
    expect(collect(home, [], { sizeCapEntries: 1 }).sizes).toMatchObject({ capped: "entries", complete: false });
    let t = 0;
    expect(collect(home, [], { sizeCapMs: 1, now: () => (t += 1000) }).sizes).toMatchObject({ capped: "time", complete: false });
    expect(collect(home).sizes).toMatchObject({ capped: null, complete: true });
  });
});

/** A fixture with a covered lock, a stale second jeo, a backup file, orphans and a few packages of known size. */
function richFixture(): { fx: string; home: string; dir: string; pathDirs: string[]; active: string; stale: string } {
  const fx = mk("rich");
  const home = path.join(fx, "home");
  fs.mkdirSync(home, { recursive: true });
  const dir = makeGlobal(home, {
    manifest: { "jeo-code": "0.12.21", "jeopi-cli": "16.6.18", "gajae-code": "^0.6.1" },
    installed: { "jeopi-cli": "16.6.18", "gajae-code": "0.6.1" },
  });
  fillPackage(dir, "gajae-code", 9000);
  fillPackage(dir, "jeopi-cli", 3000);
  writeText(path.join(dir, "package.json.jeopi-update-backup-71pfjiiu"), "{}");
  writeJson(path.join(dir, "node_modules", "@scope", "orphan", "package.json"), { name: "@scope/orphan" });
  fs.symlinkSync(path.join(fx, "gone"), path.join(dir, "node_modules", "supercode"));
  writeText(path.join(dir, "node_modules", ".DS_Store"), "x");
  const cliA = installJeo(path.join(fx, "inst-a"), "0.12.21");
  const cliC = installJeo(path.join(fx, "inst-c"), "0.9.10");
  const bin1 = linkBin(path.join(fx, "bin1"), cliA);
  const bin2 = linkBin(path.join(fx, "bin2"), cliA);
  const bin3 = linkBin(path.join(fx, "bin3"), cliC);
  return { fx, home, dir, pathDirs: [bin1, bin2, bin3], active: path.join(bin1, "jeo"), stale: path.join(bin3, "jeo") };
}

const ANSI = /\u001b\[[0-9;]*m/g;
const plain = (text: string): string => text.replace(ANSI, "");

describe("jeo doctor: shared install section", () => {
  let cfgDir = "";
  const savedCfgDir = process.env.JEO_CONFIG_DIR;
  const savedFetch = globalThis.fetch;
  // readGlobalConfig overlays env credentials and base URLs onto provider gaps, so clear them to keep
  // readiness deterministic regardless of the host env.
  const CRED_ENV = [
    "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_OAUTH_TOKEN",
    "GEMINI_API_KEY", "GEMINI_BASE_URL", "GEMINI_OAUTH_TOKEN",
    "XAI_API_KEY", "XAI_BASE_URL",
    "LMSTUDIO_BASE_URL",
  ];
  const savedCredEnv: Record<string, string | undefined> = {};

  function writeConfig(config: Record<string, unknown>): void {
    writeJson(path.join(cfgDir, "config.json"), { providers: {}, defaultModel: "gpt-4o", ...config });
  }

  beforeEach(() => {
    cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "jeo-doctor-shared-"));
    process.env.JEO_CONFIG_DIR = cfgDir;
    for (const key of CRED_ENV) {
      savedCredEnv[key] = process.env[key];
      delete process.env[key];
    }
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    writeConfig({});
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedCfgDir === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = savedCfgDir;
    for (const key of CRED_ENV) {
      if (savedCredEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedCredEnv[key];
    }
    fs.rmSync(cfgDir, { recursive: true, force: true });
  });

  async function runDoctor(args: string[], deps: DoctorDeps): Promise<string[]> {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...a: unknown[]) => {
      lines.push(a.join(" "));
    };
    try {
      await runDoctorCommand(args, deps);
    } finally {
      console.log = original;
    }
    return lines;
  }

  async function runWithExitStub(args: string[], deps: DoctorDeps): Promise<{ lines: string[]; exits: (number | undefined)[] }> {
    const exits: (number | undefined)[] = [];
    const realExit = process.exit;
    process.exit = ((code?: number) => {
      exits.push(code);
    }) as typeof process.exit;
    try {
      return { lines: await runDoctor(args, deps), exits };
    } finally {
      process.exit = realExit;
    }
  }

  const base: SharedInstallReport = { globalDir: "/g", skipped: null, manifest: { dependencies: 3, external: 2 }, lockfile: { status: "ok", uncovered: [], path: "/g/bun.lock" }, jeoOnPath: [], leftovers: { backupFiles: [], possibleOrphans: [], orphanScanComplete: true }, sizes: { top: [], totalBytes: 0, scannedEntries: 0, complete: true, capped: null, elapsedMs: 0 } };

  /** Warning-laden: missing lock, a stale jeo, a backup file, every orphan kind, a capped size scan. */
  const warningReport: SharedInstallReport = {
    ...base,
    lockfile: { status: "missing", uncovered: ["a", "b"], path: "/g/bun.lock" },
    jeoOnPath: [
      { path: "/bin1/jeo", realpath: "/r1/cli.ts", version: "0.12.21", active: true, stale: false },
      { path: "/bin2/jeo", realpath: "/r2/cli.ts", version: "0.9.10", active: false, stale: true },
    ],
    leftovers: {
      backupFiles: ["package.json.jeopi-update-backup-x"],
      possibleOrphans: [
        { name: "@scope/orphan", kind: "directory" },
        { name: "live", kind: "symlink" },
        { name: "supercode", kind: "dangling-symlink" },
      ],
      orphanScanComplete: true,
    },
    sizes: { top: [{ name: "gajae-code", bytes: 9000 }], totalBytes: 9500, scannedEntries: 400_000, complete: false, capped: "entries", elapsedMs: 10 },
  };

  test("--json carries the injected report under sharedInstall as the last key, awaiting a promise", async () => {
    const lines = await runDoctor(["--json"], { sharedInstall: async () => warningReport });
    const parsed = JSON.parse(lines.join("\n"));
    expect(parsed.sharedInstall).toEqual(JSON.parse(JSON.stringify(warningReport)));
    expect(Object.keys(parsed).at(-1)).toBe("sharedInstall");
    expect(parsed.providers).toBeArray();
    expect(parsed.ready).toBe(false);
  });

  test("--json keeps sharedInstall last when the routing block is present", async () => {
    writeConfig({ routing: { enabled: true } });
    const parsed = JSON.parse((await runDoctor(["--json"], { sharedInstall: () => base })).join("\n"));
    expect(Object.keys(parsed).slice(-2)).toEqual(["routing", "sharedInstall"]);
  });

  test("the human block prints before [NOT READY]/[READY], after the routing block, and never contains [routing]", async () => {
    writeConfig({ routing: { enabled: true } });
    const notReady = plain((await runDoctor([], { sharedInstall: () => warningReport })).join("\n"));
    const sharedAt = notReady.indexOf("Shared install (/g):");
    expect(sharedAt).toBeGreaterThan(notReady.indexOf("Routing preview"));
    expect(sharedAt).toBeLessThan(notReady.indexOf("[NOT READY]"));
    const block = notReady.slice(sharedAt, notReady.indexOf("[NOT READY]"));
    expect(block).not.toContain("[routing]");

    writeConfig({ providers: { openai: "sk-test-key" } });
    const ready = plain((await runDoctor([], { sharedInstall: () => warningReport })).join("\n"));
    expect(ready.indexOf("Shared install (/g):")).toBeLessThan(ready.indexOf("[READY]"));
  });

  test("human text for a warning-laden report: lock, stale tag, backup file, the three orphan kinds, capped sizes", async () => {
    const text = plain((await runDoctor([], { sharedInstall: () => warningReport })).join("\n"));
    expect(text).toContain("Shared install (/g):");
    expect(text).toContain("  packages:  3 in manifest (2 besides jeo-code)");
    expect(text).toContain("  bun.lock:  MISSING - jeo update will refuse until it is restored (or pass --allow-unlocked-global)");
    expect(text).toContain("  jeo on PATH (first = active):");
    expect(text).toContain("    * /bin1/jeo  0.12.21 (active)");
    expect(text).toContain("      /bin2/jeo  0.9.10 [stale: older than active 0.12.21]");
    expect(text).toContain("  leftovers (not touched):");
    expect(text).toContain("    file    package.json.jeopi-update-backup-x");
    expect(text).toContain("    orphan  @scope/orphan (possible orphan)");
    expect(text).toContain("    orphan  live (possible orphan, symlink)");
    expect(text).toContain("    orphan  supercode (possible orphan, dangling symlink)");
    expect(text).toContain("  size scan stopped at the entry cap (400000 entries); figures are lower bounds");
    expect(text).toContain("gajae-code 8.8 KB");
  });

  test("a newer second jeo reads 'newer than active'; an equal or unknown version carries no stale tag", async () => {
    const report: SharedInstallReport = {
      ...base,
      jeoOnPath: [
        { path: "/a/jeo", realpath: "/a/cli.ts", version: "0.12.21", active: true, stale: false },
        { path: "/b/jeo", realpath: "/b/cli.ts", version: "0.13.0", active: false, stale: true },
        { path: "/c/jeo", realpath: "/c/cli.ts", version: "0.12.21", active: false, stale: false },
        { path: "/d/jeo", realpath: "/d/cli.ts", version: null, active: false, stale: false },
      ],
    };
    const text = plain((await runDoctor([], { sharedInstall: () => report })).join("\n"));
    expect(text).toContain("      /b/jeo  0.13.0 [stale: newer than active 0.12.21]");
    expect(text).toContain("      /c/jeo  0.12.21\n");
    expect(text).toContain("      /d/jeo  (version unknown)\n");
  });

  test("a real report capped by sizeCapEntries renders the cap message in the human block", async () => {
    const fixture = richFixture();
    const capped = collect(fixture.home, fixture.pathDirs, { sizeCapEntries: 3 });
    expect(capped.sizes).toMatchObject({ capped: "entries", complete: false, scannedEntries: 3 });
    const text = plain((await runDoctor([], { sharedInstall: () => capped })).join("\n"));
    expect(text).toContain("  size scan stopped at the entry cap (3 entries); figures are lower bounds");
    expect(text).not.toContain(" total");
  });

  test("every lock status and the time cap print their own line", async () => {
    const lockLine = async (lockfile: SharedInstallReport["lockfile"], manifest = base.manifest): Promise<string> =>
      plain((await runDoctor([], { sharedInstall: () => ({ ...base, lockfile, manifest }) })).join("\n"));
    expect(await lockLine({ status: "ok", uncovered: [], path: "/g/bun.lock" })).toContain("  bun.lock:  ok (2 of 2 covered)");
    expect(await lockLine({ status: "incomplete", uncovered: ["a", "b"], path: "/g/bun.lock" })).toContain("  bun.lock:  INCOMPLETE - no resolved entry for: a, b");
    expect(await lockLine({ status: "unreadable", uncovered: ["a", "b"], path: "/g/bun.lock", detail: "no packages map" })).toContain("  bun.lock:  UNREADABLE (no packages map)");
    expect(await lockLine({ status: "not-required", uncovered: [], path: "/g/bun.lock" }, { dependencies: 1, external: 0 })).toContain("  bun.lock:  not required (jeo-code is the only package)");

    const timeCapped: SharedInstallReport = { ...base, sizes: { top: [{ name: "x", bytes: 2048 }], totalBytes: 2048, scannedEntries: 10, complete: false, capped: "time", elapsedMs: 3100 } };
    const text = plain((await runDoctor([], { sharedInstall: () => timeCapped })).join("\n"));
    expect(text).toContain("  size scan stopped at the time cap (3000 ms); figures are lower bounds");
    expect(text).not.toContain(" total");
  });

  test("an incomplete orphan scan says so and a clean install says leftovers: none, plain size total", async () => {
    const incomplete: SharedInstallReport = { ...base, leftovers: { backupFiles: [], possibleOrphans: [], orphanScanComplete: false } };
    expect(plain((await runDoctor([], { sharedInstall: () => incomplete })).join("\n"))).toContain("    orphan scan stopped at its cap; no orphans reported");
    const clean: SharedInstallReport = { ...base, sizes: { top: [{ name: "gajae-code", bytes: 2 * 1024 * 1024 }, { name: "x", bytes: 1024 }], totalBytes: 3 * 1024 * 1024, scannedEntries: 5, complete: true, capped: null, elapsedMs: 1 } };
    const text = plain((await runDoctor([], { sharedInstall: () => clean })).join("\n"));
    expect(text).toContain("  leftovers: none");
    expect(text).toContain("  size: 3.0 MB total; top 2: gajae-code 2.0 MB, x 1.0 KB");
  });

  test("a skipped report prints one plain line and still lists jeo on PATH", async () => {
    const skipped: SharedInstallReport = {
      globalDir: null,
      skipped: "no-bun-global",
      manifest: null,
      lockfile: null,
      jeoOnPath: [{ path: "/bin/jeo", realpath: "/r/cli.ts", version: "0.12.21", active: true, stale: false }],
      leftovers: null,
      sizes: null,
    };
    const text = plain((await runDoctor([], { sharedInstall: () => skipped })).join("\n"));
    expect(text).toContain("Shared install: no usable bun global (no-bun-global); lockfile, leftover and size checks skipped.");
    expect(text).toContain("    * /bin/jeo  0.12.21 (active)");
    const block = text.slice(text.indexOf("Shared install:"), text.indexOf("[NOT READY]"));
    const sectionLines = block.split("\n").map(line => line.trimStart());
    expect(sectionLines.some(line => /^(bun\.lock|packages|leftovers|size)\b/.test(line))).toBe(false);
  });

  test("a failing check prints one yellow line, puts { error } in the JSON, and still reaches the verdict", async () => {
    const human = plain((await runDoctor([], { sharedInstall: () => { throw new Error("boom"); } })).join("\n"));
    expect(human.match(/Shared install: check failed \(boom\)/g)).toHaveLength(1);
    expect(human).toContain("[NOT READY]");
    const json = JSON.parse((await runDoctor(["--json"], { sharedInstall: async () => { throw new Error("async boom"); } })).join("\n"));
    expect(json.sharedInstall).toEqual({ error: "async boom" });
    expect(json.ready).toBe(false);
  });

  test("strict is unchanged: not ready + --strict exits 1 exactly once, even with a warning-laden or failing report", async () => {
    for (const deps of [{ sharedInstall: () => warningReport }, { sharedInstall: () => { throw new Error("boom"); } }] satisfies DoctorDeps[]) {
      expect((await runWithExitStub(["--strict"], deps)).exits).toEqual([1]);
      expect((await runWithExitStub(["--strict", "--json"], deps)).exits).toEqual([1]);
      expect((await runWithExitStub([], deps)).exits).toEqual([]);
    }
  });

  test("strict is unchanged: ready + --strict with a warning-laden report never exits", async () => {
    writeConfig({ providers: { openai: "sk-test-key" } });
    const human = await runWithExitStub(["--strict"], { sharedInstall: () => warningReport });
    expect(human.exits).toEqual([]);
    expect(plain(human.lines.join("\n"))).toContain("[READY]");
    const json = await runWithExitStub(["--strict", "--json"], { sharedInstall: () => warningReport });
    expect(json.exits).toEqual([]);
    expect(JSON.parse(json.lines.join("\n")).ready).toBe(true);
  });

  test("read-only: the fixture global, PATH dirs and installs hash identically before and after doctor (human and --json)", async () => {
    const fixture = richFixture();
    const sharedInstall = (): SharedInstallReport => collect(fixture.home, fixture.pathDirs);
    const before = hashTree([fixture.fx]);
    const human = plain((await runDoctor([], { sharedInstall })).join("\n"));
    const json = JSON.parse((await runDoctor(["--json"], { sharedInstall })).join("\n"));
    expect(hashTree([fixture.fx])).toBe(before);

    // The real collector's report, rendered: the AC-14 style assertions on a fixture.
    expect(human).toContain(`Shared install (${fixture.dir}):`);
    expect(human).toContain("bun.lock:  ok");
    expect(human).toContain(`    * ${fixture.active}  0.12.21 (active)`);
    expect(human).toContain(`      ${fixture.stale}  0.9.10 [stale: older than active 0.12.21]`);
    expect(human).toContain("package.json.jeopi-update-backup-71pfjiiu");
    expect(human).toContain("orphan  supercode (possible orphan, dangling symlink)");
    expect(human).toContain("orphan  @scope/orphan (possible orphan)");
    expect(human).toContain("gajae-code");
    expect(human.indexOf("size:")).toBeLessThan(human.indexOf("[NOT READY]"));

    const report = json.sharedInstall;
    expect(report.lockfile.status).toBe("ok");
    expect(report.jeoOnPath.map((e: { path: string; version: string; active: boolean; stale: boolean }) => [e.path, e.version, e.active, e.stale])).toEqual([
      [fixture.active, "0.12.21", true, false],
      [fixture.stale, "0.9.10", false, true],
    ]);
    expect(report.leftovers.backupFiles).toEqual(["package.json.jeopi-update-backup-71pfjiiu"]);
    expect(report.leftovers.possibleOrphans).toEqual([
      { name: "@scope/orphan", kind: "directory" },
      { name: "supercode", kind: "dangling-symlink" },
    ]);
    expect(report.sizes.top[0]).toMatchObject({ name: "gajae-code", bytes: expect.any(Number) });
    expect(report.sizes).toMatchObject({ capped: null, complete: true });
  });

  describe("default dependency", () => {
    const ENV_KEYS = ["HOME", "BUN_INSTALL", "BUN_INSTALL_GLOBAL_DIR", "XDG_CONFIG_HOME", "PATH"];
    const savedEnv: Record<string, string | undefined> = {};
    const realNow = Date.now;

    beforeEach(() => {
      for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    });

    afterEach(() => {
      Date.now = realNow;
      for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    });

    async function lockStatus(): Promise<string | undefined> {
      const json = JSON.parse((await runDoctor(["--json"], {})).join("\n"));
      return json.sharedInstall.lockfile?.status;
    }

    test("is memoized for 30 s per environment: a changed PATH or an expired TTL rescans, the same key does not", async () => {
      const fixture = richFixture();
      const lock = path.join(fixture.dir, "bun.lock");
      const savedLock = fs.readFileSync(lock, "utf8");
      process.env.HOME = fixture.home;
      process.env.BUN_INSTALL = path.join(fixture.home, ".bun");
      delete process.env.BUN_INSTALL_GLOBAL_DIR;
      delete process.env.XDG_CONFIG_HOME;
      process.env.PATH = fixture.pathDirs[0] ?? "";

      expect(await lockStatus()).toBe("ok");
      fs.rmSync(lock);
      expect(await lockStatus()).toBe("ok");

      process.env.PATH = fixture.pathDirs.slice(0, 2).join(path.delimiter);
      expect(await lockStatus()).toBe("missing");
      fs.writeFileSync(lock, savedLock);
      expect(await lockStatus()).toBe("missing");

      Date.now = () => realNow() + 31_000;
      expect(await lockStatus()).toBe("ok");
    });

    test("on a machine without a bun global it reports skipped without throwing", async () => {
      const home = mk("empty-home");
      process.env.HOME = home;
      process.env.BUN_INSTALL = path.join(home, ".bun");
      delete process.env.BUN_INSTALL_GLOBAL_DIR;
      delete process.env.XDG_CONFIG_HOME;
      process.env.PATH = path.join(home, "no-bin");
      const json = JSON.parse((await runDoctor(["--json"], {})).join("\n"));
      expect(json.sharedInstall).toMatchObject({ globalDir: null, skipped: "no-bun-global", jeoOnPath: [] });
    });
  });
});
