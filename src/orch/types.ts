/**
 * Types for jeo's multi-project Discord Thread Orchestrator (`/orch` & `jeo orch`).
 * Persisted under `~/.jeo/thread-orchestrator/` (or `$JEO_ORCH_HOME`).
 */

export interface VerificationGate {
  /** Short human-readable gate identifier (e.g. "pytest", "go-test", "static-preflight"). */
  name: string;
  /** Shell command executed in `cwd ?? route.repoPath`. Exit code 0 = PASS. */
  command: string;
  /** Optional relative or absolute working directory override. */
  cwd?: string;
  /** Timeout in milliseconds (default: 180_000). */
  timeoutMs?: number;
}

export interface ProjectRoute {
  /** Stable slug identifier (e.g. "my-app"). */
  id: string;
  /** Human-readable project name (e.g. "My App"). */
  name: string;

  /** Whether this route actively subscribes to matching threads. */
  enabled: boolean;
  /** Parent Discord channel IDs whose child threads are auto-subscribed. */
  parentChannelIds: string[];
  /** Case-insensitive substrings matched against thread titles. Empty = match all in parentChannelIds. */
  titleKeywords: string[];
  /** Optional case-insensitive prefixes matched against thread titles. */
  titlePrefixes?: string[];
  /** Local git repository / project root path. */
  repoPath: string;
  /** Optional Orca workspace / worktree path override (defaults to repoPath). */
  orcaWorktreePath?: string;
  /** Max autonomous recursive fix cycles per request (default: 4). */
  maxIterations: number;
  /** Halt & escalate after N consecutive identical failure signatures (default: 2). */
  sameFailureLimit: number;
  /** Max concurrent Orca workers to spawn for this route (default: 3). */
  maxWorkers: number;
  /** Whether to spawn a new supervised worker when all existing repo workers are BUSY. */
  spawnIfBusy: boolean;
  /** Verification commands run automatically after each worker turn completes. */
  verificationGates: VerificationGate[];
  /** Structured markers in bot messages that are allowed to trigger a recursive fix cycle. */
  allowBotQaMarkers?: string[];
}

export interface OrchConfig {
  version: 1;
  /** Target Discord guild ID. */
  guildId: string;
  /** Discord user IDs allowed to trigger runs and issue `!orch` commands. */
  ownerUserIds: string[];
  /** Optional DM channel ID for concise important completion / escalation summaries. */
  ownerDmChannelId?: string;
  /** Path to 0600 Discord bot token file (defaults to `~/.jeo/discord/discord-token`). */
  tokenFile: string;
  /** Env var name containing Discord bot token (defaults to `JEO_DISCORD_BOT_TOKEN`). */
  tokenEnv: string;
  /** Optional `orca` CLI binary path override (falls back to `JEO_ORCA_BIN` and `PATH`). */
  orcaBin?: string;
  /** Polling interval in milliseconds (default: 10_000). */
  pollIntervalMs: number;
  /** Debounce window in milliseconds to coalesce consecutive user messages (default: 12_000). */
  debounceMs: number;
  /** Optional list of repo-local hidden config files (e.g. `<repo>/.jeo/orch.json`) merged at load time. */
  configFiles?: string[];
  /** Multi-project route table. */
  routes: ProjectRoute[];
}

/**
 * Declarative config file schema for repo-local hidden configs (e.g. `<repo>/.jeo/orch.json`)
 * or standalone config files loaded via `--config` / `JEO_ORCH_CONFIG` / `configFiles`.
 */
export interface OrchConfigFile {
  guildId?: string;
  ownerUserIds?: string[];
  ownerDmChannelId?: string;
  tokenFile?: string;
  tokenEnv?: string;
  orcaBin?: string;
  pollIntervalMs?: number;
  debounceMs?: number;
  /** Single project route definition (relative or omitted `repoPath` resolves to the repo root). */
  route?: Partial<ProjectRoute>;
  /** Multiple project route definitions (each relative or omitted `repoPath` resolves to the repo root). */
  routes?: Partial<ProjectRoute>[];
}


export type ThreadLoopStatus =
  | "DISCOVERED"
  | "QUEUED"
  | "DISPATCHED"
  | "VERIFYING"
  | "IDLE"
  | "PAUSED"
  | "PAUSED_NEEDS_HUMAN"
  | "STOPPED";

export interface QueuedMessage {
  id: string;
  authorId: string;
  authorName: string;
  isBot: boolean;
  kind: "human_trigger" | "qa_fail_trigger";
  content: string;
  timestamp: string;
}

export interface ApprovalGate {
  id: string;
  threadId: string;
  routeId: string;
  reason: string;
  excerpt: string;
  createdAt: string;
  status: "pending" | "approved" | "denied";
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface ThreadLoopState {
  threadId: string;
  parentId: string;
  name: string;
  routeId: string;
  status: ThreadLoopStatus;
  /** Last Discord message snowflake processed in this thread. */
  lastSeenMessageId?: string;
  /** Current autonomous cycle counter (1-based while running). */
  iteration: number;
  /** Consecutive identical verification failure count for circuit-breaking. */
  consecutiveSameFailures: number;
  /** SHA-256 prefix of the last verification failure signature. */
  lastFailureHash?: string;
  /** Summary of last verification failure passed into next recursive cycle. */
  lastFailureSummary?: string;
  /** Currently assigned Orca terminal handle when status === "DISPATCHED". */
  assignedWorkerHandle?: string;
  /** Timestamp when current worker dispatch started. */
  dispatchedAt?: string;
  /** True once the assigned worker has been observed BUSY after dispatch (prevents premature idle detection). */
  workerObservedBusy?: boolean;
  /** Debounced incoming trigger messages waiting for dispatch (or live feedback received mid-turn). */
  pendingMessages: QueuedMessage[];
  /** Timestamp (ms) of the most recent pending message for debounce calculation. */
  lastPendingAtMs?: number;
  /** Active risky-action approval gate blocking execution, if any. */
  pendingGate?: ApprovalGate;
  /** Human-readable reason for pause / escalation / last result. */
  statusReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrchState {
  version: 1;
  botUserId?: string;
  lastPollAt?: string;
  threads: Record<string, ThreadLoopState>;
  gates: Record<string, ApprovalGate>;
}

export interface LedgerEntry {
  ts: string;
  event:
    | "thread_discovered"
    | "message_queued"
    | "command_executed"
    | "risk_gate_created"
    | "risk_gate_resolved"
    | "worker_dispatched"
    | "worker_deferred_busy"
    | "worker_disappeared"
    | "verification_passed"
    | "verification_failed"
    | "recursive_requeued"
    | "escalated_human"
    | "report_sent"
    | "error";
  threadId?: string;
  routeId?: string;
  iteration?: number;
  detail: Record<string, unknown>;
}

export interface GateRunResult {
  name: string;
  command: string;
  passed: boolean;
  exitCode: number;
  durationMs: number;
  outputExcerpt: string;
}

export interface VerificationSummary {
  passed: boolean;
  results: GateRunResult[];
  failureHash?: string;
  summaryText: string;
}

export interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  parent_id?: string | null;
  guild_id?: string;
}

export interface DiscordThread {
  id: string;
  name: string;
  parent_id?: string | null;
  guild_id?: string;
  last_message_id?: string | null;
  thread_metadata?: {
    archived?: boolean;
    locked?: boolean;
  };
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    username: string;
    global_name?: string | null;
    bot?: boolean;
  };
}
