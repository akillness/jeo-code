/**
 * CLI & shared controller for `jeo orch ...` (Discord thread orchestrator & recursive loop).
 */

import * as path from "node:path";
import {
  expandTilde,
  getLaunchdStatus,
  initOrchConfig,
  installLaunchdService,
  isDaemonRunning,
  linkOrchConfigFile,
  LOCAL_ORCH_CONFIG_RELPATH,
  loadOrchConfig,
  loadOrchState,
  normalizeOrchBackendKind,
  normalizeRoute,
  ORCH_LAUNCHD_LABEL,
  parseTmuxWorkerHandle,
  readOrchConfigFile,
  readRecentLedger,
  removeRoute,
  resolveDiscordToken,
  resolveLocalOrchConfigPath,
  resolveOrchBackendKind,
  resolveOrchHome,
  runOrchDaemon,
  runOrchOnce,
  saveDiscordToken,
  saveOrchState,
  tmuxSessionNameForRepo,
  TmuxWorkerBackend,
  uninstallLaunchdService,
  unlinkOrchConfigFile,
  upsertRoute,
  writeLocalOrchConfigFile,
  type OrchBackendKind,
  type OrchConfig,
  type OrchConfigFile,
  type OrchState,
  type ProjectRoute,
  type VerificationGate,
} from "../orch/index";

export interface OrchActionResult {
  lines: string[];
  exitCode?: number;
  attachCommand?: string[];
}
export function orchUsageLines(prefix = "jeo orch"): string[] {
  return [
    `Usage: ${prefix} <subcommand> [options]`,
    `  status                                       Show daemon, launchd, routes, threads, and pending gates`,
    `  routes                                       List configured project routes and linked config files`,
    `  init [guildId] [--guild <id>] [--dm <ch>]    Configure guild/owners/settings, or auto-link ./.jeo/orch.json`,
    `       [--owner <u1,u2>] [--backend auto|tmux|headless|orca] [--poll <ms>] [--debounce <ms>] [--token-file <p>] [--token-env <v>] [--orca-bin <p>] [--config <p>] [--local]`,
    `  link [path]                                  Link a repo-local hidden config file (default: ${LOCAL_ORCH_CONFIG_RELPATH})`,
    `  unlink [path]                                Unlink a repo-local hidden config file`,
    `  assign --id <id> --parent <ch> --repo <dir>  Add/update a project route [--name <n>] [--keywords a,b] [--prefixes p1,p2] [--worktree <dir>]`,
    `       [--backend auto|tmux|headless|orca] [--max-iter 4] [--same-failure-limit 2] [--max-workers 3] [--no-spawn] [--gate "name=cmd"] [--qa-markers m1,m2] [--guild <id>] [--local]`,
    `  unassign <id>                                Remove a project route from global routes.json`,
    `  threads                                      List tracked Discord threads and loop state`,
    `  attach [routeId|handle] [--print]            Show/attach to the active tmux worker session`,
    `  pause|resume|stop|retry <threadId>           Control an individual thread loop`,
    `  approve|deny <gateId>                        Resolve a risky-operation approval gate`,
    `  tick [--dry-run] [--backend <kind>]          Run a single orchestrator poll/dispatch/verify tick`,
    `  daemon [--interval <ms>] [--backend <kind>]  Run foreground orchestrator daemon`,
    `  daemon install|uninstall|status              Manage macOS launchd service (${ORCH_LAUNCHD_LABEL})`,
    `  ledger [n]                                   Show last N ledger events (default 15)`,
    `  token --set <token>                          Save Discord bot token to 0600 file`,
  ];
}

export function formatRoutesLines(config: OrchConfig): string[] {
  const lines: string[] = [];
  if (config.configFiles && config.configFiles.length > 0) {
    lines.push(`Linked local config files (${config.configFiles.length}):`);
    for (const f of config.configFiles) {
      lines.push(`  - ${f}`);
    }
  }
  if (config.routes.length === 0) {
    lines.push("No project routes configured. Run `init --guild <id>` + `assign`, or `link .jeo/orch.json`.");
    return lines;
  }

  lines.push(
    `Project routes (${config.routes.length}) [guild: ${config.guildId || "(unset)"} | backend: ${config.backend ?? "auto"}]:`,
  );
  for (const r of config.routes) {
    const flag = r.enabled ? "ON " : "OFF";
    const parents = r.parentChannelIds.join(",") || "*";
    const kws = r.titleKeywords.join(",") || "*";
    const backendNote = r.backend ? ` | backend=${r.backend}` : "";
    lines.push(
      `  [${flag}] ${r.id} — ${r.name}`,
      `        parent=${parents} | keywords=${kws} | iter<=${r.maxIterations} | workers<=${r.maxWorkers} | gates=${r.verificationGates.length}${backendNote}`,
      `        repo=${r.repoPath}`,
    );
  }
  return lines;
}

