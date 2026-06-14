import pkg from "../../package.json";
import { compareVersions } from "../commands/update";
import * as os from "node:os";
import * as path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { jeoEnv } from "./env";

export interface UpdateCheckResult {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

export interface UpdateCheckDeps {
  fetchJson?: (url: string, opts?: { signal?: AbortSignal }) => Promise<any>;
  localVersion?: () => string;
  timeoutMs?: number;
}

export async function checkForUpdate(deps?: UpdateCheckDeps): Promise<UpdateCheckResult | null> {
  try {
    const fetchJson = deps?.fetchJson ?? (async (url, opts) => {
      const res = await fetch(url, opts);
      if (!res.ok) {
        throw new Error(`HTTP error ${res.status}`);
      }
      return res.json();
    });

    const localVersion = deps?.localVersion ?? (() => pkg.version);
    const timeoutMs = deps?.timeoutMs ?? 2500;

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const current = localVersion();
      if (typeof current !== "string" || !current) {
        clearTimeout(id);
        return null;
      }

      const data = await fetchJson("https://registry.npmjs.org/jeo-code/latest", {
        signal: controller.signal,
      });

      clearTimeout(id);

      if (!data || typeof data.version !== "string") {
        return null;
      }

      const latest = data.version;
      const updateAvailable = compareVersions(current, latest) < 0;

      return {
        current,
        latest,
        updateAvailable,
      };
    } catch (err) {
      clearTimeout(id);
      return null;
    }
  } catch (err) {
    return null;
  }
}

// ---- Update-check disk cache ------------------------------------------------
// The live npm check often loses the startup race, so the "New version" banner
// rarely shows even when an update exists. Persisting the last-known-latest lets
// the NEXT launch render the banner INSTANTLY from disk (and offline), while a
// background refresh keeps the cache fresh. Mirrors gjc / npm update notices.

interface CachedUpdateCheck {
  latest: string;
  checkedAt: number;
}

function updateCacheDir(): string {
  return jeoEnv("CONFIG_DIR") || path.join(os.homedir(), ".jeo");
}

function updateCachePath(): string {
  return path.join(updateCacheDir(), "update-check.json");
}

/** Last-known-latest from disk, re-evaluated against the CURRENT local version
 *  (so an interim upgrade clears the banner). Null when no/invalid cache. */
export async function readUpdateCache(localVersion: string = pkg.version): Promise<UpdateCheckResult | null> {
  if (typeof localVersion !== "string" || !localVersion) return null;
  try {
    const raw = await readFile(updateCachePath(), "utf-8");
    const data = JSON.parse(raw) as Partial<CachedUpdateCheck>;
    if (!data || typeof data.latest !== "string" || !data.latest) return null;
    return {
      current: localVersion,
      latest: data.latest,
      updateAvailable: compareVersions(localVersion, data.latest) < 0,
    };
  } catch {
    return null;
  }
}

/** Persist the latest version for the next launch (best-effort; never throws). */
export async function writeUpdateCache(latest: string): Promise<void> {
  if (typeof latest !== "string" || !latest) return;
  try {
    await mkdir(updateCacheDir(), { recursive: true, mode: 0o700 });
    const payload: CachedUpdateCheck = { latest, checkedAt: Date.now() };
    await writeFile(updateCachePath(), JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch {
    // Cache is an optimization; a write failure must never break launch.
  }
}
