/**
 * AC-8 / AC-9 / AC-10 replica check: `jeo update` and `jeopi update` must not disturb each other
 * inside the shared bun global (`~/.bun/install/global`), and `jeo update` must refuse before it
 * runs any installer when the global lost its `bun.lock`.
 *
 * Usage: bun scripts/verify-shared-global-isolation.ts [--keep] [--only jeo-to-jeopi,jeopi-to-jeo,lockfile-loss]
 *          [--target V] [--seed V] [--real-global DIR] [--with-unlocked]
 *
 * It builds a sandbox under the OS tmpdir from a copy of the REAL global manifest + REAL bun.lock and a
 * copy-on-write clone of the REAL node_modules (never a package manager run against the real dir), then
 * drives THIS tree's `src/cli.ts update` and the replica's real `jeopi update` against published
 * versions only (network, ~2 GB cloned, ~3 minutes; not part of CI). A logging shim first on the
 * sandbox PATH records every `bun` call, so "no installer ran" is a mechanical fact, not an inference.
 * A tripwire proves the real global, the real bun cache and ~/.jeopi were not touched.
 *
 * Exit codes: 0 every asserted phase passed; 1 an assertion failed; 2 inconclusive (missing
 * prerequisite, registry unreachable, unfaithful seeding, or the lock-loss control did not reproduce
 * drift - a non-reproduced control is never a pass).
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const SANDBOX_PREFIX = "jeo-shared-global-";
export const SELF_PACKAGE = "jeo-code";
export const PHASES = ["jeo-to-jeopi", "jeopi-to-jeo", "lockfile-loss"] as const;
export type PhaseId = (typeof PHASES)[number];

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const REGISTRY = "https://registry.npmjs.org/";
const CHILD_TIMEOUT_MS = 300_000;
const CONTROL_TIMEOUT_MS = 600_000;
const MIN_FREE_BYTES = 3 * 1024 ** 3;
/** First tokens of a package-manager invocation; shebang calls (`bun <script>`, `--version`) start with something else. */
const PM_TOKENS: Record<string, true> = {
  install: true, i: true, add: true, a: true, remove: true, rm: true,
  update: true, upgrade: true, link: true, unlink: true, pm: true,
};
/** Network settings only; they do not weaken the isolation (no bun/npm/XDG variable is forwarded). */
const NETWORK_ENV = [
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
] as const;

const USAGE = `Usage: bun scripts/verify-shared-global-isolation.ts [options]

  --keep                 keep the sandbox even when every phase passes
  --only A,B,...         run only these phases: ${PHASES.join(", ")}
  --target V             jeo-code version the replica moves to (default: highest published below this tree)
  --seed V               jeo-code version the replica starts at (default: highest published below the target)
  --real-global DIR      real shared bun global to copy from (default: $BUN_INSTALL_GLOBAL_DIR or \${BUN_INSTALL:-~/.bun}/install/global)
  --with-unlocked        also run phase D: update --allow-unlocked-global on the lock-less replica (runs last)
  -h, --help             show this help

Exit codes: 0 all asserted phases pass; 1 an assertion failed; 2 inconclusive (prerequisite, registry, seeding, control).`;

export class Inconclusive extends Error {}
export class UsageError extends Error {}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errCode(err: unknown): string | undefined {
  return err !== null && typeof err === "object" && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

export interface Options {
  keep: boolean;
  withUnlocked: boolean;
  help: boolean;
  only: readonly PhaseId[];
  target?: string;
  seed?: string;
  realGlobal?: string;
}

function isPhase(value: string): value is PhaseId {
  return (PHASES as readonly string[]).includes(value);
}

export function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { keep: false, withUnlocked: false, help: false, only: [...PHASES] };
  let i = 0;
  while (i < argv.length) {
    const raw = argv[i++]!;
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? undefined : raw.slice(eq + 1);
    const takeValue = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[i];
      if (next === undefined || next.startsWith("--")) throw new UsageError(`${flag} needs a value`);
      i++;
      return next;
    };
    switch (flag) {
      case "--keep": opts.keep = true; break;
      case "--with-unlocked": opts.withUnlocked = true; break;
      case "-h": case "--help": opts.help = true; break;
      case "--only": {
        const names = takeValue().split(",").map(name => name.trim()).filter(Boolean);
        if (names.length === 0) throw new UsageError("--only needs at least one phase");
        const picked: PhaseId[] = [];
        for (const name of names) {
          if (!isPhase(name)) throw new UsageError(`unknown phase "${name}" (expected ${PHASES.join(", ")})`);
          if (!picked.includes(name)) picked.push(name);
        }
        opts.only = PHASES.filter(phase => picked.includes(phase));
        break;
      }
      case "--target": case "--seed": {
        const value = takeValue();
        if (!VERSION_RE.test(value)) throw new UsageError(`${flag} "${value}" is not x.y.z`);
        if (flag === "--target") opts.target = value; else opts.seed = value;
        break;
      }
      case "--real-global": opts.realGlobal = path.resolve(takeValue()); break;
      default: throw new UsageError(`unknown argument: ${raw}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------

export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Stable x.y.z keys of a registry document's `versions`, ascending. */
export function stableVersions(doc: unknown): string[] {
  if (!isRecord(doc) || !isRecord(doc.versions)) return [];
  return Object.keys(doc.versions).filter(v => VERSION_RE.test(v)).sort(compareSemver);
}

async function fetchPublished(name: string): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${REGISTRY}${encodeURIComponent(name)}`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Inconclusive(`registry unreachable while reading ${name}: ${message(err)}`);
  }
  if (!res.ok) throw new Inconclusive(`registry answered HTTP ${res.status} for ${name}`);
  let doc: unknown;
  try { doc = await res.json(); } catch (err) { throw new Inconclusive(`registry returned unreadable JSON for ${name}: ${message(err)}`); }
  const versions = stableVersions(doc);
  if (versions.length === 0) throw new Inconclusive(`registry lists no stable versions of ${name}`);
  return versions;
}

export interface PickedVersions { target: string; seed: string }

/** target = highest published below the tree version, seed = highest published below the target (overrides must be published). */
export function pickVersions(published: readonly string[], tree: string, override: { target?: string; seed?: string }): PickedVersions {
  if (!VERSION_RE.test(tree)) throw new Inconclusive(`this tree's version "${tree}" is not x.y.z`);
  const target = override.target ?? published.filter(v => compareSemver(v, tree) < 0).at(-1);
  if (!target) throw new Inconclusive(`no published ${SELF_PACKAGE} version below ${tree}`);
  if (!published.includes(target)) throw new Inconclusive(`target ${SELF_PACKAGE}@${target} is not published`);
  if (target === tree) {
    throw new Inconclusive(`target ${target} equals this tree's version; "already at the pinned version" would test nothing`);
  }
  const seed = override.seed ?? published.filter(v => compareSemver(v, target) < 0).at(-1);
  if (!seed) throw new Inconclusive(`no published ${SELF_PACKAGE} version below the target ${target}`);
  if (!published.includes(seed)) throw new Inconclusive(`seed ${SELF_PACKAGE}@${seed} is not published`);
  if (seed === target) throw new Inconclusive(`seed and target are both ${seed}; the replica would not move`);
  return { target, seed };
}

// ---------------------------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------------------------

export interface Sandbox {
  root: string;
  installDir: string;
  globalDir: string;
  nodeModules: string;
  homeDir: string;
  shimsDir: string;
  tmpDir: string;
  binDir: string;
  bunLog: string;
  npmLog: string;
  ctlDir: string;
}

export function sandboxPaths(root: string): Sandbox {
  const installDir = path.join(root, "install");
  const globalDir = path.join(installDir, "global");
  return {
    root, installDir, globalDir,
    nodeModules: path.join(globalDir, "node_modules"),
    homeDir: path.join(root, "home"),
    shimsDir: path.join(root, "shims"),
    tmpDir: path.join(root, "tmp"),
    binDir: path.join(root, "bin"),
    bunLog: path.join(root, "bun.log"),
    npmLog: path.join(root, "npm.log"),
    ctlDir: path.join(root, "ctl"),
  };
}

export function createSandbox(base = os.tmpdir()): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(base), SANDBOX_PREFIX)));
  const sb = sandboxPaths(root);
  for (const dir of [sb.globalDir, path.join(sb.homeDir, ".jeo"), sb.shimsDir, sb.tmpDir, sb.binDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return sb;
}

/**
 * The only door to deletion: `target` must be a real directory (not a symlink) that is a direct child of
 * `base` and whose name carries SANDBOX_PREFIX. Returns the resolved path, or null when it does not exist.
 */
export function assertRemovableSandbox(target: string, base = os.tmpdir()): string | null {
  const abs = path.resolve(target);
  let realParent: string;
  let realBase: string;
  try {
    realParent = fs.realpathSync(path.dirname(abs));
    realBase = fs.realpathSync(base);
  } catch (err) {
    throw new Error(`refusing to remove ${abs}: cannot resolve its parent (${message(err)})`);
  }
  if (realParent !== realBase) throw new Error(`refusing to remove ${abs}: not a direct child of ${realBase}`);
  const name = path.basename(abs);
  if (!name.startsWith(SANDBOX_PREFIX) || name.length <= SANDBOX_PREFIX.length) {
    throw new Error(`refusing to remove ${abs}: name does not start with ${SANDBOX_PREFIX}`);
  }
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch (err) {
    if (errCode(err) === "ENOENT") return null;
    throw err;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`refusing to remove ${abs}: not a real directory`);
  return abs;
}

export function removeSandbox(target: string, base = os.tmpdir()): void {
  const abs = assertRemovableSandbox(target, base);
  if (abs !== null) fs.rmSync(abs, { recursive: true, force: true });
}

/** Removes `child` only when it lies strictly inside a valid sandbox `root`. */
export function removeWithin(root: string, child: string, base = os.tmpdir()): void {
  const abs = assertRemovableSandbox(root, base);
  if (abs === null) return;
  const rel = path.relative(abs, path.resolve(child));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`refusing to remove ${child}: not inside ${abs}`);
  fs.rmSync(child, { recursive: true, force: true });
}

