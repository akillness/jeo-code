/**
 * Read-only view of the shared bun global install (`~/.bun/install/global`) that `jeo update`
 * writes into with `bun install -g jeo-code@V`. That directory also holds other tools,
 * so `jeo update` must prove it leaves every other top-level package alone.
 *
 * This module only ever reads: it never writes, deletes, renames, spawns or executes anything.
 * Restore commands are formatted as strings for a human to run.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { currentJeoCommand } from "../messenger/launcher";

export const SELF_PACKAGE = "jeo-code";

export type EnvLike = Readonly<Record<string, string | undefined>>;
export type GlobalSkipReason = "windows" | "no-home" | "no-bun-global" | "manifest-unreadable" | "bunfig-global-dir";
export type LocatedGlobal = { ok: true; dir: string } | { ok: false; reason: GlobalSkipReason; detail?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  if (err !== null && typeof err === "object" && "message" in err && typeof err.message === "string") return err.message;
  return String(err);
}

function errorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === "object" && "code" in err && typeof err.code === "string") return err.code;
  return undefined;
}

type ParsedFile = { ok: true; value: Record<string, unknown> } | { ok: false; missing: boolean; error: string };

/** Reads and JSONC-parses a file that must hold an object. `missing` is true only for ENOENT/ENOTDIR. */
function parseJsonObject(file: string): ParsedFile {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = errorCode(err);
    return { ok: false, missing: code === "ENOENT" || code === "ENOTDIR", error: errorMessage(err) };
  }
  let doc: unknown;
  try {
    doc = Bun.JSONC.parse(text);
  } catch (err) {
    return { ok: false, missing: false, error: errorMessage(err) };
  }
  if (!isRecord(doc)) return { ok: false, missing: false, error: "not a JSON object" };
  return { ok: true, value: doc };
}

/**
 * Where bun keeps its global install: `$BUN_INSTALL_GLOBAL_DIR`, else `${BUN_INSTALL:-$HOME/.bun}/install/global`.
 * Null when neither an override nor a home directory is available, or on Windows (never inspected there).
 */
export function candidateGlobalDir(env: EnvLike, home: string | undefined, platform: NodeJS.Platform): string | null {
  if (platform === "win32") return null;
  const override = env.BUN_INSTALL_GLOBAL_DIR;
  if (override) return path.resolve(override);
  const installRoot = env.BUN_INSTALL || (home ? path.join(home, ".bun") : undefined);
  return installRoot ? path.join(installRoot, "install", "global") : null;
}

const BUNFIG_GLOBAL_DIR_KEY = /^\s*(?:install\s*\.\s*)?["']?globalDir["']?\s*=/;

/** The bunfig.toml that sets a `globalDir`, if any (a user-level one moves the global dir independently of the env). */
function bunfigWithGlobalDir(env: EnvLike, home: string | undefined): string | null {
  const files: string[] = [];
  if (home) files.push(path.join(home, ".bunfig.toml"));
  if (env.XDG_CONFIG_HOME) files.push(path.join(env.XDG_CONFIG_HOME, ".bunfig.toml"));
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (text.split(/\r?\n/).some(line => BUNFIG_GLOBAL_DIR_KEY.test(line))) return file;
  }
  return null;
}

/**
 * Resolves the shared bun global dir and proves it holds a parseable package.json. A compiled jeo is NOT a
 * skip reason: `jeo update` runs `bun install -g` into this same directory from a compiled binary too.
 * `entry` and `execPath` are accepted so one options object serves both this and detectInstallOrigin.
 */