export function formatThreadsLines(state: OrchState): string[] {
  const threads = Object.values(state.threads);
  if (threads.length === 0) {
    return ["No tracked Discord threads yet."];
  }
  const lines = [`Tracked threads (${threads.length}):`];
  for (const t of threads) {
    const worker = t.assignedWorkerHandle ? ` worker=${t.assignedWorkerHandle}` : "";
    const backend = t.activeBackend ? ` backend=${t.activeBackend}` : "";
    const phase = t.lastWorkerPhase ? ` phase=${t.lastWorkerPhase}` : "";
    const gate = t.pendingGate?.status === "pending" ? ` gate=${t.pendingGate.id}` : "";
    lines.push(
      `  ${t.threadId} [${t.status}] (${t.routeId}) iter=${t.iteration} pending=${t.pendingMessages.length}${worker}${backend}${phase}${gate} — ${t.name}`,
    );
    if (t.statusReason) lines.push(`        reason: ${t.statusReason}`);
  }
  return lines;
}

export async function formatDashboardLines(orchHome = resolveOrchHome(), showMenu = false): Promise<string[]> {
  const [config, state, daemon, launchd, token] = await Promise.all([
    loadOrchConfig(orchHome),
    loadOrchState(orchHome),
    isDaemonRunning(orchHome),
    getLaunchdStatus(),
    resolveDiscordToken(orchHome),
  ]);

  const resolvedBackend = await resolveOrchBackendKind(config.backend);
  const configuredBackend = config.backend ?? "auto";
  const threads = Object.values(state.threads);
  const activeCount = threads.filter(t => t.status === "QUEUED" || t.status === "DISPATCHED" || t.status === "VERIFYING").length;
  const pausedHuman = threads.filter(t => t.status === "PAUSED_NEEDS_HUMAN").length;
  const pendingGates = Object.values(state.gates).filter(g => g.status === "pending");

  const lines = [
    `=== jeo Thread Orchestrator ===`,
    `Home: ${orchHome}`,
    `Backend: ${configuredBackend}${configuredBackend !== resolvedBackend ? ` -> ${resolvedBackend}` : ""}`,
    `Daemon: ${daemon.running ? `RUNNING (pid=${daemon.lock?.pid}, since=${daemon.lock?.startedAt})` : "STOPPED"} | launchd: ${launchd.detail}`,
    `Discord: guild=${config.guildId || "(unset)"} | ownerDM=${config.ownerDmChannelId || "(auto)"} | token=${token ? "configured" : "MISSING"}`,
    `Routes: ${config.routes.length} (${config.routes.filter(r => r.enabled).length} enabled) | linkedConfigs=${config.configFiles?.length ?? 0} | poll=${config.pollIntervalMs}ms | debounce=${config.debounceMs}ms`,
    `Threads: ${threads.length} total (${activeCount} active, ${pausedHuman} needs-human) | lastPoll=${state.lastPollAt ?? "never"}`,
  ];
  if (pendingGates.length > 0) {
    lines.push(`Pending approval gates (${pendingGates.length}):`);
    for (const g of pendingGates) {
      lines.push(`  - ${g.id} [${g.routeId}/${g.threadId}] ${g.reason} ("${g.excerpt}")`);
    }
  }

  if (showMenu) {
    lines.push(
      "",
      "Quick commands:",
      "  /orch routes | /orch init <guildId> | /orch link [.jeo/orch.json] | /orch assign <id> <parentCh> <repoPath> [kw1,kw2]",
      "  /orch threads | /orch pause|resume|stop|retry <threadId>",
      "  /orch approve|deny <gateId> | /orch dry-run | /orch tick",
      "  /orch daemon status|install|uninstall | /orch ledger [n]",
    );
  }
  return lines;
}

