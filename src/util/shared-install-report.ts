/**
 * Doctor-side, read-only report on the shared bun global install that `jeo update` writes into:
 * `bun.lock` coverage, every `jeo` on PATH with its version, leftovers a previous tool left behind
 * (backup files, possible orphans) and where the disk space goes.
 *
 * Everything here only reads. Nothing is written, deleted, renamed, spawned or executed, and a
 * symlink inside `node_modules` is never followed or read (one existence check tells a live link
 * from a dangling one). Findings are reported for a human; nothing is repaired.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  SELF_PACKAGE,
  checkLockCoverage,
  listJeoOnPath,
  locateSharedGlobal,
  readManifestDeps,
  type EnvLike,
  type GlobalSkipReason,
  type JeoOnPath,
  type LockCoverage,
} from "./shared-global";

export const DEFAULT_SIZE_CAP_MS = 3000;
export const DEFAULT_SIZE_CAP_ENTRIES = 400_000;
export const DEFAULT_ORPHAN_CAP_MANIFESTS = 5000;

/** Size scans read the clock every this many entries (and before the first one). */
const TIME_CHECK_EVERY = 256;
const TOP_PACKAGES = 5;
/** A `jeo` executable is the entry script inside its package: the package.json is in its directory or up to this many parents above. */
const VERSION_WALK_PARENTS = 4;
const BACKUP_FILE = /^package\.json\..*backup/;
const DECLARING_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

export interface JeoOnPathEntry extends JeoOnPath {
  version: string | null;
  active: boolean;
  stale: boolean;
}

export interface PossibleOrphan {
  name: string;
  kind: "directory" | "symlink" | "dangling-symlink";
}

export interface LeftoverReport {
  backupFiles: string[];
  possibleOrphans: PossibleOrphan[];
  orphanScanComplete: boolean;
}

export interface SizeReport {
  top: { name: string; bytes: number }[];
  totalBytes: number;
  scannedEntries: number;
  complete: boolean;
  capped: "time" | "entries" | null;
  elapsedMs: number;
}

export interface SharedInstallReport {
  globalDir: string | null;
  skipped: GlobalSkipReason | null;
  manifest: { dependencies: number; external: number } | null;
  lockfile: LockCoverage | null;
  jeoOnPath: JeoOnPathEntry[];
  leftovers: LeftoverReport | null;
  sizes: SizeReport | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function readPackageJson(file: string): Record<string, unknown> | null {
  try {
    const doc: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecord(doc) ? doc : null;
  } catch {
    return null;
  }
}

function sortedDirents(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => byName(a.name, b.name));
  } catch {
    return [];
  }
}

