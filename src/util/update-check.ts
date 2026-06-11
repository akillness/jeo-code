import pkg from "../../package.json";
import { compareVersions } from "../commands/update";

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