export function locateSharedGlobal(o: { env?: EnvLike; home?: string; platform?: NodeJS.Platform; entry?: string; execPath?: string } = {}): LocatedGlobal {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  if (platform === "win32") return { ok: false, reason: "windows" };
  const home = o.home ?? (env.HOME || undefined);
  const bunfig = bunfigWithGlobalDir(env, home);
  if (bunfig) return { ok: false, reason: "bunfig-global-dir", detail: bunfig };
  const candidate = candidateGlobalDir(env, home, platform);
  if (!candidate) return { ok: false, reason: "no-home" };
  const manifest = parseJsonObject(path.join(candidate, "package.json"));
  if (!manifest.ok) {
    return manifest.missing
      ? { ok: false, reason: "no-bun-global", detail: candidate }
      : { ok: false, reason: "manifest-unreadable", detail: manifest.error };
  }
  let dir = candidate;
  try {
    dir = fs.realpathSync(candidate);
  } catch {
    // The manifest was just read from the candidate path, so keep it when realpath fails.
  }
  return { ok: true, dir };
}

export interface ManifestDeps {
  names: string[];
  specs: Record<string, string>;
  external: string[];
  ignored: string[];
}

/**
 * Top-level dependencies of the global package.json. Empty names and non-string specs are dropped into
 * `ignored` (another tool's older updater wrote a `"": "."` dependency that no lockfile could ever cover). `external` is
 * every name except jeo-code, in manifest order. An absent `dependencies` means zero dependencies.
 */
export function readManifestDeps(dir: string): { ok: true; deps: ManifestDeps } | { ok: false; error: string } {
  const manifest = parseJsonObject(path.join(dir, "package.json"));
  if (!manifest.ok) return { ok: false, error: manifest.error };
  const raw = manifest.value.dependencies;
  if (raw !== undefined && raw !== null && !isRecord(raw)) return { ok: false, error: "dependencies is not an object" };
  const names: string[] = [];
  const specs: [string, string][] = [];
  const ignored: string[] = [];
  for (const [name, spec] of Object.entries(raw ?? {})) {
    if (name === "" || typeof spec !== "string") {
      ignored.push(name);
      continue;
    }
    names.push(name);
    specs.push([name, spec]);
  }
  return { ok: true, deps: { names, specs: Object.fromEntries(specs), external: names.filter(n => n !== SELF_PACKAGE), ignored } };
}

export type LockStatus = "ok" | "missing" | "incomplete" | "unreadable" | "not-required";
export interface LockCoverage {
  status: LockStatus;
  uncovered: string[];
  path: string;
  detail?: string;
  legacyBinaryLock?: boolean;
}

/**
 * Whether `bun.lock` carries a resolved entry for every external dependency. Bun's text lockfile is JSONC;
 * a direct dependency is an OWN key of `packages` equal to its name (nested copies are `parent/name`, and the
 * root workspace under `workspaces[""]` merely mirrors the manifest), and its value is a tuple whose first
 * element is the resolved `name@version` string. lockfileVersion and tuple length are deliberately not gated.
 */
export function checkLockCoverage(dir: string, external: readonly string[]): LockCoverage {
  const lockPath = path.join(dir, "bun.lock");
  if (external.length === 0) return { status: "not-required", uncovered: [], path: lockPath };
  let text: string;
  try {
    text = fs.readFileSync(lockPath, "utf8");
  } catch (err) {
    const missing = errorCode(err) === "ENOENT";
    return {
      status: missing ? "missing" : "unreadable",
      uncovered: [...external],
      path: lockPath,
      detail: missing ? undefined : errorMessage(err),
      legacyBinaryLock: missing && fs.existsSync(path.join(dir, "bun.lockb")),
    };
  }
  let doc: unknown;
  try {
    doc = Bun.JSONC.parse(text);
  } catch (err) {
    return { status: "unreadable", uncovered: [...external], path: lockPath, detail: errorMessage(err) };
  }
  const packages = isRecord(doc) ? doc.packages : undefined;
  if (!isRecord(packages)) return { status: "unreadable", uncovered: [...external], path: lockPath, detail: "no packages map" };
  const uncovered = external.filter(name => {
    if (!Object.hasOwn(packages, name)) return true;
    const entry = packages[name];
    return !(Array.isArray(entry) && typeof entry[0] === "string" && entry[0].length > 0);
  });
  return { status: uncovered.length > 0 ? "incomplete" : "ok", uncovered, path: lockPath };
}