/** Version of the jeo-code package that owns this `jeo` entry script, read from the package.json next to it. */
function jeoPackageVersionNear(realpath: string): string | null {
  let dir = path.dirname(realpath);
  for (let level = 0; level <= VERSION_WALK_PARENTS; level++) {
    const pkg = readPackageJson(path.join(dir, "package.json"));
    if (pkg !== null && pkg.name === SELF_PACKAGE && typeof pkg.version === "string") return pkg.version;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Every `jeo` on PATH (deduplicated by realpath, PATH order) with the version of the package it belongs to.
 * The first is the active one; a later one is stale when both versions are known and differ. Nothing is run.
 */
export function listJeoOnPathWithVersions(env: EnvLike = process.env, platform: NodeJS.Platform = process.platform): JeoOnPathEntry[] {
  const found = listJeoOnPath(env, platform);
  const versions = found.map(entry => jeoPackageVersionNear(entry.realpath));
  const activeVersion = versions[0] ?? null;
  return found.map((entry, index) => {
    const version = versions[index] ?? null;
    return {
      ...entry,
      version,
      active: index === 0,
      stale: index > 0 && version !== null && activeVersion !== null && version !== activeVersion,
    };
  });
}

interface InstalledPackage {
  name: string;
  abs: string;
  kind: PossibleOrphan["kind"];
}

function classify(entry: fs.Dirent, abs: string): PossibleOrphan["kind"] | null {
  if (entry.isSymbolicLink()) return fs.existsSync(abs) ? "symlink" : "dangling-symlink";
  return entry.isDirectory() ? "directory" : null;
}

/** Non-dot packages directly inside a node_modules dir, scoped packages flattened to `@scope/name`. */
function listPackages(nodeModules: string): InstalledPackage[] {
  const out: InstalledPackage[] = [];
  for (const entry of sortedDirents(nodeModules)) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(nodeModules, entry.name);
    const kind = classify(entry, abs);
    if (kind === null) continue;
    if (kind !== "directory" || !entry.name.startsWith("@")) {
      out.push({ name: entry.name, abs, kind });
      continue;
    }
    for (const child of sortedDirents(abs)) {
      if (child.name.startsWith(".")) continue;
      const childAbs = path.join(abs, child.name);
      const childKind = classify(child, childAbs);
      if (childKind !== null) out.push({ name: `${entry.name}/${child.name}`, abs: childAbs, kind: childKind });
    }
  }
  return out;
}

/**
 * Names that some installed package declares (dependencies, optionalDependencies, peerDependencies),
 * collected from every package.json under node_modules, nested copies included. Symlinked packages
 * are never descended into or read. Null when more than `cap` manifests would have to be read.
 */
function collectDeclared(packages: readonly InstalledPackage[], cap: number): Set<string> | null {
  const declared = new Set<string>();
  const pending = packages.filter(p => p.kind === "directory").map(p => p.abs);
  let read = 0;
  for (let abs = pending.pop(); abs !== undefined; abs = pending.pop()) {
    if (read >= cap) return null;
    read++;
    const pkg = readPackageJson(path.join(abs, "package.json"));
    if (pkg !== null) {
      for (const field of DECLARING_FIELDS) {
        const deps = pkg[field];
        if (isRecord(deps)) for (const name of Object.keys(deps)) declared.add(name);
      }
    }
    for (const nested of listPackages(path.join(abs, "node_modules"))) {
      if (nested.kind === "directory") pending.push(nested.abs);
    }
  }
  return declared;
}

/**
 * Leftovers of other tools in the global dir: `package.json.*backup*` files, and installed top-level
 * packages that neither the manifest nor any installed package declares ("possible orphans"; a dot-prefixed
 * entry is never reported). When the declared-name scan would exceed `capManifests` no orphan is reported
 * and `orphanScanComplete` is false.
 */
export function findStaleLeftovers(dir: string, manifestNames: readonly string[], capManifests: number = DEFAULT_ORPHAN_CAP_MANIFESTS): LeftoverReport {
  const backupFiles = sortedDirents(dir)
    .filter(entry => entry.isFile() && BACKUP_FILE.test(entry.name))
    .map(entry => entry.name);
  const nodeModules = path.join(dir, "node_modules");
  const inManifest = new Set(manifestNames);
  const packages = listPackages(nodeModules);
  const candidates = packages.filter(p => !inManifest.has(p.name));
  if (candidates.length === 0) return { backupFiles, possibleOrphans: [], orphanScanComplete: true };
  const declared = collectDeclared(packages, capManifests);
  if (declared === null) return { backupFiles, possibleOrphans: [], orphanScanComplete: false };
  const possibleOrphans = candidates
    .filter(p => !declared.has(p.name))
    .map(({ name, kind }): PossibleOrphan => ({ name, kind }))
    .sort((a, b) => byName(a.name, b.name));
  return { backupFiles, possibleOrphans, orphanScanComplete: true };
}

interface WalkFrame {
  dir: string;
  level: "root" | "scope" | "package";
  scope: string;
  /** Top-level package the directory belongs to; null for dot entries and stray files, which only count toward the total. */
  pkg: string | null;
}

/**
 * Apparent bytes under `dir/node_modules`, attributed to the top-level package (scoped flattened) that holds them.
 * Symlinks count their own size and are never followed; a directory counts as one entry and no bytes. The walk
 * stops at the entry cap (checked on every entry) or the time cap (checked before the first entry and every 256
 * entries); a stopped scan returns lower bounds with `complete: false`.
 */
export function sizeReport(dir: string, o: { now?: () => number; capMs?: number; capEntries?: number } = {}): SizeReport {
  const now = o.now ?? Date.now;
  const capMs = o.capMs ?? DEFAULT_SIZE_CAP_MS;
  const capEntries = o.capEntries ?? DEFAULT_SIZE_CAP_ENTRIES;
  const started = now();
  const bytesByPackage = new Map<string, number>();
  let totalBytes = 0;
  let scanned = 0;
  let capped: SizeReport["capped"] = null;
  const stack: WalkFrame[] = [{ dir: path.join(dir, "node_modules"), level: "root", scope: "", pkg: null }];
  walk: for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    for (const entry of sortedDirents(frame.dir)) {
      if (scanned >= capEntries) {
        capped = "entries";
        break walk;
      }
      if (scanned % TIME_CHECK_EVERY === 0 && now() - started > capMs) {
        capped = "time";
        break walk;
      }
      scanned++;
      const abs = path.join(frame.dir, entry.name);
      const isDir = entry.isDirectory();
      let pkg = frame.pkg;
      if (frame.level === "root") pkg = entry.name.startsWith(".") || (!isDir && !entry.isSymbolicLink()) ? null : entry.name;
      else if (frame.level === "scope") pkg = entry.name.startsWith(".") ? null : `${frame.scope}/${entry.name}`;
      if (isDir) {
        if (frame.level === "root" && entry.name.startsWith("@")) {
          stack.push({ dir: abs, level: "scope", scope: entry.name, pkg: null });
        } else {
          stack.push({ dir: abs, level: "package", scope: "", pkg });
          if (pkg !== null && !bytesByPackage.has(pkg)) bytesByPackage.set(pkg, 0);
        }
        continue;
      }
      let size = 0;
      try {
        size = fs.lstatSync(abs).size;
      } catch {
        // A file that vanished mid-scan counts as zero bytes.
      }
      totalBytes += size;
      if (pkg !== null) bytesByPackage.set(pkg, (bytesByPackage.get(pkg) ?? 0) + size);
    }
  }
  const top = [...bytesByPackage]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => b.bytes - a.bytes || byName(a.name, b.name))
    .slice(0, TOP_PACKAGES);
  return { top, totalBytes, scannedEntries: scanned, complete: capped === null, capped, elapsedMs: now() - started };
}

