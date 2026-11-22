/**
 * Deterministic multi-project Discord thread orchestrator state machine.
 *
 * Per-thread lifecycle:
 *   DISCOVERED -> QUEUED -> DISPATCHED -> VERIFYING -> IDLE | QUEUED (next iter) | PAUSED_NEEDS_HUMAN
 */

import { randomBytes } from "node:crypto";
import { DISCORD_SILENT_FLAGS, type DiscordClient } from "./discord-api";
import { classifyMessage, compareSnowflakes, detectRiskyOperation, matchRoute, type OrchThreadCommand } from "./matcher";
import type { OrcaClient } from "./orca";
import { appendLedger, loadOrchConfig, loadOrchState, resolveOrchHome, saveOrchState } from "./store";
import type {
  ApprovalGate,
  DiscordThread,
  OrchConfig,
  OrchState,
  ProjectRoute,
  QueuedMessage,
  ThreadLoopState,
  WorkerActivityPhase,
} from "./types";
import type { GateVerifier } from "./verifier";

const DISPATCH_MIN_GRACE_MS = 15_000;

export interface OrchEngineDeps {
  discord: DiscordClient;
  orca: OrcaClient;
  verifier: GateVerifier;
  orchHome?: string;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface TickSummary {
  discovered: number;
  queued: number;
  dispatched: number;
  verified: number;
  escalated: number;
  errors: string[];
}

function makeGateId(): string {
  return `gate_${randomBytes(3).toString("hex")}`;
}

function formatElapsedCompact(startIso: string | undefined, nowMs: number): string {
  if (!startIso) return "진행 중";
  const startMs = Date.parse(startIso);
  if (!Number.isFinite(startMs)) return "진행 중";
  const secs = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  if (secs < 60) return "1분 미만";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}분 경과`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}시간 ${remMins}분 경과` : `${hrs}시간 경과`;
}

function formatElapsedExact(startIso: string | undefined, nowMs: number): string {
  if (!startIso) return "0초";
  const startMs = Date.parse(startIso);
  if (!Number.isFinite(startMs)) return "0초";
  const secs = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  if (secs < 60) return `${secs}초`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return remSecs > 0 ? `${mins}분 ${remSecs}초` : `${mins}분`;
}

function phaseBadge(phase: WorkerActivityPhase): { emoji: string; label: string } {
  switch (phase) {
    case "thinking":
      return { emoji: "🧠", label: "Thinking..." };
    case "planning":
      return { emoji: "🗺️", label: "Planning..." };
    case "executing":
      return { emoji: "⚙️", label: "Executing..." };
    case "reporting":
      return { emoji: "📝", label: "Reporting..." };
    default:
      return { emoji: "⏳", label: "Working..." };
  }
}

export function formatThinkingStatus(params: {
  route: ProjectRoute;
  iteration: number;
  workerHandle: string;
  phase: WorkerActivityPhase;
  elapsedLabel: string;
  activity?: string;
}): string {
  const badge = phaseBadge(params.phase);
  const detail = params.activity?.trim() ? `\n> \`${params.activity.trim().replace(/`/g, "'")}\`` : "";
  return `${badge.emoji} **[사이클 ${params.iteration}/${params.route.maxIterations} · ${badge.label}]** \`${params.route.name}\` — 워커 \`${params.workerHandle}\` · ${params.elapsedLabel}${detail}`;
}
export function buildWorkerPrompt(route: ProjectRoute, thread: ThreadLoopState, nextIter: number): string {
  const userMsgs = thread.pendingMessages
    .map(m => `- [${m.kind === "qa_fail_trigger" ? "QA_FAIL" : m.authorName}] ${m.content}`)
    .join("\n");

  const gatesList = route.verificationGates.length
    ? route.verificationGates.map(g => `- ${g.name}: \`${g.command}\``).join("\n")
    : "- (no automated gates configured; run relevant project tests)";

  const prevFailureBlock = thread.lastFailureSummary
    ? `\n### Previous Verification Failures (Fix These Root Causes)\n${thread.lastFailureSummary}\n`
    : "";

  return [
    `[jeo /orch — Thread Recursive Improvement Cycle ${nextIter}/${route.maxIterations}]`,
    `Project: ${route.name} (${route.id})`,
    `Repo: ${route.repoPath}`,
    `Discord Thread: #${thread.name} (${thread.threadId})`,
    "",
    "### Trigger / Feedback",
    userMsgs || "(Autonomous recursive fix cycle based on verification gate failures below)",
    prevFailureBlock,
    "### Verification Gates (Must Pass Before Finishing)",
    gatesList,
    "",
    "### Safety & Execution Rules",
    "- Make minimal, root-cause fixes in this repo and verify with the gates above.",
    "- NEVER run `git push --force`, destructive `rm -rf`, `git reset --hard`, or external deploy commands without explicit user approval.",
    "- Summarize concrete changed files and verification results when done.",
  ].join("\n");
}

export class OrchEngine {
  private readonly orchHome: string;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private botUserRefreshed = false;

  constructor(private readonly deps: OrchEngineDeps) {
    this.orchHome = resolveOrchHome(deps.orchHome);
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? (() => undefined);
  }

  private async persist(state: OrchState, dryRun: boolean): Promise<void> {
    if (!dryRun) {
      await saveOrchState(state, this.orchHome);
    }
  }

