export * from "./types";
export * from "./store";
export * from "./matcher";
export { RestDiscordClient, chunkDiscordContent, type DiscordClient } from "./discord-api";
export * from "./orca";
export * from "./verifier";
export * from "./engine";
export * from "./daemon";
export * from "./launchd";

import {
  linkOrchConfigFile,
  loadOrchConfig,
  loadStoredOrchConfig,
  readOrchConfigFile,
  saveOrchConfig,
  writeLocalOrchConfigFile,
} from "./store";
import type { OrchConfig, OrchConfigFile } from "./types";

export interface InitOrchConfigOptions {
  guildId?: string;
  ownerDmChannelId?: string;
  ownerUserIds?: string[];
  tokenFile?: string;
  tokenEnv?: string;
  orcaBin?: string;
  pollIntervalMs?: number;
  debounceMs?: number;
  /** Optional path to an existing repo-local hidden config file (e.g. `.jeo/orch.json`) to link. */
  configFile?: string;
  /** When set, write the supplied settings into this repo-local hidden config file and link it. */
  writeLocalPath?: string;
}

/**
 * Idempotently initialize orchestrator settings in `<orchHome>/routes.json`
 * and/or link a repo-local hidden config file (e.g. `<repo>/.jeo/orch.json`).
 */
export async function initOrchConfig(
  opts: InitOrchConfigOptions,
  orchHome?: string,
): Promise<OrchConfig> {
  if (opts.writeLocalPath) {
    const existing = (await readOrchConfigFile(opts.writeLocalPath))?.data ?? {};
    const localData: OrchConfigFile = {
      ...existing,
      ...(opts.guildId?.trim() ? { guildId: opts.guildId.trim() } : {}),
      ...(opts.ownerDmChannelId?.trim() ? { ownerDmChannelId: opts.ownerDmChannelId.trim() } : {}),
      ...(opts.ownerUserIds && opts.ownerUserIds.length > 0
        ? {
            ownerUserIds: Array.from(
              new Set([
                ...(existing.ownerUserIds ?? []),
                ...opts.ownerUserIds.map(id => id.trim()).filter(Boolean),
              ]),
            ),
          }
        : {}),
      ...(opts.tokenFile?.trim() ? { tokenFile: opts.tokenFile.trim() } : {}),
      ...(opts.tokenEnv?.trim() ? { tokenEnv: opts.tokenEnv.trim() } : {}),
      ...(opts.orcaBin?.trim() ? { orcaBin: opts.orcaBin.trim() } : {}),
      ...(typeof opts.pollIntervalMs === "number" && opts.pollIntervalMs >= 2000
        ? { pollIntervalMs: opts.pollIntervalMs }
        : {}),
      ...(typeof opts.debounceMs === "number" && opts.debounceMs >= 0
        ? { debounceMs: opts.debounceMs }
        : {}),
    };
    await writeLocalOrchConfigFile(opts.writeLocalPath, localData);
    const linked = await linkOrchConfigFile(opts.writeLocalPath, orchHome);
    return linked.config;
  }

  if (opts.configFile?.trim()) {
    const linked = await linkOrchConfigFile(opts.configFile.trim(), orchHome);
    return linked.config;
  }

  const cfg = await loadStoredOrchConfig(orchHome);
  if (opts.guildId?.trim()) {
    cfg.guildId = opts.guildId.trim();
  }
  if (opts.ownerDmChannelId?.trim()) {
    cfg.ownerDmChannelId = opts.ownerDmChannelId.trim();
  }
  if (opts.ownerUserIds && opts.ownerUserIds.length > 0) {
    const merged = new Set([
      ...cfg.ownerUserIds,
      ...opts.ownerUserIds.map(id => id.trim()).filter(Boolean),
    ]);
    cfg.ownerUserIds = Array.from(merged);
  }
  if (opts.tokenFile?.trim()) {
    cfg.tokenFile = opts.tokenFile.trim();
  }
  if (opts.tokenEnv?.trim()) {
    cfg.tokenEnv = opts.tokenEnv.trim();
  }
  if (opts.orcaBin?.trim()) {
    cfg.orcaBin = opts.orcaBin.trim();
  }
  if (typeof opts.pollIntervalMs === "number" && opts.pollIntervalMs >= 2000) {
    cfg.pollIntervalMs = opts.pollIntervalMs;
  }
  if (typeof opts.debounceMs === "number" && opts.debounceMs >= 0) {
    cfg.debounceMs = opts.debounceMs;
  }
  await saveOrchConfig(cfg, orchHome);
  return loadOrchConfig(orchHome);
}