const BUN_SHIM = `#!/bin/sh
printf '%s\\n' "$*" >> "$SG_BUN_LOG"
exec "$REAL_BUN" "$@"
`;

/** Blocks any npm fallback inside the sandbox (and on hosts that ship /usr/bin/npm) while recording the attempt. */
const NPM_SHIM = `#!/bin/sh
printf '%s\\n' "$*" >> "$SG_NPM_LOG"
echo "npm is blocked inside the shared-global replica sandbox" >&2
exit 127
`;

export function writeShims(sb: Sandbox): void {
  for (const [name, body] of [["bun", BUN_SHIM], ["npm", NPM_SHIM]] as const) {
    const file = path.join(sb.shimsDir, name);
    fs.writeFileSync(file, body);
    fs.chmodSync(file, 0o755);
  }
}

/** Child environment built from scratch: nothing of the real HOME, bun, npm or XDG settings leaks in. */
export function sandboxEnv(sb: Sandbox, realBun: string, source: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const env: Record<string, string> = {
    HOME: sb.homeDir,
    BUN_INSTALL: sb.root,
    JEO_CONFIG_DIR: path.join(sb.homeDir, ".jeo"),
    TMPDIR: sb.tmpDir,
    NO_COLOR: "1",
    CI: "1",
    SG_BUN_LOG: sb.bunLog,
    SG_NPM_LOG: sb.npmLog,
    REAL_BUN: realBun,
    PATH: [sb.shimsDir, sb.binDir, "/usr/bin", "/bin"].join(":"),
  };
  for (const key of NETWORK_ENV) {
    const value = source[key];
    if (value) env[key] = value;
  }
  return env;
}

/** Copy-on-write where the platform has it, a plain recursive copy otherwise; symlinks are copied, never followed. */
export function cloneTree(src: string, dest: string, root: string): void {
  const cp = Bun.which("cp") ?? "/bin/cp";
  const attempts = process.platform === "darwin"
    ? [["-c", "-R", "-P"], ["-R", "-P"]]
    : [["--reflink=auto", "-a"], ["-R", "-P"]];
  let lastError = "";
  for (const flags of attempts) {
    const result = Bun.spawnSync([cp, ...flags, src, dest], { stdout: "pipe", stderr: "pipe" });
    if (result.success) return;
    lastError = new TextDecoder().decode(result.stderr).trim() || `cp exited ${result.exitCode}`;
    removeWithin(root, dest);
  }
  throw new Inconclusive(`could not clone ${src} to ${dest}: ${lastError}`);
}

// ---------------------------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------------------------

/** relative path with `/node_modules/` nesting -> package.json version | `<no-manifest>` | `symlink->TARGET`; names starting '.' skipped. */
export type Snapshot = Map<string, string>;

export interface Diff { key: string; before: string | null; after: string | null }

function readVersion(dir: string): string {
  let text: string;
  try { text = fs.readFileSync(path.join(dir, "package.json"), "utf8"); } catch (err) {
    return errCode(err) === "ENOENT" ? "<no-manifest>" : "<unreadable>";
  }
  try {
    const doc: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    return isRecord(doc) && typeof doc.version === "string" ? doc.version : "<no-version>";
  } catch {
    return "<unreadable>";
  }
}