  async tick(opts: { dryRun?: boolean } = {}): Promise<TickSummary> {
    const dryRun = !!opts.dryRun;
    const summary: TickSummary = { discovered: 0, queued: 0, dispatched: 0, verified: 0, escalated: 0, errors: [] };
    const config = await loadOrchConfig(this.orchHome);
    this.deps.orca.setOrcaBin?.(config.orcaBin);
    const state = await loadOrchState(this.orchHome);

    if (!config.guildId) {
      summary.errors.push("No guildId configured (run `jeo orch init --guild <id>` or link `.jeo/orch.json`).");
      return summary;
    }

    if (!this.botUserRefreshed) {
      try {
        const me = await this.deps.discord.getSelfUser();
        if (me?.id) {
          state.botUserId = me.id;
          this.botUserRefreshed = true;
        }
      } catch {
        // keeping existing cached value if the call fails; retry on next tick
      }
    }

    if (!state.botUserId) {
      try {
        const me = await this.deps.discord.getSelfUser();
        state.botUserId = me.id;
      } catch {
        // ignore
      }
    }

    // 1) Discover active threads and bind matching routes
    const activeThreads = await this.deps.discord.listActiveThreads(config.guildId);
    const activeThreadIds = new Set(activeThreads.map(t => t.id));
    const routeById = new Map(config.routes.map(r => [r.id, r]));

    for (const thread of activeThreads) {
      const matched = matchRoute(thread, config.routes);
      if (!matched) continue;
      if (!state.threads[thread.id]) {
        await this.initializeThread(state, thread, matched, dryRun);
        summary.discovered++;
      } else {
        state.threads[thread.id]!.name = thread.name;
        state.threads[thread.id]!.routeId = matched.id;
      }
    }

    // 2) Poll new messages for every tracked active thread
    for (const threadState of Object.values(state.threads)) {
      const route = routeById.get(threadState.routeId);
      if (!route || !route.enabled) continue;

      if (
        !activeThreadIds.has(threadState.threadId) &&
        (threadState.status === "DISCOVERED" || threadState.status === "IDLE" || threadState.status === "STOPPED")
      ) {
        continue;
      }

      try {
        const added = await this.pollThreadMessages(config, state, threadState, route, dryRun);
        if (added > 0) summary.queued += added;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/\b404\b|Unknown Channel|"code"\s*:\s*10003/.test(message)) {
          threadState.status = "STOPPED";
          threadState.assignedWorkerHandle = undefined;
          {
            const threadDyn = threadState as unknown as Record<string, unknown>;
            threadDyn.workerHandle = undefined;
            threadDyn.lastDispatchedMessages = undefined;
          }
          if (threadState.pendingGate?.status === "pending") {
            const gate = state.gates[threadState.pendingGate.id] ?? threadState.pendingGate;
            gate.status = "denied";
            gate.resolvedAt = new Date(this.now()).toISOString();
            gate.resolvedBy = "system (thread_deleted)";
            state.gates[gate.id] = gate;
            threadState.pendingGate = undefined;
          }
          threadState.workerObservedBusy = undefined;
          threadState.statusMessageId = undefined;
          threadState.lastStatusContent = undefined;
          threadState.lastWorkerPhase = undefined;
          threadState.statusReason = "Discord thread deleted or inaccessible (404)";
          threadState.updatedAt = new Date(this.now()).toISOString();
          await this.persist(state, dryRun);
          await this.record("thread_deleted", threadState, { phase: "poll", autoStopped: true, message }, dryRun);
          continue;
        }
        summary.errors.push(`poll ${threadState.threadId}: ${message}`);
        await this.record("error", threadState, { phase: "poll", message }, dryRun);
      }
    }