export type InstalledSnapshot = Record<string, string | null>;

function installedVersion(dir: string, name: string): string | null {
  if (name === "" || name === SELF_PACKAGE || name.includes("..") || path.isAbsolute(name)) return null;
  const manifest = parseJsonObject(path.join(dir, "node_modules", name, "package.json"));
  if (!manifest.ok) return null;
  return typeof manifest.value.version === "string" ? manifest.value.version : null;
}

/**
 * Installed version of each named package (read from `dir/node_modules/<name>/package.json`), null when it is
 * absent or unreadable, has no string version, is jeo-code itself, has an unsafe name, or `present` lacks it.
 */
export function snapshotInstalled(dir: string, names: readonly string[], present?: ReadonlySet<string>): InstalledSnapshot {
  return Object.fromEntries(names.map(name => [name, present && !present.has(name) ? null : installedVersion(dir, name)]));
}

export interface ExternalChange {
  name: string;
  from: string | null;
  to: string | null;
}

/** Every package whose installed version differs between the two snapshots; jeo-code is never reported. */
export function diffInstalled(before: InstalledSnapshot, after: InstalledSnapshot): ExternalChange[] {
  const changes: ExternalChange[] = [];
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (name === SELF_PACKAGE) continue;
    const from = Object.hasOwn(before, name) ? before[name] ?? null : null;
    const to = Object.hasOwn(after, name) ? after[name] ?? null : null;
    if (from !== to) changes.push({ name, from, to });
  }
  return changes;
}

export function formatChangeLine(c: ExternalChange): string {
  return `${c.name} ${c.from ?? "(not installed)"} -> ${c.to ?? "(removed)"}`;
}

const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;
const SAFE_PACKAGE_NAME = new RegExp("^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$");

/**
 * One shell line per change that puts the previous state back. They are printed for a human and never run.
 * A name or version that is not shell-safe becomes a comment so a hostile manifest cannot inject a command.
 */
export function formatRestoreCommands(cs: readonly ExternalChange[]): string[] {
  return cs.map(c => {
    if (!SAFE_PACKAGE_NAME.test(c.name)) return `# restore ${c.name.replace(/[^ -~]/g, "?")} manually`;
    if (c.from === null) return `bun remove -g ${c.name}`;
    return SAFE_VERSION.test(c.from) ? `bun install -g ${c.name}@${c.from}` : `# restore ${c.name} manually`;
  });
}

/** `shared global unchanged: 3 packages (a X, b Y, c Z, ...)`: ascending by name, at most 3 shown. */
export function formatUnchangedSummary(after: InstalledSnapshot): string {
  const present = Object.entries(after)
    .filter((e): e is [string, string] => e[0] !== SELF_PACKAGE && e[1] !== null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const count = `${present.length} ${present.length === 1 ? "package" : "packages"}`;
  if (present.length === 0) return `shared global unchanged: ${count}`;
  const shown = present.slice(0, 3).map(([name, version]) => `${name} ${version}`);
  return `shared global unchanged: ${count} (${shown.join(", ")}${present.length > 3 ? ", ..." : ""})`;
}

export type InstallOrigin = "bun-global" | "npm-global" | "unknown";
export interface JeoOnPath {
  path: string;
  realpath: string;
}

/** Every executable `jeo` on PATH in PATH order, deduplicated by realpath (first PATH position wins). Nothing is executed. */
export function listJeoOnPath(env: EnvLike = process.env, platform: NodeJS.Platform = process.platform): JeoOnPath[] {
  if (platform === "win32") return [];
  const found: JeoOnPath[] = [];
  const seen = new Set<string>();
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, "jeo");
    let real: string;
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile() || (stat.mode & 0o111) === 0) continue;
      real = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    found.push({ path: candidate, realpath: real });
  }
  return found;
}