function walkModules(dir: string, prefix: string, out: Snapshot): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) {
    if (errCode(err) === "ENOENT" || errCode(err) === "ENOTDIR") return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    const key = prefix + entry.name;
    if (entry.isSymbolicLink()) { out.set(key, `symlink->${fs.readlinkSync(full)}`); continue; }
    if (!entry.isDirectory()) { out.set(key, "<file>"); continue; }
    if (entry.name.startsWith("@")) { walkModules(full, `${key}/`, out); continue; }
    out.set(key, readVersion(full));
    walkModules(path.join(full, "node_modules"), `${key}/node_modules/`, out);
  }
}

export function snapshotTree(nodeModules: string): Snapshot {
  const out: Snapshot = new Map();
  walkModules(nodeModules, "", out);
  return out;
}

export function diffSnapshots(before: Snapshot, after: Snapshot): Diff[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  const diffs: Diff[] = [];
  for (const key of [...keys].sort()) {
    const b = before.get(key) ?? null;
    const a = after.get(key) ?? null;
    if (b !== a) diffs.push({ key, before: b, after: a });
  }
  return diffs;
}

/** `jeo-code` itself and everything nested under it. */
export function isSelfKey(key: string): boolean {
  return key === SELF_PACKAGE || key.startsWith(`${SELF_PACKAGE}/node_modules/`);
}

export function isJeopiKey(key: string): boolean {
  return key.startsWith("jeopi-");
}

/** A real installed version, as opposed to a marker such as `<no-manifest>` or `symlink->...`. */
function realVersion(value: string | undefined): string | null {
  return value !== undefined && /^\d/.test(value) ? value : null;
}

export function topLevelNames(dir: string): string[] {
  const names: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      for (const child of fs.readdirSync(path.join(dir, entry.name))) names.push(`${entry.name}/${child}`);
    } else {
      names.push(entry.name);
    }
  }
  return names.sort();
}

function sha256(file: string): string | null {
  try { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch (err) {
    if (errCode(err) === "ENOENT") return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Tables, logs
// ---------------------------------------------------------------------------------------------

export function formatTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(row => (row[i] ?? "").length)));
  const line = (cells: readonly string[]): string => `  ${cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd()}`;
  return [line(header), line(widths.map(w => "-".repeat(w))), ...rows.map(line)].join("\n");
}

export interface Comparison { table: string; changed: Diff[]; unexpected: Diff[] }

const MAX_LISTED_EXPECTED = 14;
const MAX_LISTED_UNEXPECTED = 40;

/** package | before | after | verdict for `names`, then every other changed key; `allowed` says which changes are expected. */
export function compareForTable(
  names: readonly string[], before: Snapshot, after: Snapshot,
  allowed: (key: string) => boolean, changedLabel = "changed (expected)",
): Comparison {
  const diffs = diffSnapshots(before, after);
  const changedKeys = new Set(diffs.map(d => d.key));
  const rows: string[][] = [];
  for (const name of names) {
    const verdict = !changedKeys.has(name) ? "same" : allowed(name) ? changedLabel : "CHANGED (unexpected)";
    rows.push([name, before.get(name) ?? "-", after.get(name) ?? "-", verdict]);
  }
  const named = new Set(names);
  const extras = diffs.filter(d => !named.has(d.key));
  const unexpectedExtras = extras.filter(d => !allowed(d.key));
  const expectedExtras = extras.filter(d => allowed(d.key));
  for (const d of unexpectedExtras.slice(0, MAX_LISTED_UNEXPECTED)) rows.push([d.key, d.before ?? "-", d.after ?? "-", "CHANGED (unexpected)"]);
  if (unexpectedExtras.length > MAX_LISTED_UNEXPECTED) rows.push([`... ${unexpectedExtras.length - MAX_LISTED_UNEXPECTED} more`, "", "", "CHANGED (unexpected)"]);
  for (const d of expectedExtras.slice(0, MAX_LISTED_EXPECTED)) rows.push([d.key, d.before ?? "-", d.after ?? "-", changedLabel]);
  if (expectedExtras.length > MAX_LISTED_EXPECTED) rows.push([`... ${expectedExtras.length - MAX_LISTED_EXPECTED} more keys`, "", "", changedLabel]);
  return {
    table: formatTable(["package", "before", "after", "verdict"], rows),
    changed: diffs,
    unexpected: diffs.filter(d => !allowed(d.key)),
  };
}

/** Lines of a bun.log whose first token is a package-manager command; shebang calls are ignored. */
export function packageManagerLines(log: string): string[] {
  return log.split("\n").map(line => line.trim()).filter(line => {
    const token = line.split(/\s+/)[0] ?? "";
    return Object.hasOwn(PM_TOKENS, token);
  });
}

export function isExpectedInstallLine(line: string, target: string): boolean {
  return line === `install -g ${SELF_PACKAGE}@${target}` || line === `install -g ${SELF_PACKAGE}@${target} --force`;
}

function readLog(file: string): string {
  try { return fs.readFileSync(file, "utf8"); } catch (err) {
    if (errCode(err) === "ENOENT") return "";
    throw err;
  }
}

function excerpt(text: string, max = 18): string {
  const lines = text.trim().split("\n");
  const shown = lines.slice(-max).map(line => `    | ${line}`);
  return (lines.length > max ? [`    | ... (${lines.length - max} earlier lines)`, ...shown] : shown).join("\n");
}

// ---------------------------------------------------------------------------------------------
// Real-state tripwire
// ---------------------------------------------------------------------------------------------

export interface RealState {
  manifestHash: string | null;
  lockHash: string | null;
  names: string[] | null;
  cacheEntries: number | null;
  jeopiTop: string[] | null;
  jeopiAgent: string[] | null;
}

function listNames(dir: string, skip?: RegExp): string[] | null {
  try {
    const names = fs.readdirSync(dir);
    return (skip ? names.filter(name => !skip.test(name)) : names).sort();
  } catch (err) {
    if (errCode(err) === "ENOENT") return null;
    throw err;
  }
}

/** SQLite side files come and go while a host session is open; they say nothing about this script. */
const TRANSIENT_DB_FILES = /-(wal|shm|journal)$/;

export function captureRealState(globalDir: string, cacheDir: string, jeopiDir: string): RealState {
  let names: string[] | null = null;
  try { names = topLevelNames(path.join(globalDir, "node_modules")); } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }
  return {
    manifestHash: sha256(path.join(globalDir, "package.json")),
    lockHash: sha256(path.join(globalDir, "bun.lock")),
    names,
    cacheEntries: listNames(cacheDir)?.length ?? null,
    jeopiTop: listNames(jeopiDir, TRANSIENT_DB_FILES),
    jeopiAgent: listNames(path.join(jeopiDir, "agent"), TRANSIENT_DB_FILES),
  };
}

