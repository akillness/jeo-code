/**
 * Most-recently-used default-model persistence.
 *
 * Picking a model (`/model <id>`, `/provider <name>`, live picker) now persists
 * immediately: the choice becomes `defaultModel` for EVERY future session, and
 * `recentModels` keeps the selection history newest-first so pickers can offer
 * the user's recent rotation. Pure functions over Config — no I/O here; callers
 * persist through `saveConfigPatch` (raw on-disk config, never env-overlaid).
 */
import type { Config } from "./state";

export const RECENT_MODELS_CAP = 10;

/** MRU-update a recents list: newest first, deduped, capped. */
export function pushRecentModel(recents: readonly string[] | undefined, model: string, cap = RECENT_MODELS_CAP): string[] {
  const id = model.trim();
  if (!id) return [...(recents ?? [])];
  return [id, ...(recents ?? []).filter(m => m !== id)].slice(0, Math.max(1, cap));
}

/** Config patch that makes `model` the global default AND the recents head. */
export function rememberModelPatch(raw: Config, model: string): Partial<Config> {
  return {
    defaultModel: model,
    recentModels: pushRecentModel(raw.recentModels, model),
  };
}

/** Recents for display, current default first even when the list is stale/empty. */
export function recentModelsForDisplay(cfg: Pick<Config, "defaultModel" | "recentModels">): string[] {
  return pushRecentModel(cfg.recentModels, cfg.defaultModel);
}
