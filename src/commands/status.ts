import * as fs from "node:fs/promises";
import * as path from "node:path";
import chalk from "chalk";
import pkg from "../../package.json";
import { buildRecoverySnapshot, readGlobalConfig, type WorkflowRecoverySnapshot } from "../agent/state";
import { listSessions } from "../agent/session";
import { readGoalState } from "../agent/goal-verifier";
import { daemonStatus, type DaemonStatus } from "../agent/notify/daemon-control";
import { describeAllProviders, type CredentialKind } from "../ai/provider-status";

export interface StatusProviderSummary {
  name: string;
  ready: boolean;
  authKind: CredentialKind;
  loggedIn?: boolean;
  custom?: boolean;
}

export interface StatusSessionSummary {
  id: string;
  timestamp: string;
  messageCount: number;
  model?: string;
  title?: string;
  preview: string;
  sizeBytes?: number;
}

export interface StatusGoalSummary {
  active: boolean;
  condition?: string;
  setAt?: number;
  pendingMutationVerification: boolean;
  lastVerdict?: {
    at: number;
    verdict: "MET" | "NOT_MET" | "IMPOSSIBLE";
    gap?: string;
  };
}

export interface StatusDaemonSummary {
  configured: boolean;
  running: boolean;
  ready?: boolean;
  stale: boolean;
  pairing?: boolean;
  pid?: number;
  startedAt?: number;
  channels: {
    telegram: boolean;
    discord: boolean;
    slack: boolean;
  };
}

export interface StatusDto {
  version: string;
  cwd: string;
  defaultModel?: string;
  providers: StatusProviderSummary[];
  sessions: {
    total: number;
    latestId?: string;
    selected?: StatusSessionSummary;
    recent: StatusSessionSummary[];
  };
  workflow: WorkflowRecoverySnapshot;
  goal: StatusGoalSummary;
  daemon: StatusDaemonSummary;
  evolution: {
    planCompleted: number;
    planTotal: number;
    activeTarget?: string;
    activeStage?: string;
    recentCount: number;
    avgToolDurationMs?: number;
    toolSuccessRatePct?: number;
  };
}

function sanitizeSessionSummary(s: {
  id: string;
  timestamp: string;
  messageCount: number;
  model?: string;
  title?: string;
  preview: string;
  sizeBytes?: number;
}): StatusSessionSummary {
  return {
    id: s.id,
    timestamp: s.timestamp,
    messageCount: s.messageCount,
    ...(s.model ? { model: s.model } : {}),
    ...(s.title ? { title: s.title } : {}),
    preview: s.preview.slice(0, 60),
    ...(typeof s.sizeBytes === "number" ? { sizeBytes: s.sizeBytes } : {}),
  };
}

/**
 * Build a credential-free, read-only status DTO for the workspace and local
 * runtime. Never exposes API keys, OAuth access/refresh tokens, account emails,
 * bot/app tokens, or raw session transcripts/drafts.
 */