/**
 * One read-only snapshot for `jeo doctor`. The `jeo` executables on PATH are always listed; when no usable
 * bun global exists the report says why (`skipped`) and leaves the other sections null. File-system errors
 * degrade to empty findings instead of throwing.
 */
export function collectSharedInstallReport(
  o: {
    env?: EnvLike;
    home?: string;
    platform?: NodeJS.Platform;
    entry?: string;
    execPath?: string;
    now?: () => number;
    sizeCapMs?: number;
    sizeCapEntries?: number;
    orphanCapManifests?: number;
  } = {},
): SharedInstallReport {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const jeoOnPath = listJeoOnPathWithVersions(env, platform);
  const located = locateSharedGlobal({ env, home: o.home, platform, entry: o.entry, execPath: o.execPath });
  const manifest = located.ok ? readManifestDeps(located.dir) : null;
  if (!located.ok || manifest === null || !manifest.ok) {
    const skipped: GlobalSkipReason = located.ok ? "manifest-unreadable" : located.reason;
    return { globalDir: null, skipped, manifest: null, lockfile: null, jeoOnPath, leftovers: null, sizes: null };
  }
  const { names, external } = manifest.deps;
  return {
    globalDir: located.dir,
    skipped: null,
    manifest: { dependencies: names.length, external: external.length },
    lockfile: checkLockCoverage(located.dir, external),
    jeoOnPath,
    leftovers: findStaleLeftovers(located.dir, names, o.orphanCapManifests),
    sizes: sizeReport(located.dir, { now: o.now, capMs: o.sizeCapMs, capEntries: o.sizeCapEntries }),
  };
}