function nameDelta(label: string, before: readonly string[] | null, after: readonly string[] | null): string[] {
  const b = new Set(before ?? []);
  const a = new Set(after ?? []);
  const added = [...a].filter(name => !b.has(name));
  const removed = [...b].filter(name => !a.has(name));
  if (added.length === 0 && removed.length === 0 && (before === null) === (after === null)) return [];
  const show = (items: string[]): string => items.slice(0, 5).join(", ") + (items.length > 5 ? ", ..." : "");
  return [`${label}: added [${show(added)}] removed [${show(removed)}]`];
}

/** Violations only; empty means the real global, the real cache (no drop) and ~/.jeopi look untouched. */
export function compareRealState(before: RealState, after: RealState): string[] {
  const violations: string[] = [];
  if (before.manifestHash !== after.manifestHash) violations.push("real global package.json changed");
  if (before.lockHash !== after.lockHash) violations.push("real global bun.lock changed");
  violations.push(...nameDelta("real global node_modules top-level names", before.names, after.names));
  if (before.cacheEntries !== null && after.cacheEntries !== null && after.cacheEntries < before.cacheEntries) {
    violations.push(`real bun cache lost entries (${before.cacheEntries} -> ${after.cacheEntries})`);
  }
  violations.push(...nameDelta("~/.jeopi top-level names", before.jeopiTop, after.jeopiTop));
  violations.push(...nameDelta("~/.jeopi/agent top-level names", before.jeopiAgent, after.jeopiAgent));
  return violations;
}

// ---------------------------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------------------------

export interface Prereqs {
  repo: string;
  treeVersion: string;
  realBun: string;
  realHome: string;
  realGlobal: string;
  realCache: string;
  deps: Record<string, string>;
  externals: string[];
  jeopiNames: string[];
  target: string;
  seed: string;
  jeopiSeed: string | null;
}

export function locateRealGlobal(
  override: string | undefined, env: Readonly<Record<string, string | undefined>>, home: string,
): { globalDir: string; cacheDir: string } {
  const installRoot = env.BUN_INSTALL || path.join(home, ".bun");
  const globalDir = override ?? (env.BUN_INSTALL_GLOBAL_DIR ? path.resolve(env.BUN_INSTALL_GLOBAL_DIR) : path.join(installRoot, "install", "global"));
  const cacheDir = env.BUN_INSTALL_CACHE_DIR
    ? path.resolve(env.BUN_INSTALL_CACHE_DIR)
    : override || env.BUN_INSTALL_GLOBAL_DIR ? path.join(path.dirname(globalDir), "cache") : path.join(installRoot, "install", "cache");
  return { globalDir, cacheDir };
}

export function readDeps(manifestFile: string): Record<string, string> | null {
  let doc: unknown;
  try { doc = JSON.parse(fs.readFileSync(manifestFile, "utf8")); } catch { return null; }
  if (!isRecord(doc) || !isRecord(doc.dependencies)) return {};
  const deps: Record<string, string> = {};
  for (const [name, spec] of Object.entries(doc.dependencies)) if (typeof spec === "string") deps[name] = spec;
  return deps;
}

export async function checkPrerequisites(
  opts: Options, env: Readonly<Record<string, string | undefined>>, home: string,
): Promise<Prereqs> {
  const problems: string[] = [];
  const need = (ok: boolean, text: string): void => { if (!ok) problems.push(text); };
  const repo = path.resolve(import.meta.dir, "..");
  const realBun = process.execPath;
  const { globalDir: realGlobal, cacheDir: realCache } = locateRealGlobal(opts.realGlobal, env, home);
  const runsB = opts.only.includes("jeopi-to-jeo");

  need(process.platform !== "win32", "Windows is not supported (the replica uses sh shims and cp)");
  need(fs.existsSync(path.join(repo, "src", "cli.ts")), `${path.join(repo, "src", "cli.ts")} not found`);
  try { fs.accessSync(realBun, fs.constants.X_OK); } catch { problems.push(`bun executable ${realBun} is not executable`); }
  need(fs.existsSync("/usr/bin/env"), "/usr/bin/env is required by the jeo and jeopi shebangs");
  need(fs.existsSync("/bin/sh"), "/bin/sh is required by the logging shim");
  need((Bun.which("cp") ?? (fs.existsSync("/bin/cp") ? "/bin/cp" : null)) !== null, "cp not found");
  need(fs.existsSync(path.join(realGlobal, "package.json")), `real global manifest missing: ${path.join(realGlobal, "package.json")}`);
  need(fs.existsSync(path.join(realGlobal, "bun.lock")), `real global bun.lock missing: ${path.join(realGlobal, "bun.lock")}`);
  need(fs.existsSync(path.join(realGlobal, "node_modules")), `real global node_modules missing: ${path.join(realGlobal, "node_modules")}`);
  try {
    const tmp = fs.realpathSync(os.tmpdir());
    const rel = path.relative(fs.realpathSync(realGlobal), tmp);
    need(rel.startsWith("..") || path.isAbsolute(rel), `the tmpdir ${tmp} lies inside the real global ${realGlobal}`);
    const free = fs.statfsSync(tmp);
    need(free.bavail * free.bsize >= MIN_FREE_BYTES, `less than ${MIN_FREE_BYTES / 1024 ** 3} GiB free under ${tmp}`);
  } catch (err) {
    if (errCode(err) !== "ENOENT") problems.push(`cannot inspect the tmpdir or real global: ${message(err)}`);
  }

  const deps = readDeps(path.join(realGlobal, "package.json"));
  need(deps !== null, "real global package.json is unreadable");
  const externals = Object.keys(deps ?? {}).filter(name => name !== SELF_PACKAGE);
  if (deps !== null) {
    need(Object.hasOwn(deps, SELF_PACKAGE), `real global manifest does not list ${SELF_PACKAGE}`);
    need(externals.length > 0, "real global manifest lists no package besides jeo-code; there is nothing to isolate");
  }
  const jeopiNames = externals.filter(isJeopiKey);
  if (runsB && deps !== null) {
    need(jeopiNames.includes("jeopi-cli"), "real global manifest does not list jeopi-cli (needed for the jeopi->jeo phase)");
  }
  let treeVersion = "";
  try {
    const doc: unknown = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
    treeVersion = isRecord(doc) && typeof doc.version === "string" ? doc.version : "";
  } catch { /* reported below */ }
  need(VERSION_RE.test(treeVersion), `this tree's package.json version "${treeVersion}" is not x.y.z`);

  if (problems.length > 0) throw new Inconclusive(problems.map(p => `  - ${p}`).join("\n"));

  const realDeps = deps ?? {};
  const { target, seed } = pickVersions(await fetchPublished(SELF_PACKAGE), treeVersion, opts);
  let jeopiSeed: string | null = null;
  if (runsB) {
    const installed = realVersion(readVersion(path.join(realGlobal, "node_modules", "jeopi-cli")));
    if (installed === null || !VERSION_RE.test(installed)) throw new Inconclusive(`real global jeopi-cli version "${installed}" is not x.y.z`);
    const publishedByName = await Promise.all(jeopiNames.map(async name => [name, await fetchPublished(name)] as const));
    const cli = publishedByName.find(([name]) => name === "jeopi-cli")?.[1] ?? [];
    jeopiSeed = cli.filter(v => compareSemver(v, installed) < 0).at(-1) ?? null;
    if (jeopiSeed === null) throw new Inconclusive(`no published jeopi-cli below ${installed} to seed from`);
    const missing = publishedByName.filter(([, versions]) => !versions.includes(jeopiSeed!)).map(([name]) => name);
    if (missing.length > 0) throw new Inconclusive(`jeopi seed ${jeopiSeed} is not published for: ${missing.join(", ")}`);
    if (compareSemver(cli.at(-1)!, jeopiSeed) <= 0) throw new Inconclusive(`jeopi-cli ${jeopiSeed} is already the newest published; jeopi update could not advance`);
  }
  return { repo, treeVersion, realBun, realHome: home, realGlobal, realCache, deps: realDeps, externals, jeopiNames, target, seed, jeopiSeed };
}