export async function buildStatusDto(
  cwd: string = process.cwd(),
  opts: { sessionId?: string } = {}
): Promise<StatusDto> {
  const [config, sessions, workflow, goalState, daemon] = await Promise.all([
    readGlobalConfig(),
    listSessions(cwd).catch(() => []),
    buildRecoverySnapshot(cwd),
    readGoalState(cwd).catch(() => null),
    daemonStatus().catch((): DaemonStatus => ({ configured: false, running: false, stale: false })),
  ]);

  const rawProviders = await describeAllProviders(config);
  const providers: StatusProviderSummary[] = rawProviders.map(p => ({
    name: p.name,
    ready: p.ready,
    authKind: p.kind,
    ...(typeof p.loggedIn === "boolean" ? { loggedIn: p.loggedIn } : {}),
    ...(p.custom ? { custom: true } : {}),
  }));

  const recentSessions = sessions.slice(0, 10).map(sanitizeSessionSummary);
  const selectedRaw = opts.sessionId
    ? sessions.find(s => s.id === opts.sessionId || s.id.toLowerCase().startsWith(opts.sessionId!.toLowerCase()))
    : sessions[0];
  const selected = selectedRaw ? sanitizeSessionSummary(selectedRaw) : undefined;

  const lastVerdict = goalState?.verdicts?.length
    ? goalState.verdicts[goalState.verdicts.length - 1]
    : undefined;
  const goal: StatusGoalSummary = goalState
    ? {
        active: true,
        condition: goalState.condition,
        setAt: goalState.setAt,
        pendingMutationVerification: goalState.pendingMutationVerification === true,
        ...(lastVerdict ? { lastVerdict } : {}),
      }
    : {
        active: false,
        pendingMutationVerification: false,
      };

  const n = config.notifications;
  const channels = {
    telegram: Boolean(n?.telegram?.botToken && n.telegram.chatId),
    discord: Boolean(n?.discord?.botToken && n.discord.channelId && n.discord.allowedUserIds?.length),
    slack: Boolean(n?.slack?.botToken && n.slack.appToken && n.slack.channelId && n.slack.allowedUserIds?.length),
  };

  // Optional evolution & performance metrics
  let planCompleted = 0;
  let planTotal = 0;
  try {
    const planContent = await fs.readFile(path.join(cwd, ".specify", "plan.md"), "utf-8");
    const tasks = planContent.match(/- \[[x ]\] .+/g) || [];
    planCompleted = tasks.filter(t => t.startsWith("- [x]")).length;
    planTotal = tasks.length;
  } catch {}

  let activeTarget: string | undefined;
  let activeStage: string | undefined;
  let recentCount = 0;
  try {
    const logs = JSON.parse(await fs.readFile(path.join(cwd, "logs", "evolution-log.json"), "utf-8"));
    if (Array.isArray(logs)) {
      recentCount = logs.length;
      const activeTask = logs.find((l: any) => l.status === "in_progress");
      if (activeTask) {
        activeTarget = activeTask.target;
        activeStage = activeTask.stage;
      }
    }
  } catch {}

  let avgToolDurationMs: number | undefined;
  let toolSuccessRatePct: number | undefined;
  try {
    let perfContent = "";
    try {
      perfContent = await fs.readFile(path.join(cwd, ".jeo", "state", "performance-metrics.json"), "utf-8");
    } catch {
      perfContent = await fs.readFile(path.join(cwd, "logs", "performance-metrics.json"), "utf-8");
    }
    const metrics = JSON.parse(perfContent);
    if (Array.isArray(metrics) && metrics.length > 0) {
      const recent = metrics.slice(-50);
      avgToolDurationMs = Math.round(recent.reduce((sum: number, m: any) => sum + (Number(m.duration) || 0), 0) / recent.length);
      toolSuccessRatePct = Number(((recent.filter((m: any) => m.success).length / recent.length) * 100).toFixed(1));
    }
  } catch {}

  return {
    version: pkg.version,
    cwd,
    ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
    providers,
    sessions: {
      total: sessions.length,
      ...(sessions[0]?.id ? { latestId: sessions[0].id } : {}),
      ...(selected ? { selected } : {}),
      recent: recentSessions,
    },
    workflow,
    goal,
    daemon: {
      configured: daemon.configured,
      running: daemon.running,
      ...(typeof daemon.ready === "boolean" ? { ready: daemon.ready } : {}),
      stale: daemon.stale,
      ...(daemon.pairing ? { pairing: true } : {}),
      ...(typeof daemon.pid === "number" ? { pid: daemon.pid } : {}),
      ...(typeof daemon.startedAt === "number" ? { startedAt: daemon.startedAt } : {}),
      channels,
    },
    evolution: {
      planCompleted,
      planTotal,
      ...(activeTarget ? { activeTarget } : {}),
      ...(activeStage ? { activeStage } : {}),
      recentCount,
      ...(avgToolDurationMs !== undefined ? { avgToolDurationMs } : {}),
      ...(toolSuccessRatePct !== undefined ? { toolSuccessRatePct } : {}),
    },
  };
}