    // 3) Advance DISPATCHED or VERIFYING threads -> PASS/RETRY/ESCALATE
    for (const threadState of Object.values(state.threads)) {
      if (threadState.status !== "DISPATCHED" && threadState.status !== "VERIFYING") continue;
      const route = routeById.get(threadState.routeId);
      if (!route) continue;

      try {
        let outcome: "running" | "verified" | "escalated";
        if (threadState.status === "VERIFYING") {
          if (dryRun) {
            this.log(`[dry-run] would recover verification for thread "${threadState.name}" (${threadState.threadId})`);
            outcome = "running";
          } else {
            outcome = await this.runVerification(config, state, threadState, route, dryRun);
          }
        } else {
          outcome = await this.checkDispatchedThread(config, state, threadState, route, dryRun);
        }
        if (outcome === "verified") summary.verified++;
        if (outcome === "escalated") {
          summary.verified++;
          summary.escalated++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        summary.errors.push(`verify ${threadState.threadId}: ${message}`);
        await this.record("error", threadState, { phase: "verify", message }, dryRun);
      }
    }

    // 4) Dispatch QUEUED threads (respecting debounce, risky gate, and Orca BUSY guard)
    const busyHandlesInState = new Set(
      Object.values(state.threads)
        .filter(t => t.status === "DISPATCHED" && (t.assignedWorkerHandle || (t as unknown as Record<string, unknown>).workerHandle))
        .map(t => (t.assignedWorkerHandle ?? ((t as unknown as Record<string, unknown>).workerHandle as string))!),
    );

    for (const threadState of Object.values(state.threads)) {
      if (threadState.status !== "QUEUED") continue;
      const route = routeById.get(threadState.routeId);
      if (!route || !route.enabled) continue;

      try {
        const res = await this.tryDispatchThread(config, state, threadState, route, busyHandlesInState, dryRun);
        if (res === "dispatched") {
          summary.dispatched++;
          const handle = threadState.assignedWorkerHandle ?? ((threadState as unknown as Record<string, unknown>).workerHandle as string | undefined);
          if (handle) busyHandlesInState.add(handle);
        } else if (res === "escalated") {
          summary.escalated++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        summary.errors.push(`dispatch ${threadState.threadId}: ${message}`);
        await this.record("error", threadState, { phase: "dispatch", message }, dryRun);
      }
    }

    state.lastPollAt = new Date(this.now()).toISOString();
    await this.persist(state, dryRun);
    return summary;
  }

  private async initializeThread(state: OrchState, thread: DiscordThread, route: ProjectRoute, dryRun: boolean): Promise<void> {
    const iso = new Date(this.now()).toISOString();
    let cursor = thread.last_message_id ?? undefined;
    if (!cursor) {
      const latest = await this.deps.discord.listThreadMessages(thread.id, { limit: 1 }).catch(() => []);
      cursor = latest.at(-1)?.id;
    }

    const entry: ThreadLoopState = {
      threadId: thread.id,
      parentId: String(thread.parent_id ?? ""),
      name: thread.name,
      routeId: route.id,
      status: "DISCOVERED",
      lastSeenMessageId: cursor,
      iteration: 0,
      consecutiveSameFailures: 0,
      pendingMessages: [],
      createdAt: iso,
      updatedAt: iso,
    };
    state.threads[thread.id] = entry;
    this.log(`Discovered thread "${thread.name}" (${thread.id}) -> route "${route.id}"`);
    await this.persist(state, dryRun);
    await this.record("thread_discovered", entry, { parentId: entry.parentId, cursor }, dryRun);
  }

  private async pollThreadMessages(
    config: OrchConfig,
    state: OrchState,
    thread: ThreadLoopState,
    route: ProjectRoute,
    dryRun: boolean,
  ): Promise<number> {
    const msgs = await this.deps.discord.listThreadMessages(thread.threadId, {
      after: thread.lastSeenMessageId,
      limit: 50,
    });
    if (msgs.length === 0) return 0;

    let queuedCount = 0;
    for (const msg of msgs) {
      if (thread.lastSeenMessageId && compareSnowflakes(msg.id, thread.lastSeenMessageId) <= 0) {
        continue;
      }
      thread.lastSeenMessageId = msg.id;
      thread.updatedAt = new Date(this.now()).toISOString();

      const verdict = classifyMessage(msg, config, route, state.botUserId);
      if (verdict.kind === "ignore") {
        await this.persist(state, dryRun);
        continue;
      }

      if (verdict.kind === "command") {
        await this.executeThreadCommand(config, state, thread, route, verdict.command, msg.author.username, msg.id, dryRun);
        await this.persist(state, dryRun);
        continue;
      }

      // when thread.status === "PAUSED" || thread.status === "STOPPED", still advance lastSeenMessageId
      // and still process !orch commands, but do NOT append regular/qa messages to thread.pendingMessages
      if (thread.status === "PAUSED" || thread.status === "STOPPED") {
        await this.persist(state, dryRun);
        continue;
      }

      // When a risky-operation approval gate is pending, require explicit !orch approve/deny/stop
      // instead of clobbering the pending gate with a duplicate alert on plain messages.
      if (thread.status === "PAUSED_NEEDS_HUMAN" && thread.pendingGate?.status === "pending") {
        await this.reactOnce(thread.threadId, msg.id, "🛑", dryRun);
        await this.persist(state, dryRun);
        continue;
      }

      const queuedMsg: QueuedMessage = {
        id: msg.id,
        authorId: msg.author.id,
        authorName: msg.author.global_name || msg.author.username,
        isBot: !!msg.author.bot,
        kind: verdict.kind,
        content: msg.content.trim(),
        timestamp: msg.timestamp,
      };
      thread.pendingMessages.push(queuedMsg);
      thread.lastPendingAtMs = this.now();
      queuedCount++;

      // New user request resets failure/iteration counters when starting from IDLE/DISCOVERED
      if (verdict.kind === "human_trigger" && (thread.status === "DISCOVERED" || thread.status === "IDLE")) {
        thread.iteration = 0;
        thread.consecutiveSameFailures = 0;
        const threadDyn = thread as unknown as Record<string, unknown>;
        threadDyn.consecutiveFailureCount = 0;
        thread.lastFailureHash = undefined;
        threadDyn.consecutiveFailureHash = undefined;
        thread.lastFailureSummary = undefined;
        thread.status = "QUEUED";
        thread.statusReason = "Queued from user message";
      } else if (verdict.kind === "qa_fail_trigger" && (thread.status === "DISCOVERED" || thread.status === "IDLE")) {
        thread.iteration = 0;
        thread.consecutiveSameFailures = 0;
        const threadDyn = thread as unknown as Record<string, unknown>;
        threadDyn.consecutiveFailureCount = 0;
        thread.lastFailureHash = undefined;
        threadDyn.consecutiveFailureHash = undefined;
        thread.lastFailureSummary = undefined;
        thread.status = "QUEUED";
        thread.statusReason = `Queued from QA failure marker (${verdict.marker})`;
      } else if (thread.status === "PAUSED_NEEDS_HUMAN" && verdict.kind === "human_trigger") {
        // Explicit new human instructions unblock a human-paused thread
        thread.consecutiveSameFailures = 0;
        const threadDyn = thread as unknown as Record<string, unknown>;
        threadDyn.consecutiveFailureCount = 0;
        thread.lastFailureHash = undefined;
        threadDyn.consecutiveFailureHash = undefined;
        thread.iteration = 0;
        thread.status = "QUEUED";
        thread.statusReason = "Resumed by new human instructions";
      }

      // Immediately acknowledge receipt with 👀 reaction on the triggering Discord message.
      // While a prior turn is still DISPATCHED/VERIFYING, react without hijacking reactionMessageId.
      if (thread.status === "DISPATCHED" || thread.status === "VERIFYING") {
        await this.reactOnce(thread.threadId, msg.id, "👀", dryRun);
      } else {
        await this.setThreadReaction(thread, "👀", dryRun, msg.id);
      }

      await this.persist(state, dryRun);
      await this.record("message_queued", thread, {
        messageId: msg.id,
        kind: verdict.kind,
        author: queuedMsg.authorName,
        status: thread.status,
      }, dryRun);
    }

    return queuedCount;
  }

  private async executeThreadCommand(
    config: OrchConfig,
    state: OrchState,
    thread: ThreadLoopState,
    route: ProjectRoute,
    command: OrchThreadCommand,
    actor: string,
    commandMessageId: string,
    dryRun: boolean,
  ): Promise<void> {
    let reply = "";
    let commandReaction = "✅";
    switch (command.verb) {
      case "status":
        reply = [
          `**[orch status]** \`${route.name}\` (\`${route.id}\`)`,
          `- 상태: \`${thread.status}\`${thread.lastWorkerPhase ? ` (\`${thread.lastWorkerPhase}\`)` : ""} | 사이클: \`${thread.iteration}/${route.maxIterations}\` | 동일실패: \`${thread.consecutiveSameFailures}/${route.sameFailureLimit}\``,
          `- 워커: ${thread.assignedWorkerHandle ? `\`${thread.assignedWorkerHandle}\`` : "없음"} | 대기 메시지: ${thread.pendingMessages.length}건`,
          ...(thread.pendingGate ? [`- 승인 대기 게이트: \`${thread.pendingGate.id}\` (${thread.pendingGate.reason})`] : []),
          ...(thread.statusReason ? [`- 사유: ${thread.statusReason}`] : []),
        ].join("\n");
        break;
      case "pause":
        thread.status = "PAUSED";
        thread.statusReason = `Paused by ${actor}`;
        commandReaction = "⏸️";
        await this.finalizeThinkingStatus(thread, `⏸️ **[일시중지됨]** \`${route.name}\` — ${actor} 요청`, dryRun);
        reply = `⏸️ **일시중지됨** (\`${route.name}\`). 재개하려면 \`!orch resume\`을 입력하세요.`;
        break;
      case "resume":
        if (thread.pendingGate?.status === "pending") {
          commandReaction = "⚠️";
          reply = `⚠️ 승인 대기 중인 위험 작업 게이트(\`${thread.pendingGate.id}\`)가 있습니다. \`!orch approve ${thread.pendingGate.id}\` 또는 \`!orch deny ${thread.pendingGate.id}\`로 먼저 결정해 주세요.`;
        } else {
          thread.status = thread.pendingMessages.length > 0 || thread.lastFailureSummary ? "QUEUED" : "IDLE";
          thread.statusReason = `Resumed by ${actor}`;
          reply = `▶️ **재개됨** (\`${route.name}\`, 상태: \`${thread.status}\`).`;
        }
        break;
      case "stop":
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
          gate.resolvedAt = new Date(this.now()).toISOString();
          gate.resolvedBy = `${actor} (stop)`;
          state.gates[gate.id] = gate;
          thread.pendingGate = undefined;
        }
        thread.workerObservedBusy = undefined;
        thread.lastWorkerPhase = undefined;
        thread.statusReason = `Stopped by ${actor}`;
        commandReaction = "🛑";
        await this.setThreadReaction(thread, "🛑", dryRun);
        await this.finalizeThinkingStatus(thread, `⏹️ **[루프 중지됨]** \`${route.name}\` — ${actor} 요청`, dryRun);
        reply = `⏹️ **루프 중지됨** (\`${route.name}\`). 대기 큐를 비웠습니다.`;
        break;
      case "retry":
        if (thread.pendingGate?.status === "pending") {
          commandReaction = "⚠️";
          reply = `⚠️ 승인 대기 중인 위험 작업 게이트(\`${thread.pendingGate.id}\`)가 있습니다. \`!orch approve ${thread.pendingGate.id}\` 또는 \`!orch deny ${thread.pendingGate.id}\`로 먼저 결정해 주세요.`;
          break;
        }
        thread.consecutiveSameFailures = 0;
        {
          const threadDyn = thread as unknown as Record<string, unknown>;
          threadDyn.consecutiveFailureCount = 0;
          thread.lastFailureHash = undefined;
          threadDyn.consecutiveFailureHash = undefined;
          threadDyn.workerHandle = undefined;
          threadDyn.lastDispatchedMessages = undefined;
        }
        thread.assignedWorkerHandle = undefined;
        thread.workerObservedBusy = undefined;
        thread.lastWorkerPhase = undefined;
        thread.statusMessageId = undefined;
        thread.lastStatusContent = undefined;
        thread.iteration = 0;
        thread.status = "QUEUED";
        thread.lastPendingAtMs = 0;
        thread.statusReason = `Manual retry by ${actor}`;
        commandReaction = "🔁";
        await this.setThreadReaction(thread, "👀", dryRun);
        reply = `🔁 **재시도 큐 등록됨** (\`${route.name}\`). 유휴 Orca 워커에 배정됩니다.`;
        break;
      case "approve": {
        const gate = state.gates[command.gateId] ?? (thread.pendingGate?.id === command.gateId ? thread.pendingGate : undefined);
        if (!gate || gate.status !== "pending" || gate.threadId !== thread.threadId) {
          commandReaction = "❌";
          reply = `⚠️ 이 쓰레드에서 대기 중인 게이트 \`${command.gateId}\`를 찾을 수 없습니다.`;
        } else {
          gate.status = "approved";
          gate.resolvedAt = new Date(this.now()).toISOString();
          gate.resolvedBy = actor;
          state.gates[gate.id] = gate;
          if (thread.pendingGate?.id === gate.id) thread.pendingGate = gate;
          thread.status = "QUEUED";
          thread.lastPendingAtMs = 0;
          thread.statusReason = `Approved gate ${gate.id} by ${actor}`;
          await this.setThreadReaction(thread, "👀", dryRun);
          await this.record("risk_gate_resolved", thread, { gateId: gate.id, decision: "approved", actor }, dryRun);
          reply = `✅ 위험 작업 게이트 \`${gate.id}\` 승인됨. 작업을 재개합니다.`;
        }
        break;
      }
      case "deny": {
        const gate = state.gates[command.gateId] ?? (thread.pendingGate?.id === command.gateId ? thread.pendingGate : undefined);
        if (!gate || gate.status !== "pending" || gate.threadId !== thread.threadId) {
          commandReaction = "❌";
          reply = `⚠️ 이 쓰레드에서 대기 중인 게이트 \`${command.gateId}\`를 찾을 수 없습니다.`;
        } else {
          gate.status = "denied";
          gate.resolvedAt = new Date(this.now()).toISOString();
          gate.resolvedBy = actor;
          state.gates[gate.id] = gate;
          if (thread.pendingGate?.id === gate.id) thread.pendingGate = undefined;
          thread.pendingMessages = [];
          (thread as unknown as Record<string, unknown>).lastDispatchedMessages = undefined;
          thread.status = "IDLE";
          thread.statusReason = `Denied gate ${gate.id} by ${actor}`;
          commandReaction = "🛑";
          await this.setThreadReaction(thread, "🛑", dryRun);
          await this.record("risk_gate_resolved", thread, { gateId: gate.id, decision: "denied", actor }, dryRun);
          reply = `🛑 위험 작업 게이트 \`${gate.id}\` 거절됨. 해당 요청을 취소하고 대기 상태로 돌아갑니다.`;
        }
        break;
      }
      default:
        commandReaction = "❓";
        reply = "사용법: `!orch status | pause | resume | stop | retry | approve <gate_id> | deny <gate_id>`";
        break;
    }

    thread.updatedAt = new Date(this.now()).toISOString();
    await this.reactOnce(thread.threadId, commandMessageId, commandReaction, dryRun);
    await this.persist(state, dryRun);
    await this.record("command_executed", thread, { verb: command.verb, actor }, dryRun);
    if (!dryRun && reply) {
      await this.deps.discord.postMessage(thread.threadId, reply);
      if (command.verb === "stop" || command.verb === "approve" || command.verb === "deny") {
        await this.notifyOwnerDm(config, `[orch/${route.name}] #${thread.name}: ${reply}`);
      }
    }
  }

  private async dispatchQueuedThread(
    config: OrchConfig,
    state: OrchState,
    thread: ThreadLoopState,
    route: ProjectRoute,
    busyHandlesInState: Set<string>,
    dryRun: boolean,
  ): Promise<boolean> {
    const res = await this.tryDispatchThread(config, state, thread, route, busyHandlesInState, dryRun);
    return res === "dispatched";
  }

  private async tryDispatchThread(
    config: OrchConfig,
    state: OrchState,
    thread: ThreadLoopState,
    route: ProjectRoute,
    busyHandlesInState: Set<string>,
    dryRun: boolean,
  ): Promise<"dispatched" | "waiting" | "escalated"> {
    // Wait for debounce window to coalesce burst user messages
    const sincePending = thread.lastPendingAtMs ? this.now() - thread.lastPendingAtMs : config.debounceMs;
    if (sincePending < config.debounceMs) {
      return "waiting";
    }

    // Check risky operation gate unless already explicitly approved for this batch
    const combinedText = thread.pendingMessages.map(m => m.content).join("\n");
    const risky = detectRiskyOperation(combinedText);
    const alreadyApproved = thread.pendingGate?.status === "approved";
    if (risky && !alreadyApproved) {
      const gate: ApprovalGate = {
        id: makeGateId(),
        threadId: thread.threadId,
        routeId: route.id,
        reason: risky.reason,
        excerpt: risky.excerpt,
        createdAt: new Date(this.now()).toISOString(),
        status: "pending",
      };
      state.gates[gate.id] = gate;
      thread.pendingGate = gate;
      thread.status = "PAUSED_NEEDS_HUMAN";
      thread.statusReason = `Risky operation blocked: ${gate.reason}`;
      thread.updatedAt = gate.createdAt;

      await this.setThreadReaction(thread, "🛑", dryRun);
      await this.finalizeThinkingStatus(thread, `🛑 **[승인 대기]** \`${route.name}\` — 위험 작업 감지 (\`${gate.id}\`)`, dryRun);
      await this.persist(state, dryRun);
      await this.record("risk_gate_created", thread, { gateId: gate.id, reason: gate.reason, excerpt: gate.excerpt }, dryRun);
      const alert = [
        `🛡️ **[승인 필요] 위험 작업이 감지되어 자동 실행을 중단했습니다**`,
        `- 프로젝트: \`${route.name}\` | 쓰레드: #${thread.name}`,
        `- 사유: ${gate.reason}`,
        `- 감지 구문: \`${gate.excerpt}\``,
        `- 진행하려면 \`!orch approve ${gate.id}\`, 취소하려면 \`!orch deny ${gate.id}\` 를 입력하세요.`,
      ].join("\n");
      if (!dryRun) {
        await this.deps.discord.postMessage(thread.threadId, alert);
        await this.notifyOwnerDm(config, alert);
      }
      return "escalated";
    }

    const nextIter = thread.iteration + 1;
    const prompt = buildWorkerPrompt(route, thread, nextIter);
    const worktree = route.orcaWorktreePath ?? route.repoPath;
    const workers = await this.deps.orca.listRepoWorkers(worktree);

    let chosenHandle: string | undefined;
    for (const worker of workers) {
      if (busyHandlesInState.has(worker.handle)) continue;
      const inspected = await this.deps.orca.inspectWorkerState(worker.handle);
      if (inspected.state === "IDLE") {
        chosenHandle = worker.handle;
        break;
      }
    }

    if (dryRun) {
      this.log(`[dry-run] Would dispatch #${thread.name} (iter ${nextIter}/${route.maxIterations}) to ${chosenHandle ?? (route.spawnIfBusy && workers.length < route.maxWorkers ? "new spawned worker" : "wait (all busy)")}`);
      return "waiting";
    }

    if (chosenHandle) {
      const sent = await this.deps.orca.dispatchToWorker(chosenHandle, prompt);
      if (!sent.ok) {
        await this.record("worker_deferred_busy", thread, { handle: chosenHandle, detail: sent.detail }, false);
        return "waiting";
      }
    } else if (route.spawnIfBusy && workers.length < route.maxWorkers) {
      const spawned = await this.deps.orca.spawnWorker(worktree, `${route.name}: ${thread.name}`, prompt);
      if (!spawned.ok || !spawned.handle) {
        thread.status = "QUEUED";
        thread.statusReason = `Spawn worker failed: ${spawned.detail || "no handle returned"}`;
        await this.persist(state, false);
        await this.record("worker_deferred_busy", thread, { detail: thread.statusReason, openWorkers: workers.length }, false);
        return "waiting";
      }
      chosenHandle = spawned.handle;
    } else {
      await this.upsertThinkingStatus(
        thread,
        `⏳ **[워커 대기 중]** \`${route.name}\` — 모든 Orca 워커(${workers.length}/${route.maxWorkers})가 작업 중입니다. 유휴 워커가 생기면 즉시 시작합니다.`,
        false,
        { silent: true },
      );
      await this.persist(state, false);
      await this.record("worker_deferred_busy", thread, { openWorkers: workers.length, maxWorkers: route.maxWorkers }, false);
      return "waiting";
    }

    // Commit dispatch transition
    thread.iteration = nextIter;
    thread.status = "DISPATCHED";
    thread.assignedWorkerHandle = chosenHandle;
    (thread as unknown as Record<string, unknown>).workerHandle = chosenHandle;
    thread.dispatchedAt = new Date(this.now()).toISOString();
    thread.workerObservedBusy = false;
    thread.lastWorkerPhase = "thinking";
    const batchTargetMessageId = thread.pendingMessages[thread.pendingMessages.length - 1]?.id;
    if (thread.pendingMessages.length > 0) {
      (thread as unknown as Record<string, unknown>).lastDispatchedMessages = [...thread.pendingMessages];
    }
    thread.pendingMessages = [];
    thread.pendingGate = undefined;
    thread.statusReason = `Dispatched cycle ${nextIter}/${route.maxIterations} to ${chosenHandle}`;
    thread.updatedAt = thread.dispatchedAt;

    // Immediately persist after dispatch succeeds, BEFORE posting Discord status
    await this.persist(state, false);

    await this.record("worker_dispatched", thread, { handle: chosenHandle, iteration: nextIter }, false);
    if (batchTargetMessageId && batchTargetMessageId !== thread.reactionMessageId && this.deps.discord.removeReaction) {
      try {
        await this.deps.discord.removeReaction(thread.threadId, batchTargetMessageId, "👀");
      } catch {
        // best-effort cleanup of mid-turn 👀 acknowledgement
      }
    }
    await this.setThreadReaction(thread, "🧠", false, batchTargetMessageId);
    await this.emitTyping(thread.threadId, false);
    const dispatchMsg = `🧠 **[사이클 ${nextIter}/${route.maxIterations} 시작 · Thinking...]** \`${route.name}\` — Orca 워커(\`${chosenHandle}\`)에 배정했습니다. 완료 후 자동 검증 게이트를 실행합니다.`;
    await this.upsertThinkingStatus(thread, dispatchMsg, false, { silent: false });
    await this.persist(state, false);
    return "dispatched";
  }

  private async checkDispatchedThread(
    config: OrchConfig,
    state: OrchState,
    thread: ThreadLoopState,
    route: ProjectRoute,
    dryRun: boolean,
  ): Promise<"running" | "verified" | "escalated"> {
    const handle = thread.assignedWorkerHandle ?? ((thread as unknown as Record<string, unknown>).workerHandle as string | undefined);
    if (!handle) {
      thread.status = "QUEUED";
      await this.persist(state, dryRun);
      return "running";
    }

    const inspected = await this.deps.orca.inspectWorkerState(handle);
    if (inspected.state === "BUSY") {
      thread.workerObservedBusy = true;
      const phase: WorkerActivityPhase = inspected.phase ?? "thinking";
      thread.lastWorkerPhase = phase;
      await this.emitTyping(thread.threadId, dryRun);
      const statusText = formatThinkingStatus({
        route,
        iteration: thread.iteration,
        workerHandle: handle,
        phase,
        elapsedLabel: formatElapsedCompact(thread.dispatchedAt, this.now()),
        activity: inspected.activity,
      });
      await this.upsertThinkingStatus(thread, statusText, dryRun, { silent: true });
      await this.persist(state, dryRun);
      return "running";
    }
    const elapsedMs = thread.dispatchedAt ? this.now() - Date.parse(thread.dispatchedAt) : DISPATCH_MIN_GRACE_MS;

    if (inspected.state === "UNKNOWN") {
      if (elapsedMs > DISPATCH_MIN_GRACE_MS) {
        const repoPath = route.orcaWorktreePath ?? route.repoPath;
        const activeRepoWorkers = await this.deps.orca.listRepoWorkers(repoPath);
        const isStillPresent = activeRepoWorkers.some(w => w.handle === handle);
        if (!isStillPresent) {
          const disappearedHandle = handle;
          thread.assignedWorkerHandle = undefined;
          (thread as unknown as Record<string, unknown>).workerHandle = undefined;
          thread.dispatchedAt = undefined;
          thread.workerObservedBusy = undefined;
          thread.lastWorkerPhase = undefined;

          if (thread.iteration < route.maxIterations) {
            const threadDyn = thread as unknown as Record<string, unknown>;
            const prevMsgs = threadDyn.lastDispatchedMessages as QueuedMessage[] | undefined;
            if (Array.isArray(prevMsgs) && prevMsgs.length > 0 && thread.pendingMessages.length === 0) {
              thread.pendingMessages = [...prevMsgs];
            }
            thread.status = "QUEUED";
            thread.lastPendingAtMs = 0;
            thread.statusReason = `Worker ${disappearedHandle} disappeared/terminated unexpectedly; re-queued cycle ${thread.iteration}/${route.maxIterations}`;
            thread.updatedAt = new Date(this.now()).toISOString();
            await this.setThreadReaction(thread, "🔄", dryRun);
            await this.finalizeThinkingStatus(
              thread,
              `⚠️ **[사이클 ${thread.iteration}/${route.maxIterations} 워커 종료]** \`${route.name}\` — 워커 \`${disappearedHandle}\` 비정상 종료로 재배정 예약`,
              dryRun,
            );
            await this.persist(state, dryRun);
            await this.record("worker_disappeared", thread, { handle: disappearedHandle, action: "requeued" }, dryRun);
            if (!dryRun) {
              await this.deps.discord.postMessage(
                thread.threadId,
                `⚠️ **[워커 비정상 종료 감지]** \`${route.name}\` 배정 워커(\`${disappearedHandle}\`)가 예기치 않게 종료되었습니다. 사이클 ${thread.iteration}/${route.maxIterations}을 재배정 큐에 등록합니다.`,
              );
            }
            return "running";
          } else {
            thread.status = "PAUSED_NEEDS_HUMAN";
            const reason = `배정 워커(\`${disappearedHandle}\`)가 예기치 않게 종료되었으며 최대 자율 횟수(${route.maxIterations}회)에 도달했습니다.`;
            thread.statusReason = reason;
            thread.updatedAt = new Date(this.now()).toISOString();
            await this.setThreadReaction(thread, "❌", dryRun);
            await this.finalizeThinkingStatus(
              thread,
              `❌ **[사이클 ${thread.iteration}/${route.maxIterations} 중단]** \`${route.name}\` — 워커 \`${disappearedHandle}\` 종료 (사람 확인 필요)`,
              dryRun,
            );
            await this.persist(state, dryRun);
            await this.record("escalated_human", thread, { reason, handle: disappearedHandle }, dryRun);
            const alert = [
              `🚨 **[워커 비정상 종료 — 사람 확인 필요]** \`${route.name}\` (#${thread.name})`,
              `- 사유: ${reason}`,
              `- 조치: 워커 상태를 확인하고 \`!orch retry\` 로 재시작하세요.`,
            ].join("\n");
            if (!dryRun) {
              await this.deps.discord.postMessage(thread.threadId, alert);
              await this.notifyOwnerDm(config, alert);
            }
            return "escalated";
          }
        }
      }
      return "running";
    }
    // Prevent false completion right after dispatch before the agent screen refreshes to BUSY
    if (!thread.workerObservedBusy && elapsedMs < DISPATCH_MIN_GRACE_MS) {
      await this.emitTyping(thread.threadId, dryRun);
      return "running";
    }

    if (dryRun) return "running";

    // Worker returned to IDLE -> run project verification gates
    return await this.runVerification(config, state, thread, route, dryRun);
  }

  private async runVerification(
    config: OrchConfig,
    state: OrchState,
    thread: ThreadLoopState,
    route: ProjectRoute,
    dryRun: boolean,
  ): Promise<"verified" | "escalated"> {
    thread.status = "VERIFYING";
    thread.lastWorkerPhase = undefined;
    thread.updatedAt = new Date(this.now()).toISOString();
    await this.setThreadReaction(thread, "🔍", dryRun);
    await this.emitTyping(thread.threadId, dryRun);
    await this.upsertThinkingStatus(
      thread,
      `🔍 **[사이클 ${thread.iteration}/${route.maxIterations} · 검증 게이트 실행 중...]** \`${route.name}\` — 게이트 ${route.verificationGates.length}개 확인 중...`,
      dryRun,
      { silent: true },
    );
    await this.persist(state, dryRun);

    const verification = await this.deps.verifier.verifyRoute(route);
    const workerHandle = thread.assignedWorkerHandle ?? ((thread as unknown as Record<string, unknown>).workerHandle as string | undefined);
    const elapsedExact = formatElapsedExact(thread.dispatchedAt, this.now());
    thread.assignedWorkerHandle = undefined;
    (thread as unknown as Record<string, unknown>).workerHandle = undefined;
    thread.workerObservedBusy = undefined;

    if (verification.passed) {
      thread.consecutiveSameFailures = 0;
      {
        const threadDyn = thread as unknown as Record<string, unknown>;
        threadDyn.consecutiveFailureCount = 0;
        thread.lastFailureHash = undefined;
        threadDyn.consecutiveFailureHash = undefined;
        threadDyn.lastDispatchedMessages = undefined;
      }
      thread.lastFailureSummary = undefined;

      const completedIter = thread.iteration;
      const hasFollowUp = thread.pendingMessages.length > 0;
      const hasHumanFollowUp = thread.pendingMessages.some(m => m.kind === "human_trigger");
      if (hasHumanFollowUp || (hasFollowUp && thread.iteration >= route.maxIterations)) {
        thread.iteration = 0;
        thread.consecutiveSameFailures = 0;
        const threadDyn = thread as unknown as Record<string, unknown>;
        threadDyn.consecutiveFailureCount = 0;
        thread.lastFailureHash = undefined;
        threadDyn.consecutiveFailureHash = undefined;
        thread.lastFailureSummary = undefined;
      }

      thread.status = hasFollowUp ? "QUEUED" : "IDLE";
      thread.statusReason = hasFollowUp
        ? "Passed verification; processing live user feedback received mid-turn"
        : `Cycle ${completedIter} passed all verification gates`;
      thread.updatedAt = new Date(this.now()).toISOString();
      await this.setThreadReaction(thread, "✅", dryRun);
      await this.finalizeThinkingStatus(
        thread,
        `✅ **[사이클 ${completedIter}/${route.maxIterations} Thinking 완료]** \`${route.name}\` — 검증 통과 (소요 ${elapsedExact})`,
        dryRun,
      );
      await this.persist(state, dryRun);

      await this.record("verification_passed", thread, { workerHandle, iteration: completedIter, gates: verification.results.length }, dryRun);
      const report = [
        `✅ **[사이클 ${completedIter}/${route.maxIterations} 검증 통과]** \`${route.name}\``,
        verification.summaryText,
        ...(hasFollowUp ? ["", "💬 작업 도중 새 메시지가 도착해 후속 사이클을 이어서 진행합니다."] : []),
      ].join("\n");
      if (!dryRun) {
        await this.deps.discord.postMessage(thread.threadId, report);
        await this.notifyOwnerDm(config, `✅ [orch 완료] ${route.name} (#${thread.name}) — 사이클 ${completedIter}/${route.maxIterations} 검증 전 항목 PASS.`);
      }
      return "verified";
    }

    // Verification failed -> evaluate circuit breaker & max iterations
    const completedIter = thread.iteration;
    const hash = verification.failureHash ?? "unknown";
    if (thread.lastFailureHash === hash) {
      thread.consecutiveSameFailures += 1;
    } else {
      thread.lastFailureHash = hash;
      thread.consecutiveSameFailures = 1;
    }
    {
      const threadDyn = thread as unknown as Record<string, unknown>;
      threadDyn.consecutiveFailureHash = thread.lastFailureHash;
      threadDyn.consecutiveFailureCount = thread.consecutiveSameFailures;
    }
    thread.lastFailureSummary = verification.summaryText;
    thread.updatedAt = new Date(this.now()).toISOString();

    await this.record("verification_failed", thread, {
      workerHandle,
      failureHash: hash,
      consecutiveSameFailures: thread.consecutiveSameFailures,
      iteration: completedIter,
    }, dryRun);

    const hitSameFailureCap = thread.consecutiveSameFailures >= route.sameFailureLimit;
    const hitMaxIter = completedIter >= route.maxIterations;
    const hasLiveFeedback = thread.pendingMessages.length > 0;
    const hasHumanFeedback = thread.pendingMessages.some(m => m.kind === "human_trigger");

    if (hitSameFailureCap || hitMaxIter) {
      if (hasHumanFeedback) {
        // Fresh human guidance queues a new cycle instead of escalating over the human's new instructions
        thread.iteration = 0;
        thread.consecutiveSameFailures = 0;
        const threadDyn = thread as unknown as Record<string, unknown>;
        threadDyn.consecutiveFailureCount = 0;
        thread.lastFailureHash = undefined;
        threadDyn.consecutiveFailureHash = undefined;
        thread.lastFailureSummary = undefined;
        thread.status = "QUEUED";
        // Do NOT zero thread.lastPendingAtMs (preserve debounce)
        thread.statusReason = `Verification failed (${hash}), but fresh human instructions arrived; starting fresh cycle`;
        thread.updatedAt = new Date(this.now()).toISOString();
        await this.setThreadReaction(thread, "🔄", dryRun);
        await this.finalizeThinkingStatus(
          thread,
          `🔁 **[사이클 ${completedIter}/${route.maxIterations} Thinking 완료]** \`${route.name}\` — 새 지침 반영 재시도 (소요 ${elapsedExact})`,
          dryRun,
        );
        await this.persist(state, dryRun);

        await this.record("recursive_requeued", thread, {
          nextIteration: 1,
          failureHash: hash,
          reason: "requeued_by_human_guidance",
        }, dryRun);
        if (!dryRun) {
          await this.deps.discord.postMessage(
            thread.threadId,
            [
              `🔁 **[사이클 ${completedIter}/${route.maxIterations} 검증 미달 및 한도 도달했으나 새 지침 도착]**`,
              verification.summaryText,
              `새로운 사용자 요청을 반영하여 새 사이클을 시작합니다.`,
            ].join("\n"),
          );
        }
        return "verified";
      }

      const reason = hitSameFailureCap
        ? `동일 검증 실패(${hash})가 ${thread.consecutiveSameFailures}회 연속 발생해 자동 중단했습니다.`
        : `최대 자율 재귀 횟수(${route.maxIterations}회)에 도달해 중단했습니다.`;
      thread.status = "PAUSED_NEEDS_HUMAN";
      thread.statusReason = reason;
      thread.updatedAt = new Date(this.now()).toISOString();
      await this.setThreadReaction(thread, "❌", dryRun);
      await this.finalizeThinkingStatus(
        thread,
        `❌ **[사이클 ${completedIter}/${route.maxIterations} 에스컬레이션]** \`${route.name}\` — 사람 확인 필요 (소요 ${elapsedExact})`,
        dryRun,
      );
      await this.persist(state, dryRun);

      await this.record("escalated_human", thread, { reason, failureHash: hash }, dryRun);
      const alert = [
        `🚨 **[자동 재귀 중단 — 사람 확인 필요]** \`${route.name}\` (#${thread.name})`,
        `- 사유: ${reason}`,
        `- 최근 검증 결과:\n${verification.summaryText}`,
        `- 조치: 쓰레드에 수정 방향을 남기거나 \`!orch retry\` 로 재시작하세요.`,
      ].join("\n");
      if (!dryRun) {
        await this.deps.discord.postMessage(thread.threadId, alert);
        await this.notifyOwnerDm(config, alert);
      }
      return "escalated";
    }

    // Queue next recursive improvement cycle automatically
    thread.status = "QUEUED";
    if (!hasLiveFeedback) {
      thread.lastPendingAtMs = 0; // no extra debounce for autonomous fix cycle
    }
    // Note: if hasLiveFeedback, do NOT zero thread.lastPendingAtMs (preserve debounce)
    thread.statusReason = `Verification failed (${hash}); auto-requeued cycle ${completedIter + 1}/${route.maxIterations}`;
    thread.updatedAt = new Date(this.now()).toISOString();
    await this.setThreadReaction(thread, "🔄", dryRun);
    await this.finalizeThinkingStatus(
      thread,
      `🔁 **[사이클 ${completedIter}/${route.maxIterations} 검증 미달]** \`${route.name}\` — 자동 재수정 예약 (소요 ${elapsedExact})`,
      dryRun,
    );
    await this.persist(state, dryRun);

    await this.record("recursive_requeued", thread, {
      nextIteration: completedIter + 1,
      failureHash: hash,
    }, dryRun);
    if (!dryRun) {
      await this.deps.discord.postMessage(
        thread.threadId,
        [
          `🔁 **[사이클 ${completedIter}/${route.maxIterations} 검증 미달 → 자동 재수정 예약]**`,
          verification.summaryText,
          `다음 사이클(${completedIter + 1}/${route.maxIterations})을 유휴 워커에 자동 배정합니다.`,
        ].join("\n"),
      );
    }
    return "verified";
  }
  private async reactOnce(channelId: string, messageId: string, emoji: string, dryRun: boolean): Promise<void> {
    if (dryRun || !messageId || !this.deps.discord.addReaction) return;
    try {
      await this.deps.discord.addReaction(channelId, messageId, emoji);
    } catch (err) {
      this.log(`Reaction skipped (${emoji}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async setThreadReaction(
    thread: ThreadLoopState,
    emoji: string,
    dryRun: boolean,
    messageId?: string,
  ): Promise<void> {
    if (dryRun) return;
    const targetMessageId = messageId ?? thread.reactionMessageId;
    if (!targetMessageId) return;
    if (thread.reactionMessageId === targetMessageId && thread.activeReactionEmoji === emoji) {
      return;
    }
    const prevMessageId = thread.reactionMessageId;
    const prevEmoji = thread.activeReactionEmoji;
    const nonTerminal = prevEmoji === "👀" || prevEmoji === "🧠" || prevEmoji === "🔍" || prevEmoji === "🔄";
    if (
      prevMessageId &&
      prevEmoji &&
      (prevMessageId === targetMessageId || nonTerminal) &&
      this.deps.discord.removeReaction
    ) {
      try {
        await this.deps.discord.removeReaction(thread.threadId, prevMessageId, prevEmoji);
        thread.activeReactionEmoji = undefined;
      } catch {
        // best-effort cleanup of previous lifecycle emoji
      }
    }
    if (this.deps.discord.addReaction) {
      try {
        await this.deps.discord.addReaction(thread.threadId, targetMessageId, emoji);
        thread.reactionMessageId = targetMessageId;
        thread.activeReactionEmoji = emoji;
      } catch (err) {
        this.log(`Thread reaction skipped (${emoji}): ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      thread.reactionMessageId = targetMessageId;
      thread.activeReactionEmoji = emoji;
    }
  }

  private async emitTyping(threadId: string, dryRun: boolean): Promise<void> {
    if (dryRun || !this.deps.discord.triggerTyping) return;
    try {
      await this.deps.discord.triggerTyping(threadId);
    } catch {
      // best-effort typing indicator
    }
  }

  private async upsertThinkingStatus(
    thread: ThreadLoopState,
    content: string,
    dryRun: boolean,
    opts?: { silent?: boolean },
  ): Promise<void> {
    if (dryRun || !content.trim()) return;
    if (thread.statusMessageId && thread.lastStatusContent === content) {
      return;
    }
    if (thread.statusMessageId) {
      if (!this.deps.discord.editMessage) {
        return;
      }
      try {
        await this.deps.discord.editMessage(thread.threadId, thread.statusMessageId, content);
        thread.lastStatusContent = content;
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/\b404\b|Unknown Message|"code"\s*:\s*10008/.test(message)) {
          this.log(`Status message deleted; posting fresh status: ${message}`);
          thread.statusMessageId = undefined;
          thread.lastStatusContent = undefined;
        } else {
          this.log(`Status edit skipped (transient error): ${message}`);
          return;
        }
      }
    }
    try {
      const ids = await this.deps.discord.postMessage(
        thread.threadId,
        content,
        opts?.silent ? { flags: DISCORD_SILENT_FLAGS } : undefined,
      );
      if (ids[0]) {
        thread.statusMessageId = ids[0];
        thread.lastStatusContent = content;
      }
    } catch (err) {
      this.log(`Status post skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  private async finalizeThinkingStatus(thread: ThreadLoopState, content: string, dryRun: boolean): Promise<void> {
    if (dryRun) return;
    if (thread.statusMessageId && this.deps.discord.editMessage) {
      try {
        await this.deps.discord.editMessage(thread.threadId, thread.statusMessageId, content);
      } catch {
        // best-effort final edit
      }
    }
    thread.statusMessageId = undefined;
    thread.lastStatusContent = undefined;
    thread.lastWorkerPhase = undefined;
  }

  private async notifyOwnerDm(config: OrchConfig, content: string): Promise<void> {
    try {
      let dmChannelId = config.ownerDmChannelId;
      if (!dmChannelId && config.ownerUserIds[0]) {
        dmChannelId = await this.deps.discord.ensureDmChannel(config.ownerUserIds[0]);
      }
      if (!dmChannelId) return;
      await this.deps.discord.postMessage(dmChannelId, content);
    } catch (err) {
      this.log(`DM notify skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  private async record(
    event: Parameters<typeof appendLedger>[0]["event"],
    thread: ThreadLoopState,
    detail: Record<string, unknown>,
    dryRun: boolean,
  ): Promise<void> {
    if (dryRun) return;
    await appendLedger({
      ts: new Date(this.now()).toISOString(),
      event,
      threadId: thread.threadId,
      routeId: thread.routeId,
      iteration: thread.iteration,
      detail,
    }, this.orchHome);
  }
}