function readNpmrcPrefix(home: string | undefined): string | null | undefined {
  if (!home) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(path.join(home, ".npmrc"), "utf8");
  } catch {
    return undefined;
  }
  let value: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*prefix\s*=\s*(.*)$/.exec(line);
    if (match) value = match[1];
  }
  if (value === undefined) return undefined;
  let prefix = value.trim();
  const quote = prefix[0];
  if ((quote === '"' || quote === "'") && prefix.length >= 2 && prefix.endsWith(quote)) prefix = prefix.slice(1, -1);
  else prefix = prefix.replace(/\s*[;#].*$/, "");
  prefix = prefix.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  return path.isAbsolute(prefix) ? prefix : null;
}

/**
 * npm's global node_modules directory without running npm: `npm_config_prefix`/`NPM_CONFIG_PREFIX`, else the
 * last `prefix =` line of `~/.npmrc`, else the first executable `npm` on PATH (only when its `lib/node_modules`
 * really holds npm, which accepts nvm/Homebrew layouts and rejects Volta/fnm shims). Null when unknown.
 */
export function resolveNpmGlobalRoot(env: EnvLike = process.env, home: string | undefined = env.HOME || undefined, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "win32") return null;
  const fromEnv = env.npm_config_prefix || env.NPM_CONFIG_PREFIX;
  if (fromEnv) return path.isAbsolute(fromEnv) ? path.join(fromEnv, "lib", "node_modules") : null;
  const fromNpmrc = readNpmrcPrefix(home);
  if (fromNpmrc !== undefined) return fromNpmrc === null ? null : path.join(fromNpmrc, "lib", "node_modules");
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const npm = path.join(dir, "npm");
    try {
      const stat = fs.statSync(npm);
      if (!stat.isFile() || (stat.mode & 0o111) === 0) continue;
    } catch {
      continue;
    }
    if (path.basename(dir) !== "bin") return null;
    const root = path.join(path.dirname(dir), "lib", "node_modules");
    return fs.existsSync(path.join(root, "npm", "package.json")) ? root : null;
  }
  return null;
}

/** True when `child` is strictly inside `parent`. */
export function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export function classifyActiveInstall(active: string | null, roots: { bunGlobalNodeModules: string | null; npmGlobalRoot: string | null }): InstallOrigin {
  if (active === null) return "unknown";
  if (roots.bunGlobalNodeModules !== null && isUnder(active, roots.bunGlobalNodeModules)) return "bun-global";
  if (roots.npmGlobalRoot !== null && isUnder(active, roots.npmGlobalRoot)) return "npm-global";
  return "unknown";
}

function realpathIfPresent(p: string | null): string | null {
  if (p === null) return null;
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Which package manager owns the `jeo` that is first on PATH, decided from paths only. A compiled binary
 * (`currentJeoCommand` is a single element) has no package-manager install, so its origin is 'unknown'
 * and `jeo update` never falls back to npm for it.
 */
export function detectInstallOrigin(o: { env?: EnvLike; home?: string; platform?: NodeJS.Platform; entry?: string; execPath?: string } = {}): {
  origin: InstallOrigin;
  active: string | null;
  bunGlobalNodeModules: string | null;
  npmGlobalRoot: string | null;
} {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const home = o.home ?? (env.HOME || undefined);
  const active = listJeoOnPath(env, platform)[0]?.realpath ?? null;
  const candidate = candidateGlobalDir(env, home, platform);
  const bunGlobalNodeModules = candidate === null ? null : realpathIfPresent(path.join(candidate, "node_modules"));
  const npmGlobalRoot = resolveNpmGlobalRoot(env, home, platform);
  const compiled = currentJeoCommand(o.entry, o.execPath).length === 1;
  const origin = compiled ? "unknown" : classifyActiveInstall(active, { bunGlobalNodeModules, npmGlobalRoot: realpathIfPresent(npmGlobalRoot) });
  return { origin, active, bunGlobalNodeModules, npmGlobalRoot };
}