function splitCsv(raw: string): string[] {
  return raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function parseBackendFlag(raw: string): OrchBackendKind {
  const parsed = normalizeOrchBackendKind(raw);
  if (!parsed) {
    throw new Error(`Invalid --backend '${raw}'. Expected one of: auto, tmux, headless, orca.`);
  }
  return parsed;
}

function extractBackendFlag(args: string[]): OrchBackendKind | undefined {
  const idx = args.indexOf("--backend");
  if (idx < 0) return undefined;
  return parseBackendFlag(args[idx + 1] ?? "");
}

interface ParsedInitArgs {
  guildId?: string;
  ownerDmChannelId?: string;
  ownerUserIds?: string[];
  tokenFile?: string;
  tokenEnv?: string;
  orcaBin?: string;
  backend?: OrchBackendKind;
  pollIntervalMs?: number;
  debounceMs?: number;
  configFile?: string;
  local: boolean;
  hasAnyInput: boolean;
}

function parseInitArgs(args: string[]): ParsedInitArgs {
  let guildId: string | undefined;
  let ownerDmChannelId: string | undefined;
  let ownerUserIds: string[] | undefined;
  let tokenFile: string | undefined;
  let tokenEnv: string | undefined;
  let orcaBin: string | undefined;
  let backend: OrchBackendKind | undefined;
  let pollIntervalMs: number | undefined;
  let debounceMs: number | undefined;
  let configFile: string | undefined;
  let local = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = () => args[++i] ?? "";
    if (a === "--guild") guildId = next().trim() || undefined;
    else if (a === "--dm") ownerDmChannelId = next().trim() || undefined;
    else if (a === "--owner" || a === "--owners") {
      const ids = splitCsv(next());
      if (ids.length > 0) ownerUserIds = [...(ownerUserIds ?? []), ...ids];
    } else if (a === "--token-file") tokenFile = next().trim() || undefined;
    else if (a === "--token-env") tokenEnv = next().trim() || undefined;
    else if (a === "--orca-bin") orcaBin = next().trim() || undefined;
    else if (a === "--backend") backend = parseBackendFlag(next());
    else if (a === "--poll") {
      const n = Number.parseInt(next(), 10);
      if (Number.isFinite(n) && n >= 2000) pollIntervalMs = n;
    } else if (a === "--debounce") {
      const n = Number.parseInt(next(), 10);
      if (Number.isFinite(n) && n >= 0) debounceMs = n;
    } else if (a === "--config") configFile = next().trim() || undefined;
    else if (a === "--local") local = true;
    else if (!a.startsWith("--")) positional.push(a);
  }

  if (!guildId && positional[0]) guildId = positional[0].trim();

  const hasAnyInput = Boolean(
    guildId ||
      ownerDmChannelId ||
      (ownerUserIds && ownerUserIds.length > 0) ||
      tokenFile ||
      tokenEnv ||
      orcaBin ||
      backend ||
      typeof pollIntervalMs === "number" ||
      typeof debounceMs === "number" ||
      configFile ||
      local,
  );

  return {
    guildId,
    ownerDmChannelId,
    ownerUserIds,
    tokenFile,
    tokenEnv,
    orcaBin,
    backend,
    pollIntervalMs,
    debounceMs,
    configFile,
    local,
    hasAnyInput,
  };
}

interface ParsedAssignArgs {
  route: ProjectRoute;
  guildId?: string;
  ownerDmChannelId?: string;
  ownerUserIds?: string[];
  local: boolean;
}

function parseAssignArgs(args: string[], cwd: string): ParsedAssignArgs {
  let id = "";
  let name = "";
  let parent = "";
  let repo = "";
  let worktree = "";
  let keywords = "";
  let prefixes = "";
  let qaMarkers = "";
  let maxIter = 4;
  let sameFailureLimit = 2;
  let maxWorkers = 3;
  let spawnIfBusy = true;
  let guildId: string | undefined;
  let ownerDmChannelId: string | undefined;
  let ownerUserIds: string[] | undefined;
  let local = false;
  let backend: OrchBackendKind | undefined;
  const gates: VerificationGate[] = [];
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = () => args[++i] ?? "";
    if (a === "--id") id = next();
    else if (a === "--name") name = next();
    else if (a === "--parent") parent = next();
    else if (a === "--repo") repo = next();
    else if (a === "--worktree") worktree = next();
    else if (a === "--keywords") keywords = next();
    else if (a === "--prefixes") prefixes = next();
    else if (a === "--qa-markers") qaMarkers = next();
    else if (a === "--max-iter") maxIter = Number.parseInt(next(), 10) || 4;
    else if (a === "--same-failure-limit") sameFailureLimit = Number.parseInt(next(), 10) || 2;
    else if (a === "--max-workers") maxWorkers = Number.parseInt(next(), 10) || 3;
    else if (a === "--no-spawn") spawnIfBusy = false;
    else if (a === "--backend") backend = parseBackendFlag(next());
    else if (a === "--guild") guildId = next().trim() || undefined;
    else if (a === "--dm") ownerDmChannelId = next().trim() || undefined;
    else if (a === "--owner" || a === "--owners") {
      const ids = splitCsv(next());
      if (ids.length > 0) ownerUserIds = [...(ownerUserIds ?? []), ...ids];
    } else if (a === "--local") local = true;
    else if (a === "--gate") {
      const spec = next();
      const eq = spec.indexOf("=");
      if (eq > 0) {
        gates.push({ name: spec.slice(0, eq).trim(), command: spec.slice(eq + 1).trim() });
      }
    } else if (!a.startsWith("--")) {
      positional.push(a);
    }
  }

  // Support concise positional form: assign <id> <parentChannelId> <repoPath> [keywordsCsv]
  if (!id && positional[0]) id = positional[0];
  if (!parent && positional[1]) parent = positional[1];
  if (!repo && positional[2]) repo = positional[2];
  if (!keywords && positional[3]) keywords = positional[3];

  if (!id || !parent || !repo) {
    throw new Error(
      "assign requires id, parent channel ID, and repo path. Example: assign my-app 123456789012345678 /path/to/repo kw1,kw2",
    );
  }

  const resolvedRepo = path.resolve(cwd, expandTilde(repo));
  const parsedPrefixes = prefixes ? splitCsv(prefixes) : undefined;
  const parsedQaMarkers = qaMarkers ? splitCsv(qaMarkers) : undefined;

  const route = normalizeRoute({
    id,
    name: name || id,
    enabled: true,
    parentChannelIds: splitCsv(parent),
    titleKeywords: keywords ? splitCsv(keywords) : [],
    ...(parsedPrefixes && parsedPrefixes.length > 0 ? { titlePrefixes: parsedPrefixes } : {}),
    repoPath: resolvedRepo,
    ...(worktree ? { orcaWorktreePath: path.resolve(cwd, expandTilde(worktree)) } : {}),
    maxIterations: maxIter,
    sameFailureLimit,
    maxWorkers,
    spawnIfBusy,
    verificationGates: gates,
    ...(parsedQaMarkers && parsedQaMarkers.length > 0 ? { allowBotQaMarkers: parsedQaMarkers } : {}),
    ...(backend ? { backend } : {}),
  });

  return { route, guildId, ownerDmChannelId, ownerUserIds, local };
}