// ---------------------------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------------------------

export interface RunResult { code: number | null; stdout: string; stderr: string; out: string; ms: number }

async function run(label: string, cmd: readonly string[], o: { cwd: string; env: Record<string, string>; timeoutMs: number }): Promise<RunResult> {
  const started = performance.now();
  const proc = Bun.spawn([...cmd], { cwd: o.cwd, env: o.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, o.timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (timedOut) throw new Inconclusive(`${label} timed out after ${o.timeoutMs / 1000}s`);
  return { code, stdout, stderr, out: `${stdout}${stderr}`, ms: performance.now() - started };
}

// ---------------------------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------------------------

interface Check { phase: string; label: string; ok: boolean }

interface Ctx {
  opts: Options;
  pre: Prereqs;
  sb: Sandbox;
  env: Record<string, string>;
  /** Argv of the update this tree ships, minus flags: bun src/cli.ts update --version TARGET --install. */
  updateArgv: string[];
  checks: Check[];
  inconclusive: { phase: string; message: string }[];
  ran: Set<string>;
  phase: string;
}

function check(ctx: Ctx, label: string, ok: boolean, detail?: string): void {
  ctx.checks.push({ phase: ctx.phase, label, ok });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` - ${detail}` : ""}`);
}

function note(ctx: Ctx, text: string): void {
  ctx.inconclusive.push({ phase: ctx.phase, message: text });
  console.log(`  [INCONCLUSIVE] ${text}`);
}

async function phase(ctx: Ctx, id: string, title: string, body: () => Promise<void>): Promise<void> {
  ctx.phase = id;
  ctx.ran.add(id);
  console.log(`\n=== ${title} ===`);
  try { await body(); } catch (err) { note(ctx, message(err)); }
}

function truncateLogs(sb: Sandbox): void {
  fs.writeFileSync(sb.bunLog, "");
  fs.writeFileSync(sb.npmLog, "");
}

function resolveJeo(sb: Sandbox): { realpath: string; version: string | null } | null {
  let real: string;
  try { real = fs.realpathSync(path.join(sb.binDir, "jeo")); } catch { return null; }
  let dir = path.dirname(real);
  for (let level = 0; level < 5; level++) {
    try {
      const doc: unknown = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (isRecord(doc) && doc.name === SELF_PACKAGE && typeof doc.version === "string") return { realpath: real, version: doc.version };
    } catch { /* keep walking up */ }
    dir = path.dirname(dir);
  }
  return { realpath: real, version: null };
}

function bunLogChecks(ctx: Ctx, expectInstall: boolean): void {
  const lines = packageManagerLines(readLog(ctx.sb.bunLog));
  if (expectInstall) {
    const bad = lines.filter(line => !isExpectedInstallLine(line, ctx.pre.target));
    check(ctx, "bun.log has package-manager lines", lines.length > 0, `${lines.length} line(s)`);
    check(ctx, `every package-manager line is "install -g ${SELF_PACKAGE}@${ctx.pre.target}" (optionally --force)`, bad.length === 0, bad.length ? `unexpected: ${bad.join(" | ")}` : lines.join(" | "));
  } else {
    check(ctx, "bun.log has ZERO package-manager lines (installer never ran)", lines.length === 0, lines.length ? `saw: ${lines.join(" | ")}` : undefined);
  }
  check(ctx, "no npm fallback was attempted", readLog(ctx.sb.npmLog).trim() === "");
}

function logOutput(label: string, r: RunResult): void {
  console.log(`  ${label}: exit ${r.code} in ${(r.ms / 1000).toFixed(1)}s`);
  console.log(excerpt(r.out));
}

async function setup(ctx: Ctx): Promise<Snapshot> {
  const { sb, pre } = ctx;
  writeShims(sb);
  fs.copyFileSync(path.join(pre.realGlobal, "package.json"), path.join(sb.globalDir, "package.json"));
  fs.copyFileSync(path.join(pre.realGlobal, "bun.lock"), path.join(sb.globalDir, "bun.lock"));
  const realSnap = snapshotTree(path.join(pre.realGlobal, "node_modules"));
  console.log(`  cloning ${realSnap.size} node_modules entries ...`);
  cloneTree(path.join(pre.realGlobal, "node_modules"), sb.nodeModules, sb.root);
  const cloneDiff = diffSnapshots(realSnap, snapshotTree(sb.nodeModules));
  if (cloneDiff.length > 0) throw new Inconclusive(`clone differs from the real node_modules in ${cloneDiff.length} keys (first: ${cloneDiff[0]!.key})`);

  // The logging shim must be on the spawn path of a bare `bun`, or "zero installer lines" would be vacuous.
  truncateLogs(sb);
  const probe = await run("shim probe", [pre.realBun, "-e", 'process.exit(Bun.spawnSync(["bun","--version"]).success?0:1)'], { cwd: sb.root, env: ctx.env, timeoutMs: 60_000 });
  if (probe.code !== 0 || !readLog(sb.bunLog).split("\n").includes("--version")) {
    throw new Inconclusive("the logging shim did not see a bare `bun` spawn; the bun.log checks would be vacuous");
  }

  const seeded = await run("seed install", [path.join(sb.shimsDir, "bun"), "install", "-g", `${SELF_PACKAGE}@${pre.seed}`], { cwd: sb.root, env: ctx.env, timeoutMs: CHILD_TIMEOUT_MS });
  if (seeded.code !== 0) {
    logOutput("bun install -g", seeded);
    throw new Inconclusive(`seeding ${SELF_PACKAGE}@${pre.seed} failed (exit ${seeded.code})`);
  }
  const s0 = snapshotTree(sb.nodeModules);
  const jeo = resolveJeo(sb);
  if (jeo?.version !== pre.seed) throw new Inconclusive(`after seeding, ${path.join(sb.binDir, "jeo")} resolves to ${jeo?.version ?? "nothing"}, expected ${pre.seed}`);
  if (!fs.existsSync(path.join(sb.globalDir, "bun.lock"))) throw new Inconclusive("seeding removed the replica bun.lock");
  const sandboxDeps = readDeps(path.join(sb.globalDir, "package.json"));
  const drifted = pre.externals.filter(name => sandboxDeps?.[name] !== pre.deps[name]);
  if (drifted.length > 0) throw new Inconclusive(`seeding rewrote the manifest spec of: ${drifted.join(", ")}`);
  const cmp = compareForTable([SELF_PACKAGE, ...pre.externals], realSnap, s0, isSelfKey);
  console.log(cmp.table);
  if (cmp.unexpected.length > 0) throw new Inconclusive(`seeded replica differs from the real global outside ${SELF_PACKAGE} (first: ${cmp.unexpected[0]!.key})`);
  console.log(`  seeded ${SELF_PACKAGE}@${pre.seed}; ${realSnap.size} entries identical to the real global outside ${SELF_PACKAGE}`);
  return s0;
}

async function phaseA(ctx: Ctx): Promise<void> {
  const { sb, pre } = ctx;
  const before = snapshotTree(sb.nodeModules);
  truncateLogs(sb);
  const r = await run("jeo update", ctx.updateArgv, { cwd: sb.root, env: ctx.env, timeoutMs: CHILD_TIMEOUT_MS });
  logOutput(`jeo update --version ${pre.target} --install`, r);
  const after = snapshotTree(sb.nodeModules);
  const cmp = compareForTable([SELF_PACKAGE, ...pre.externals], before, after, isSelfKey);
  console.log(cmp.table);

  check(ctx, "exit code 0", r.code === 0, `exit ${r.code}`);
  const jeo = resolveJeo(sb);
  check(ctx, `R/bin/jeo resolves to ${SELF_PACKAGE} ${pre.target}`, jeo?.version === pre.target, `${jeo?.version ?? "unresolved"}`);
  check(ctx, `output has "Successfully installed ${SELF_PACKAGE}@${pre.target}"`, r.out.includes(`Successfully installed ${SELF_PACKAGE}@${pre.target}`));
  const installed = pre.externals.filter(name => realVersion(before.get(name)) !== null).length;
  const summary = `shared global unchanged: ${installed} package${installed === 1 ? "" : "s"}`;
  check(ctx, `output has "${summary}"`, r.out.includes(summary));
  check(ctx, `${SELF_PACKAGE} moved ${pre.seed} -> ${pre.target}`, before.get(SELF_PACKAGE) === pre.seed && after.get(SELF_PACKAGE) === pre.target, `${before.get(SELF_PACKAGE)} -> ${after.get(SELF_PACKAGE)}`);
  check(ctx, `every key outside ${SELF_PACKAGE} and ${SELF_PACKAGE}/node_modules/* is identical`, cmp.unexpected.length === 0, cmp.unexpected.length ? `${cmp.unexpected.length} changed (first: ${cmp.unexpected[0]!.key})` : `${before.size} entries compared`);
  bunLogChecks(ctx, true);
  check(ctx, "output shows no npm fallback", !/npm (unavailable|exited|reported)/.test(r.out));
}

async function phaseB(ctx: Ctx): Promise<void> {
  const { sb, pre } = ctx;
  const seed = pre.jeopiSeed!;
  const jeopi = path.join(sb.binDir, "jeopi");
  const s1 = snapshotTree(sb.nodeModules);
  const seeded = await run("jeopi seed", [pre.realBun, "install", "-g", ...pre.jeopiNames.map(name => `${name}@${seed}`)], { cwd: sb.root, env: ctx.env, timeoutMs: CHILD_TIMEOUT_MS });
  if (seeded.code !== 0) {
    logOutput("bun install -g (jeopi seed, real bun, not logged)", seeded);
    throw new Inconclusive(`seeding ${pre.jeopiNames.join(", ")} at ${seed} failed (exit ${seeded.code})`);
  }
  const s2 = snapshotTree(sb.nodeModules);
  const seedDiff = compareForTable(["jeopi-cli", SELF_PACKAGE], s1, s2, isJeopiKey);
  if (seedDiff.unexpected.length > 0) throw new Inconclusive(`jeopi seeding changed keys outside jeopi-*: ${seedDiff.unexpected.slice(0, 3).map(d => d.key).join(", ")}`);
  if (s2.get("jeopi-cli") !== seed) throw new Inconclusive(`after seeding jeopi-cli is ${s2.get("jeopi-cli")}, expected ${seed}`);
  if (!fs.existsSync(jeopi)) throw new Inconclusive(`${jeopi} was not linked by the seed install`);
  const version = await run("jeopi --version", [jeopi, "--version"], { cwd: sb.root, env: ctx.env, timeoutMs: 60_000 });
  if (version.code !== 0 || !new RegExp(`(?<![\\d.])${seed.replaceAll(".", "\\.")}(?![\\d.])`).test(version.out)) {
    throw new Inconclusive(`R/bin/jeopi --version did not print ${seed}: ${version.out.trim().slice(0, 200)}`);
  }
  console.log(`  seeded ${pre.jeopiNames.length} jeopi packages at ${seed} (${seedDiff.changed.length} keys); jeopi --version prints ${seed}`);

  const r = await run("jeopi update", [jeopi, "update"], { cwd: sb.root, env: ctx.env, timeoutMs: CHILD_TIMEOUT_MS });
  logOutput("jeopi update", r);
  const s3 = snapshotTree(sb.nodeModules);
  const cmp = compareForTable([SELF_PACKAGE, ...pre.externals], s2, s3, isJeopiKey);
  console.log(cmp.table);

  const advanced = s3.get("jeopi-cli");
  check(ctx, "exit code 0", r.code === 0, `exit ${r.code}`);
  check(ctx, `jeopi-cli advanced past ${seed}`, advanced !== undefined && VERSION_RE.test(advanced) && compareSemver(advanced, seed) > 0, `${seed} -> ${advanced}`);
  check(ctx, `${SELF_PACKAGE} is identical`, [...s2.keys(), ...s3.keys()].filter(isSelfKey).every(key => s2.get(key) === s3.get(key)), `${s3.get(SELF_PACKAGE)}`);
  check(ctx, "every change is under keys starting jeopi-; every other package is identical", cmp.unexpected.length === 0, cmp.unexpected.length ? `${cmp.unexpected.length} changed (first: ${cmp.unexpected[0]!.key})` : `${cmp.changed.length} jeopi-* keys changed`);
}

interface LocklessState { snapshot: Snapshot; manifestHash: string | null; listing: string[] }

function captureLockless(sb: Sandbox): LocklessState {
  return {
    snapshot: snapshotTree(sb.nodeModules),
    manifestHash: sha256(path.join(sb.globalDir, "package.json")),
    listing: topLevelNames(sb.nodeModules),
  };
}

function lockGone(sb: Sandbox): void {
  const lock = path.join(sb.globalDir, "bun.lock");
  removeWithin(sb.root, lock);
  if (fs.existsSync(lock)) throw new Inconclusive("could not delete the replica bun.lock");
}

function unchangedFromLockless(ctx: Ctx, s4: LocklessState): void {
  const { sb } = ctx;
  const now = captureLockless(sb);
  const drift = diffSnapshots(s4.snapshot, now.snapshot);
  check(ctx, "bun.lock is still absent", !fs.existsSync(path.join(sb.globalDir, "bun.lock")));
  check(ctx, "replica snapshot is identical to S4", drift.length === 0, drift.length ? `${drift.length} keys differ (first: ${drift[0]!.key})` : `${s4.snapshot.size} entries`);
  check(ctx, "package.json hash is unchanged", now.manifestHash === s4.manifestHash);
  check(ctx, "top-level node_modules listing is unchanged", JSON.stringify(now.listing) === JSON.stringify(s4.listing));
}

async function phaseC(ctx: Ctx): Promise<void> {
  const { sb, pre } = ctx;
  lockGone(sb);
  const s4 = captureLockless(sb);
  console.log(`  deleted the replica bun.lock; S4 = ${s4.snapshot.size} entries, package.json ${s4.manifestHash?.slice(0, 12)}`);

  // Control: the same install WITHOUT the guard, on a throwaway clone inside the sandbox.
  console.log("  control: plain `bun install -g` on a clone without bun.lock ...");
  try {
    fs.mkdirSync(path.join(sb.ctlDir, "install"), { recursive: true });
    cloneTree(sb.globalDir, path.join(sb.ctlDir, "install", "global"), sb.root);
    const control = await run("control install", [pre.realBun, "install", "-g", `${SELF_PACKAGE}@${pre.target}`], { cwd: sb.root, env: { ...ctx.env, BUN_INSTALL: sb.ctlDir }, timeoutMs: CONTROL_TIMEOUT_MS });
    if (control.code !== 0) {
      logOutput("control bun install -g", control);
      note(ctx, `the control install failed (exit ${control.code}); drift was not reproduced`);
    } else {
      const after = snapshotTree(path.join(sb.ctlDir, "install", "global", "node_modules"));
      const cmp = compareForTable(pre.externals, s4.snapshot, after, () => true, "moved");
      console.log(cmp.table);
      console.log(`  control moved ${cmp.changed.length} of ${Math.max(s4.snapshot.size, after.size)} keys`);
      const moved = ["gajae-code", "oh-my-agent"].filter(name => after.get(name) !== s4.snapshot.get(name));
      if (moved.length === 0) note(ctx, "the control did not move gajae-code or oh-my-agent; lock loss was not reproduced, so the refusal below proves nothing");
      else console.log(`  control reproduced drift: ${moved.join(", ")} moved`);
    }
  } catch (err) {
    note(ctx, `control failed: ${message(err)}`);
  } finally {
    removeWithin(sb.root, sb.ctlDir);
  }

  // Refusal, human output.
  truncateLogs(sb);
  const r = await run("jeo update (no lock)", ctx.updateArgv, { cwd: sb.root, env: ctx.env, timeoutMs: CHILD_TIMEOUT_MS });
  logOutput(`jeo update --version ${pre.target} --install (no bun.lock)`, r);
  check(ctx, "refused with exit 1", r.code === 1, `exit ${r.code}`);
  check(ctx, "output mentions --allow-unlocked-global", r.out.includes("--allow-unlocked-global"));
  const missing = pre.externals.filter(name => !r.out.includes(name));
  check(ctx, "output names every external package", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : `${pre.externals.length} names`);
  bunLogChecks(ctx, false);
  unchangedFromLockless(ctx, s4);

  // Refusal, --json.
  truncateLogs(sb);
  const j = await run("jeo update --json (no lock)", [...ctx.updateArgv, "--json"], { cwd: sb.root, env: ctx.env, timeoutMs: CHILD_TIMEOUT_MS });
  logOutput("jeo update --json", j);
  check(ctx, "--json: exit 1", j.code === 1, `exit ${j.code}`);
  let doc: unknown;
  try { doc = JSON.parse(j.stdout.trim()); } catch { doc = undefined; }
  check(ctx, "--json: stdout is exactly one JSON object", isRecord(doc));
  const body = isRecord(doc) ? doc : {};
  check(ctx, "--json: installed is false", body.installed === false);
  check(ctx, "--json: error mentions the lockfile", typeof body.error === "string" && body.error.includes("lockfile"), typeof body.error === "string" ? body.error : undefined);
  const uncovered = isRecord(body.preflight) && Array.isArray(body.preflight.uncovered) ? body.preflight.uncovered : [];
  check(ctx, "--json: preflight.uncovered contains gajae-code and oh-my-agent", uncovered.includes("gajae-code") && uncovered.includes("oh-my-agent"), `${uncovered.length} uncovered`);
  bunLogChecks(ctx, false);
  unchangedFromLockless(ctx, s4);
}

async function phaseD(ctx: Ctx): Promise<void> {
  const { sb, pre } = ctx;
  if (fs.existsSync(path.join(sb.globalDir, "bun.lock"))) lockGone(sb);
  const before = snapshotTree(sb.nodeModules);
  truncateLogs(sb);
  const r = await run("jeo update --allow-unlocked-global", [...ctx.updateArgv, "--allow-unlocked-global"], { cwd: sb.root, env: ctx.env, timeoutMs: CONTROL_TIMEOUT_MS });
  logOutput(`jeo update --version ${pre.target} --install --allow-unlocked-global`, r);
  const after = snapshotTree(sb.nodeModules);
  const cmp = compareForTable(pre.externals, before, after, () => true, "moved (drift)");
  console.log(cmp.table);
  const moved = pre.externals.filter(name => before.get(name) !== after.get(name));
  if (!moved.includes("gajae-code") && !moved.includes("oh-my-agent")) {
    note(ctx, "gajae-code and oh-my-agent did not move; drift was not reproduced");
    return;
  }
  check(ctx, "exit 1 (drift fails the update)", r.code === 1, `exit ${r.code}`);
  check(ctx, "no success line is printed", !r.out.includes("Successfully installed"));
  check(ctx, "the installer ran", packageManagerLines(readLog(sb.bunLog)).length > 0);
  for (const name of moved) {
    const from = realVersion(before.get(name));
    const to = realVersion(after.get(name));
    const line = `${name} ${from ?? "(not installed)"} -> ${to ?? "(removed)"}`;
    const restore = from === null ? `bun remove -g ${name}` : `bun install -g ${name}@${from}`;
    check(ctx, `output lists "${line}" and "${restore}"`, r.out.includes(line) && r.out.includes(restore));
  }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

function statusOf(ctx: Ctx, id: string): string {
  if (ctx.checks.some(c => c.phase === id && !c.ok)) return "FAIL";
  if (ctx.inconclusive.some(i => i.phase === id)) return "INCONCLUSIVE";
  return ctx.ran.has(id) ? "PASS" : "SKIPPED";
}

function printTripwire(before: RealState, after: RealState, violations: readonly string[]): void {
  const hash = (value: string | null): string => value?.slice(0, 12) ?? "-";
  const count = (value: readonly string[] | null): string => (value === null ? "-" : String(value.length));
  const rows = [
    ["real package.json sha256", hash(before.manifestHash), hash(after.manifestHash)],
    ["real bun.lock sha256", hash(before.lockHash), hash(after.lockHash)],
    ["real node_modules names", count(before.names), count(after.names)],
    ["real bun cache entries", String(before.cacheEntries ?? "-"), String(after.cacheEntries ?? "-")],
    ["~/.jeopi top-level names", count(before.jeopiTop), count(after.jeopiTop)],
    ["~/.jeopi/agent top-level names", count(before.jeopiAgent), count(after.jeopiAgent)],
  ].map(([label, b, a]) => [label!, b!, a!, b === a ? "same" : "differs"]);
  console.log(formatTable(["real state", "before", "after", "verdict"], rows));
  for (const violation of violations) console.log(`  violation: ${violation}`);
}

export async function main(argv: readonly string[]): Promise<number> {
  let opts: Options;
  try { opts = parseArgs(argv); } catch (err) {
    if (err instanceof UsageError) { console.error(`${err.message}\n\n${USAGE}`); return 2; }
    throw err;
  }
  if (opts.help) { console.log(USAGE); return 0; }

  const started = performance.now();
  const home = os.homedir();
  let pre: Prereqs;
  try { pre = await checkPrerequisites(opts, process.env, home); } catch (err) {
    if (err instanceof Inconclusive) { console.error(`Prerequisite check failed (exit 2):\n${err.message}`); return 2; }
    throw err;
  }
  console.log(`tree ${SELF_PACKAGE} ${pre.treeVersion}; replica moves ${pre.seed} -> ${pre.target}${pre.jeopiSeed ? `; jeopi seed ${pre.jeopiSeed}` : ""}`);
  console.log(`real global ${pre.realGlobal} (${pre.externals.length} packages besides ${SELF_PACKAGE})`);

  const jeopiHome = path.join(pre.realHome, ".jeopi");
  const realBefore = captureRealState(pre.realGlobal, pre.realCache, jeopiHome);
  let sb: Sandbox;
  try { sb = createSandbox(); } catch (err) {
    console.error(`Could not create the sandbox (exit 2): ${message(err)}`);
    return 2;
  }
  console.log(`sandbox ${sb.root}`);
  process.on("SIGINT", () => {
    console.error(`\ninterrupted; sandbox kept at ${sb.root}`);
    process.exit(130);
  });

  const env = sandboxEnv(sb, pre.realBun);
  const ctx: Ctx = {
    opts, pre, sb, env,
    updateArgv: [pre.realBun, path.join(pre.repo, "src", "cli.ts"), "update", "--version", pre.target, "--install"],
    checks: [], inconclusive: [], ran: new Set(), phase: "setup",
  };

  let setupOk = false;
  await phase(ctx, "setup", `Setup: seed ${SELF_PACKAGE}@${pre.seed}`, async () => { await setup(ctx); setupOk = true; });
  if (setupOk) {
    if (opts.only.includes("jeo-to-jeopi")) await phase(ctx, "A", `A (AC-8): jeo update ${pre.seed} -> ${pre.target} leaves jeopi and every other package alone`, () => phaseA(ctx));
    if (opts.only.includes("jeopi-to-jeo")) await phase(ctx, "B", "B (AC-9): jeopi update leaves jeo-code and every non-jeopi package alone", () => phaseB(ctx));
    if (opts.only.includes("lockfile-loss")) await phase(ctx, "C", "C (AC-10): lost bun.lock - control drifts, jeo update refuses", () => phaseC(ctx));
    if (opts.withUnlocked) await phase(ctx, "D", "D: --allow-unlocked-global on the lock-less replica reports the drift", () => phaseD(ctx));
  }

  ctx.phase = "tripwire";
  ctx.ran.add("tripwire");
  console.log("\n=== Tripwire: real global, real bun cache and ~/.jeopi ===");
  const realAfter = captureRealState(pre.realGlobal, pre.realCache, jeopiHome);
  const violations = compareRealState(realBefore, realAfter);
  printTripwire(realBefore, realAfter, violations);
  check(ctx, "the real global, the real cache and ~/.jeopi were not touched", violations.length === 0, violations.length ? "a concurrent host session can also change ~/.jeopi names; inspect the violations above" : undefined);

  console.log("\n=== Result ===");
  const rows = [["setup", "setup"], ["AC-8  jeo -> jeopi", "A"], ["AC-9  jeopi -> jeo", "B"], ["AC-10 lockfile loss", "C"], ["D     --allow-unlocked-global", "D"], ["tripwire", "tripwire"]]
    .filter(([, id]) => id !== "D" || ctx.ran.has("D"))
    .map(([label, id]) => [label!, statusOf(ctx, id!)]);
  console.log(formatTable(["acceptance", "result"], rows));
  const failed = ctx.checks.filter(c => !c.ok);
  for (const c of failed) console.log(`  failed: [${c.phase}] ${c.label}`);
  for (const i of ctx.inconclusive) console.log(`  inconclusive: [${i.phase}] ${i.message}`);
  const code = failed.length > 0 ? 1 : ctx.inconclusive.length > 0 ? 2 : 0;
  console.log(`exit ${code} (${code === 0 ? "pass" : code === 1 ? "assertion failed" : "inconclusive"}) in ${((performance.now() - started) / 1000).toFixed(0)}s`);

  if (code === 0 && !opts.keep) {
    removeSandbox(sb.root);
    console.log(`sandbox ${sb.root} removed`);
  } else {
    console.log(`sandbox kept at ${sb.root}`);
  }
  return code;
}

// An unexpected crash is inconclusive (2), never an assertion failure (1); a sandbox created before it is kept.
if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)).catch((err: unknown) => {
    console.error(`unexpected error (exit 2): ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    return 2;
  }));
}