export async function runStatusCommand(args: string[] = [], cwd: string = process.cwd()): Promise<void> {
  const json = args.includes("--json");
  let sessionId: string | undefined;
  const sessionIdx = args.indexOf("--session");
  if (sessionIdx !== -1 && args[sessionIdx + 1] && !args[sessionIdx + 1]!.startsWith("-")) {
    sessionId = args[sessionIdx + 1];
  } else {
    const inline = args.find(a => a.startsWith("--session="));
    if (inline) sessionId = inline.slice("--session=".length);
  }

  const dto = await buildStatusDto(cwd, { sessionId });
  if (json) {
    console.log(JSON.stringify(dto, null, 2));
    return;
  }

  console.log(chalk.bold(`\n=== jeo Status (v${dto.version}) ===`));
  console.log(`Workspace:     ${dto.cwd}`);
  console.log(`Default Model: ${dto.defaultModel ?? "(not set)"}`);

  const readyProviders = dto.providers.filter(p => p.ready).map(p => `${p.name} (${p.authKind})`);
  console.log(`Ready Auth:    ${readyProviders.length > 0 ? readyProviders.join(", ") : "none"}`);

  console.log(chalk.bold("\n=== Sessions & Workflow Contract ==="));
  console.log(`Saved Sessions: ${dto.sessions.total}${dto.sessions.latestId ? ` (latest: ${dto.sessions.latestId})` : ""}`);
  if (dto.sessions.selected) {
    const s = dto.sessions.selected;
    console.log(`Selected:       ${s.id} · ${s.messageCount} msgs${s.model ? ` · ${s.model}` : ""}${s.title ? ` · "${s.title}"` : ""}`);
  }
  console.log(`Contract ID:    ${dto.workflow.contract_id ?? "(none)"}`);
  console.log(`Active Skill:   ${dto.workflow.active_skill ?? "none"}${dto.workflow.current_phase ? ` (${dto.workflow.current_phase})` : ""}`);
  console.log(`Source Drift:   ${dto.workflow.source_drift ? chalk.red("YES") : chalk.green("no")}`);
  console.log(`Next Action:    ${chalk.cyan(dto.workflow.next_action)}`);

  if (dto.goal.active) {
    console.log(chalk.bold("\n=== Active Goal Gate ==="));
    console.log(`Condition:      ${dto.goal.condition}`);
    console.log(`Pending Verify: ${dto.goal.pendingMutationVerification ? chalk.yellow("yes") : "no"}`);
    if (dto.goal.lastVerdict) {
      console.log(`Last Verdict:   ${dto.goal.lastVerdict.verdict}${dto.goal.lastVerdict.gap ? ` (${dto.goal.lastVerdict.gap})` : ""}`);
    }
  }

  console.log(chalk.bold("\n=== Notification Daemon ==="));
  const daemonState = dto.daemon.running
    ? `running (pid ${dto.daemon.pid})`
    : dto.daemon.stale
      ? "stale lock"
      : "stopped";
  console.log(`Daemon State:   ${daemonState}`);

  if (dto.evolution.planTotal > 0) {
    const percentage = (dto.evolution.planCompleted / dto.evolution.planTotal) * 100;
    const barWidth = 30;
    const filledWidth = Math.round((dto.evolution.planCompleted / dto.evolution.planTotal) * barWidth);
    const bar = chalk.green("█").repeat(filledWidth) + chalk.gray("░").repeat(barWidth - filledWidth);
    console.log(chalk.bold("\nOverall Project Progress: [" + bar + "] " + percentage.toFixed(1) + "%"));
    console.log(chalk.dim(`(${dto.evolution.planCompleted}/${dto.evolution.planTotal} tasks completed from plan.md)`));
  }

  console.log(chalk.bold("\n=== Engine Performance Metrics ==="));
  if (dto.evolution.avgToolDurationMs !== undefined && dto.evolution.toolSuccessRatePct !== undefined) {
    console.log("Average Tool Time: " + chalk.magenta(dto.evolution.avgToolDurationMs + "ms"));
    const successColor = dto.evolution.toolSuccessRatePct > 90 ? chalk.green : chalk.yellow;
    console.log("Tool Success Rate: " + successColor(dto.evolution.toolSuccessRatePct.toFixed(1) + "%"));
  } else {
    console.log("Performance metrics unavailable.");
  }
  console.log("");
}