export async function executeOrchAction(
  args: string[],
  opts: { orchHome?: string; prefix?: string; dashboardOnEmpty?: boolean; cwd?: string } = {},
): Promise<OrchActionResult> {
  const orchHome = resolveOrchHome(opts.orchHome);
  const prefix = opts.prefix ?? "jeo orch";
  const cwd = path.resolve(expandTilde(opts.cwd ?? process.cwd()));
  const [rawSub, ...rest] = args;
  const sub = rawSub?.toLowerCase();

  if (!sub) {
    return { lines: await formatDashboardLines(orchHome, Boolean(opts.dashboardOnEmpty)) };
  }
  if (sub === "help" || sub === "--help" || sub === "-h") {
    return { lines: orchUsageLines(prefix) };
  }
  if (sub === "status") {
    return { lines: await formatDashboardLines(orchHome, false) };
  }
  if (sub === "routes") {
    return { lines: formatRoutesLines(await loadOrchConfig(orchHome)) };
  }
  if (sub === "link") {
    const targetPath = resolveLocalOrchConfigPath(cwd, rest[0]);
    const res = await linkOrchConfigFile(targetPath, orchHome);
    return {
      lines: [
        `${res.added ? "Linked" : "Already linked"} local config ${res.linkedPath} (guild=${res.config.guildId || "(unset)"}, routes=${res.config.routes.length}).`,
        ...formatRoutesLines(res.config),
      ],
    };
  }
  if (sub === "unlink") {
    const targetPath = resolveLocalOrchConfigPath(cwd, rest[0]);
    const res = await unlinkOrchConfigFile(targetPath, orchHome);
    return {
      lines: [
        res.removed
          ? `Unlinked local config ${res.unlinkedPath}. Remaining routes: ${res.config.routes.length}.`
          : `Local config ${res.unlinkedPath} was not linked.`,
      ],
      exitCode: res.removed ? 0 : 1,
    };
  }
  if (sub === "init") {
    const parsed = parseInitArgs(rest);

    // No flags provided: auto-discover & link `<cwd>/.jeo/orch.json` if present.
    if (!parsed.hasAnyInput) {
      const defaultLocalPath = resolveLocalOrchConfigPath(cwd);
      const found = await readOrchConfigFile(defaultLocalPath);
      if (found) {
        const res = await linkOrchConfigFile(defaultLocalPath, orchHome);
        return {
          lines: [
            `Linked repo-local config ${res.linkedPath} (guild=${res.config.guildId || "(unset)"}, routes=${res.config.routes.length}).`,
            ...formatRoutesLines(res.config),
          ],
        };
      }
      return {
        lines: [
          `Usage: ${prefix} init <guildId> [--dm <channelId>] [--owner <u1,u2>] [--backend auto|tmux|headless|orca] [--poll <ms>] [--debounce <ms>] [--token-file <path>] [--token-env <var>] [--orca-bin <path>] [--local]`,
          `   or: ${prefix} init --config <path-to-.jeo/orch.json>  (or place ${LOCAL_ORCH_CONFIG_RELPATH} in this repo and re-run \`${prefix} init\`)`,
        ],
        exitCode: 1,
      };
    }

    if (parsed.local) {
      const targetPath = resolveLocalOrchConfigPath(cwd, parsed.configFile);
      const cfg = await initOrchConfig(
        {
          guildId: parsed.guildId,
          ownerDmChannelId: parsed.ownerDmChannelId,
          ownerUserIds: parsed.ownerUserIds,
          tokenFile: parsed.tokenFile,
          tokenEnv: parsed.tokenEnv,
          orcaBin: parsed.orcaBin,
          backend: parsed.backend,
          pollIntervalMs: parsed.pollIntervalMs,
          debounceMs: parsed.debounceMs,
          writeLocalPath: targetPath,
        },
        orchHome,
      );
      return {
        lines: [
          `Saved and linked repo-local config ${targetPath} (guild=${cfg.guildId || "(unset)"}, owners=${cfg.ownerUserIds.length}, routes=${cfg.routes.length}).`,
          ...formatRoutesLines(cfg),
        ],
      };
    }

    if (parsed.configFile) {
      const resolvedConfig = resolveLocalOrchConfigPath(cwd, parsed.configFile);
      const cfg = await initOrchConfig({ configFile: resolvedConfig }, orchHome);
      return {
        lines: [
          `Linked config file ${resolvedConfig} into ${orchHome}/routes.json (guild=${cfg.guildId || "(unset)"}, routes=${cfg.routes.length}).`,
          ...formatRoutesLines(cfg),
        ],
      };
    }

    const cfg = await initOrchConfig(
      {
        guildId: parsed.guildId,
        ownerDmChannelId: parsed.ownerDmChannelId,
        ownerUserIds: parsed.ownerUserIds,
        tokenFile: parsed.tokenFile,
        tokenEnv: parsed.tokenEnv,
        orcaBin: parsed.orcaBin,
        backend: parsed.backend,
        pollIntervalMs: parsed.pollIntervalMs,
        debounceMs: parsed.debounceMs,
      },
      orchHome,
    );
    return {
      lines: [
        `Updated orchestrator config in ${orchHome}/routes.json (guild=${cfg.guildId || "(unset)"}, backend=${cfg.backend ?? "auto"}, owners=${cfg.ownerUserIds.length}, routes=${cfg.routes.length}).`,
        ...formatRoutesLines(cfg),
      ],
    };
  }
  if (sub === "assign") {
    const { route, guildId, ownerDmChannelId, ownerUserIds, local } = parseAssignArgs(rest, cwd);
    if (local) {
      const localPath = resolveLocalOrchConfigPath(route.repoPath);
      const existing = (await readOrchConfigFile(localPath))?.data ?? {};
      const existingRoutes = Array.isArray(existing.routes)
        ? [...existing.routes]
        : existing.route
          ? [existing.route]
          : [];
      const localRoute: Partial<ProjectRoute> = {
        ...route,
        repoPath: ".",
      };
      const idx = existingRoutes.findIndex(r => r.id === route.id);
      if (idx === -1) existingRoutes.push(localRoute);
      else existingRoutes[idx] = localRoute;

      const updatedLocal: OrchConfigFile = {
        ...existing,
        ...(guildId ? { guildId } : {}),
        ...(ownerDmChannelId ? { ownerDmChannelId } : {}),
        ...(ownerUserIds?.length
          ? { ownerUserIds: Array.from(new Set([...(existing.ownerUserIds ?? []), ...ownerUserIds])) }
          : {}),
        ...(existingRoutes.length === 1
          ? { route: existingRoutes[0], routes: undefined }
          : { route: undefined, routes: existingRoutes }),
      };
      await writeLocalOrchConfigFile(localPath, updatedLocal);
      const linked = await linkOrchConfigFile(localPath, orchHome);
      return {
        lines: [
          `Saved route '${route.id}' to ${localPath} and linked it (parent=${route.parentChannelIds.join(",")}, keywords=${route.titleKeywords.join(",") || "*"}).`,
          `Total routes: ${linked.config.routes.length}`,
        ],
      };
    }

    if (guildId || ownerDmChannelId || ownerUserIds?.length) {
      await initOrchConfig({ guildId, ownerDmChannelId, ownerUserIds }, orchHome);
    }
    const updated = await upsertRoute(route, orchHome);
    return {
      lines: [
        `Assigned route '${route.id}' -> ${route.repoPath} (parent=${route.parentChannelIds.join(",")}, keywords=${route.titleKeywords.join(",") || "*"}).`,
        `Total routes: ${updated.config.routes.length}`,
      ],
    };
  }

  if (sub === "unassign") {
    const targetId = rest[0]?.trim();
    if (!targetId) return { lines: [`Usage: ${prefix} unassign <routeId>`], exitCode: 1 };
    const { removed, config, linkedConfigPath } = await removeRoute(targetId, orchHome);
    const quotedLinked = linkedConfigPath
      ? /\s/.test(linkedConfigPath)
        ? JSON.stringify(linkedConfigPath)
        : linkedConfigPath
      : undefined;
    return {
      lines: [
        removed
          ? linkedConfigPath
            ? `Removed route '${targetId}' from local routes.json, but it is still active via linked config ${linkedConfigPath}. Edit that file or run \`${prefix} unlink ${quotedLinked}\`.`
            : `Removed route '${targetId}'. Remaining routes: ${config.routes.length}.`
          : linkedConfigPath
            ? `Route '${targetId}' is defined in linked local config ${linkedConfigPath}. Edit that file or run \`${prefix} unlink ${quotedLinked}\`.`
            : `Route '${targetId}' not found.`,
      ],
      exitCode: removed ? 0 : 1,
    };
  }
  if (sub === "threads") {
    return { lines: formatThreadsLines(await loadOrchState(orchHome)) };
  }
  if (sub === "attach") {
    const target = rest.find(a => !a.startsWith("--"))?.trim();
    const [config, state] = await Promise.all([loadOrchConfig(orchHome), loadOrchState(orchHome)]);
    const tmuxBackend = new TmuxWorkerBackend({ orchHome });

    let attachCmd: string[] | undefined;
    let detail = "";

    if (target) {
      if (parseTmuxWorkerHandle(target) || target.startsWith("jeo-orch-")) {
        attachCmd = (await tmuxBackend.resolveAttachCommand(target)) ?? tmuxBackend.attachCommand(target);
        detail = `handle=${target}`;
      } else {
        const matchedThread = state.threads[target];
        if (matchedThread?.assignedWorkerHandle) {
          attachCmd = await tmuxBackend.resolveAttachCommand(matchedThread.assignedWorkerHandle);
          detail = `thread=${matchedThread.threadId} worker=${matchedThread.assignedWorkerHandle}`;
        }
        if (!attachCmd) {
          const routeId = matchedThread?.routeId ?? target;
          const route = config.routes.find(r => r.id === routeId);
          if (route) {
            const worktree = route.orcaWorktreePath ?? route.repoPath;
            const workers = await tmuxBackend.listRepoWorkers(worktree);
            const sessionName = workers[0]?.sessionName ?? tmuxSessionNameForRepo(worktree);
            attachCmd = ["tmux", "attach-session", "-t", sessionName];
            detail = workers[0]
              ? `route=${route.id} worker=${workers[0].handle} session=${sessionName}`
              : `route=${route.id} session=${sessionName} (not running yet)`;
          }
        }
      }
    } else {
      const activeTmuxThread = Object.values(state.threads).find(
        t => t.assignedWorkerHandle && parseTmuxWorkerHandle(t.assignedWorkerHandle),
      );
      if (activeTmuxThread?.assignedWorkerHandle) {
        attachCmd = await tmuxBackend.resolveAttachCommand(activeTmuxThread.assignedWorkerHandle);
        detail = `thread=${activeTmuxThread.threadId} worker=${activeTmuxThread.assignedWorkerHandle}`;
      }
      if (!attachCmd) {
        for (const route of config.routes) {
          const worktree = route.orcaWorktreePath ?? route.repoPath;
          const workers = await tmuxBackend.listRepoWorkers(worktree);
          if (workers.length > 0) {
            const sessionName = workers[0]!.sessionName ?? tmuxSessionNameForRepo(worktree);
            attachCmd = ["tmux", "attach-session", "-t", sessionName];
            detail = `route=${route.id} worker=${workers[0]!.handle} session=${sessionName}`;
            break;
          }
        }
      }
      if (!attachCmd && config.routes.length === 1) {
        const onlyRoute = config.routes[0]!;
        const sessionName = tmuxSessionNameForRepo(onlyRoute.orcaWorktreePath ?? onlyRoute.repoPath);
        attachCmd = ["tmux", "attach-session", "-t", sessionName];
        detail = `route=${onlyRoute.id} session=${sessionName}`;
      }
    }

    if (!attachCmd) {
      return {
        lines: [
          target
            ? `Could not resolve a tmux worker or route for '${target}'.`
            : "No active tmux worker session found. Pass a routeId or worker handle: `attach <routeId|handle>`.",
        ],
        exitCode: 1,
      };
    }

    return {
      lines: [
        `Attach (${detail}):`,
        `  ${attachCmd.join(" ")}`,
      ],
      attachCommand: attachCmd,
    };
  }
  if (sub === "pause" || sub === "resume" || sub === "stop" || sub === "retry") {
    const threadId = rest[0]?.trim();
    if (!threadId) return { lines: [`Usage: ${prefix} ${sub} <threadId>`], exitCode: 1 };
    const state = await loadOrchState(orchHome);
    const thread = state.threads[threadId];
    if (!thread) return { lines: [`Thread '${threadId}' not found in state.json.`], exitCode: 1 };

    if (sub === "pause") {
      thread.status = "PAUSED";
      thread.lastWorkerPhase = undefined;
      thread.statusReason = "Paused via CLI/slash";
    } else if (sub === "resume") {
      if (thread.pendingGate?.status === "pending") {
        return {
          lines: [`Cannot resume '${threadId}': pending approval gate '${thread.pendingGate.id}' must be approved or denied first.`],
          exitCode: 1,
        };
      }
      thread.status = thread.pendingMessages.length > 0 || thread.lastFailureSummary ? "QUEUED" : "IDLE";
      thread.statusReason = "Resumed via CLI/slash";
    } else if (sub === "stop") {
      thread.status = "STOPPED";
      thread.pendingMessages = [];
      thread.assignedWorkerHandle = undefined;
      {
        const threadDyn = thread as unknown as Record<string, unknown>;
        threadDyn.workerHandle = undefined;
        threadDyn.lastDispatchedMessages = undefined;
      }
      if (thread.pendingGate?.status === "pending") {
        const gate = state.gates[thread.pendingGate.id] ?? thread.pendingGate;
        gate.status = "denied";
        gate.resolvedAt = new Date().toISOString();
        gate.resolvedBy = "cli (stop)";
        state.gates[gate.id] = gate;
        thread.pendingGate = undefined;
      }
      thread.workerObservedBusy = undefined;
      thread.lastWorkerPhase = undefined;
      thread.statusMessageId = undefined;
      thread.lastStatusContent = undefined;
      thread.statusReason = "Stopped via CLI/slash";
    } else {
      if (thread.pendingGate?.status === "pending") {
        return {
          lines: [`Cannot retry '${threadId}': pending approval gate '${thread.pendingGate.id}' must be approved or denied first.`],
          exitCode: 1,
        };
      }
      thread.iteration = 0;
      thread.consecutiveSameFailures = 0;
      thread.lastFailureHash = undefined;
      {
        const threadDyn = thread as unknown as Record<string, unknown>;
        threadDyn.consecutiveFailureCount = 0;
        threadDyn.consecutiveFailureHash = undefined;
        threadDyn.workerHandle = undefined;
        threadDyn.lastDispatchedMessages = undefined;
      }
      thread.assignedWorkerHandle = undefined;
      thread.workerObservedBusy = undefined;
      thread.lastWorkerPhase = undefined;
      thread.statusMessageId = undefined;
      thread.lastStatusContent = undefined;
      thread.status = "QUEUED";
      thread.lastPendingAtMs = 0;
      thread.statusReason = "Manual retry via CLI/slash";
    }
    thread.updatedAt = new Date().toISOString();
    await saveOrchState(state, orchHome);
    return { lines: [`Thread ${threadId} (${thread.name}) -> ${thread.status}`] };
  }
  if (sub === "approve" || sub === "deny") {
    const gateId = rest[0]?.trim();
    if (!gateId) return { lines: [`Usage: ${prefix} ${sub} <gateId>`], exitCode: 1 };
    const state = await loadOrchState(orchHome);
    const gate = state.gates[gateId];
    if (!gate || gate.status !== "pending") {
      return { lines: [`Pending approval gate '${gateId}' not found.`], exitCode: 1 };
    }
    const nowIso = new Date().toISOString();
    gate.status = sub === "approve" ? "approved" : "denied";
    gate.resolvedAt = nowIso;
    gate.resolvedBy = "local-cli";
    const thread = state.threads[gate.threadId];
    if (thread) {
      if (sub === "approve") {
        if (thread.pendingGate?.id === gate.id) thread.pendingGate = gate;
        thread.status = "QUEUED";
        thread.lastPendingAtMs = 0;
        thread.statusReason = `Approved gate ${gate.id}`;
      } else {
        if (thread.pendingGate?.id === gate.id) thread.pendingGate = undefined;
        thread.pendingMessages = [];
        thread.status = "IDLE";
        thread.statusReason = `Denied gate ${gate.id}`;
      }
      thread.updatedAt = nowIso;
    }
    await saveOrchState(state, orchHome);
    return { lines: [`Gate ${gateId} ${gate.status}${thread ? ` (thread ${thread.threadId} -> ${thread.status})` : ""}.`] };
  }
  if (sub === "tick" || sub === "dry-run") {
    const dryRun = sub === "dry-run" || rest.includes("--dry-run");
    const backend = extractBackendFlag(rest);
    const logs: string[] = [];
    const summary = await runOrchOnce({ dryRun, orchHome, backend, log: m => logs.push(m) });
    return {
      lines: [
        ...logs,
        `${dryRun ? "[dry-run] " : ""}tick complete: discovered=${summary.discovered} queued=${summary.queued} dispatched=${summary.dispatched} verified=${summary.verified} escalated=${summary.escalated}`,
        ...(summary.errors.length ? summary.errors.map(e => `  error: ${e}`) : []),
      ],
      exitCode: summary.errors.length ? 1 : 0,
    };
  }
  if (sub === "token") {
    const idx = rest.indexOf("--set");
    const tok = idx >= 0 ? rest[idx + 1] : rest[0];
    if (!tok || tok.startsWith("--")) {
      return { lines: [`Usage: ${prefix} token --set <discord-bot-token>`], exitCode: 1 };
    }
    const savedPath = await saveDiscordToken(tok, orchHome);
    return { lines: [`Saved Discord bot token (0600) to ${savedPath}`] };
  }
  if (sub === "ledger") {
    const n = Number.parseInt(rest[0] ?? "15", 10);
    const entries = await readRecentLedger(Number.isFinite(n) && n > 0 ? n : 15, orchHome);
    if (entries.length === 0) return { lines: ["Ledger is empty."] };
    return {
      lines: entries.map(e => `${e.ts} [${e.event}] route=${e.routeId ?? "-"} thread=${e.threadId ?? "-"} iter=${e.iteration ?? "-"} ${JSON.stringify(e.detail)}`),
    };
  }
  const daemonSub = sub === "daemon" ? rest[0]?.toLowerCase() : undefined;
  if (sub === "install-launchd" || daemonSub === "install") {
    const res = await installLaunchdService({ orchHome });
    return { lines: [`launchd (${ORCH_LAUNCHD_LABEL}): ${res.detail}`, `plist: ${res.plistPath}`], exitCode: res.loaded || process.platform !== "darwin" ? 0 : 1 };
  }
  if (sub === "uninstall-launchd" || daemonSub === "uninstall") {
    const res = await uninstallLaunchdService();
    return { lines: [`launchd (${ORCH_LAUNCHD_LABEL}): ${res.detail}`] };
  }
  if (sub === "launchd-status" || daemonSub === "status") {
    const [daemon, launchd] = await Promise.all([isDaemonRunning(orchHome), getLaunchdStatus()]);
    return {
      lines: [
        `Daemon process: ${daemon.running ? `RUNNING (pid=${daemon.lock?.pid}, since=${daemon.lock?.startedAt})` : "STOPPED"}`,
        `launchd (${ORCH_LAUNCHD_LABEL}): ${launchd.detail} (${launchd.plistPath})`,
      ],
    };
  }
  if (sub === "daemon") {
    if (daemonSub && !daemonSub.startsWith("--")) {
      return {
        lines: [
          `Unknown daemon subcommand: ${rest[0]}.`,
          `Usage: ${prefix} daemon [install | status | uninstall | --interval <ms>]`,
        ],
        exitCode: 1,
      };
    }
    const intervalIdx = rest.indexOf("--interval");
    const pollIntervalMs = intervalIdx >= 0 ? Number.parseInt(rest[intervalIdx + 1] ?? "", 10) : undefined;
    const backend = extractBackendFlag(rest);
    await runOrchDaemon({
      orchHome,
      pollIntervalMs: pollIntervalMs && Number.isFinite(pollIntervalMs) ? pollIntervalMs : undefined,
      backend,
    });
    return { lines: [] };
  }
  return {
    lines: [`Unknown orch subcommand: ${sub}`, ...orchUsageLines(prefix)],
    exitCode: 1,
  };
}

export async function runOrch(args: string[]): Promise<void> {
  const result = await executeOrchAction(args, { prefix: "jeo orch" });
  for (const line of result.lines) {
    console.log(line);
  }
  if (result.attachCommand && !args.includes("--print") && process.stdin.isTTY && process.stdout.isTTY) {
    const cmd =
      process.env.TMUX && result.attachCommand[0] === "tmux" && result.attachCommand[1] === "attach-session"
        ? ["tmux", "switch-client", ...result.attachCommand.slice(2)]
        : result.attachCommand;
    const proc = Bun.spawnSync(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    if (proc.exitCode !== 0) {
      process.exitCode = proc.exitCode;
    }
    return;
  }
  if (result.exitCode && result.exitCode !== 0) {
    process.exitCode = result.exitCode;
  }
}
