/**
 * Role-split dynamic subagent concurrency scaler with HTTP 429 adaptive backoff.
 *
 * Read-only roles (planner / architect / critic / custom read-only) start at
 * `min(DEFAULT_READONLY_BASE_CONCURRENCY, ceiling)` and scale dynamically up to
 * their configured ceiling (default 16) while healthy. Mutating executor roles
 * stay bounded by a conservative cap (default 6, max 8) to avoid concurrent
 * workspace/file collisions even when read-only fan-out scales to 16.
 *
 * When a provider returns HTTP 429 / rate-limit pressure, the affected role's
 * live concurrency budget immediately halves (floor 1) and enters a cooldown
 * window during which scale-up is paused. After cooldown expires and healthy
 * completions accrue, the budget steps back up gradually (+2 per recovery
 * threshold) toward the role ceiling.
 */

export const DEFAULT_READONLY_BASE_CONCURRENCY = 6;
export const MAX_READONLY_CONCURRENCY = 16;
export const DEFAULT_EXECUTOR_CONCURRENCY = 6;
export const MAX_EXECUTOR_CONCURRENCY = 8;
export const MIN_CONCURRENCY = 1;

export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 30_000;
export const DEFAULT_SCALE_UP_STEP = 2;
export const DEFAULT_RECOVERY_SUCCESSES = 2;

export interface SubagentScalerConfig {
  /** Configured concurrency cap (1..16). Acts as read-only dynamic ceiling when
   *  `subagentDynamicScaling !== false` (default 16 when unset), or as the fixed
   *  read-only limit (default 6 when unset) when dynamic scaling is disabled. */
  subagentConcurrency?: number;
  /** Enable dynamic read-only scale-up and 429 adaptive backoff. Default true. */
  subagentDynamicScaling?: boolean;
  /** Conservative ceiling for mutating (executor) subagents (1..8, default 6). */
  subagentExecutorConcurrency?: number;
}

export interface SubagentScalerOptions {
  /** Injectable wall clock for deterministic testing. Defaults to `Date.now`. */
  now?: () => number;
  /** Pause window after a 429 before recovery steps begin. Default 30_000ms. */
  cooldownMs?: number;
  /** Increment applied on each post-cooldown recovery step. Default 2. */
  scaleUpStep?: number;
  /** Consecutive post-cooldown successes required per step-up. Default 2. */
  recoverySuccesses?: number;
}

export interface SubagentScalerSnapshot {
  readOnlyLimit: number;
  readOnlyCeiling: number;
  executorLimit: number;
  executorCeiling: number;
  inCooldown: boolean;
  consecutiveRateLimits: number;
}

export interface ResolvedScalerCeilings {
  dynamicEnabled: boolean;
  readOnlyCeiling: number;
  executorCeiling: number;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Pure ceiling calculation with zero side effects — safe for protocol lines,
 *  worker bootstrap sizing, and static batch-cap validation. */
export function resolveScalerCeilings(config?: SubagentScalerConfig): ResolvedScalerCeilings {
  const dynamicEnabled = config?.subagentDynamicScaling !== false;
  const readOnlyCeiling = dynamicEnabled
    ? clampInt(config?.subagentConcurrency, MAX_READONLY_CONCURRENCY, MIN_CONCURRENCY, MAX_READONLY_CONCURRENCY)
    : clampInt(config?.subagentConcurrency, DEFAULT_READONLY_BASE_CONCURRENCY, MIN_CONCURRENCY, MAX_READONLY_CONCURRENCY);
  const defaultExecutor = Math.min(DEFAULT_EXECUTOR_CONCURRENCY, readOnlyCeiling);
  const executorCeiling = clampInt(
    config?.subagentExecutorConcurrency,
    defaultExecutor,
    MIN_CONCURRENCY,
    Math.min(MAX_EXECUTOR_CONCURRENCY, readOnlyCeiling),
  );
  return { dynamicEnabled, readOnlyCeiling, executorCeiling };
}

export class SubagentScaler {
  private readonly nowFn: () => number;
  private readonly cooldownMs: number;
  private readonly scaleUpStep: number;
  private readonly recoverySuccesses: number;

  private dynamicEnabled = true;
  private readOnlyCeiling = MAX_READONLY_CONCURRENCY;
  private executorCeiling = DEFAULT_EXECUTOR_CONCURRENCY;
  private readOnlyLimit = DEFAULT_READONLY_BASE_CONCURRENCY;
  private executorLimit = DEFAULT_EXECUTOR_CONCURRENCY;

  private readOnlyBackedOff = false;
  private executorBackedOff = false;
  private readOnlyRecoveryCount = 0;
  private executorRecoveryCount = 0;
  private cooldownUntil = Number.NEGATIVE_INFINITY;
  private consecutiveRateLimits = 0;

  constructor(config?: SubagentScalerConfig, options?: SubagentScalerOptions) {
    this.nowFn = options?.now ?? Date.now;
    this.cooldownMs = Math.max(0, options?.cooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS);
    this.scaleUpStep = Math.max(1, Math.trunc(options?.scaleUpStep ?? DEFAULT_SCALE_UP_STEP));
    this.recoverySuccesses = Math.max(1, Math.trunc(options?.recoverySuccesses ?? DEFAULT_RECOVERY_SUCCESSES));

    const { dynamicEnabled, readOnlyCeiling, executorCeiling } = resolveScalerCeilings(config);
    this.dynamicEnabled = dynamicEnabled;
    this.readOnlyCeiling = readOnlyCeiling;
    this.executorCeiling = executorCeiling;
    this.readOnlyLimit = dynamicEnabled
      ? Math.min(DEFAULT_READONLY_BASE_CONCURRENCY, readOnlyCeiling)
      : readOnlyCeiling;
    this.executorLimit = executorCeiling;
  }

  /** Synchronize ceilings with updated config while preserving active backoff/cooldown state. */
  configure(config?: SubagentScalerConfig): void {
    const { dynamicEnabled, readOnlyCeiling, executorCeiling } = resolveScalerCeilings(config);
    this.dynamicEnabled = dynamicEnabled;
    this.readOnlyCeiling = readOnlyCeiling;
    this.executorCeiling = executorCeiling;

    if (!dynamicEnabled) {
      this.readOnlyLimit = readOnlyCeiling;
      this.executorLimit = executorCeiling;
      return;
    }

    const readOnlyBase = Math.min(DEFAULT_READONLY_BASE_CONCURRENCY, readOnlyCeiling);
    if (this.readOnlyBackedOff) {
      this.readOnlyLimit = Math.min(this.readOnlyLimit, readOnlyCeiling);
    } else {
      this.readOnlyLimit = Math.min(readOnlyCeiling, Math.max(readOnlyBase, this.readOnlyLimit));
    }

    if (this.executorBackedOff) {
      this.executorLimit = Math.min(this.executorLimit, executorCeiling);
    } else {
      this.executorLimit = executorCeiling;
    }
  }

  /** Live concurrency limit for the requested role. When healthy and dynamic scaling
   *  is enabled, read-only demand expands the live budget up to `readOnlyCeiling`. */
  effectiveLimit(roleReadOnly: boolean, demand?: number, now = this.nowFn()): number {
    if (!this.dynamicEnabled) {
      return roleReadOnly ? this.readOnlyCeiling : this.executorCeiling;
    }

    if (!roleReadOnly) {
      return Math.min(this.executorLimit, this.executorCeiling);
    }

    const inCooldown = now < this.cooldownUntil;
    if (
      !inCooldown &&
      !this.readOnlyBackedOff &&
      typeof demand === "number" &&
      Number.isFinite(demand) &&
      demand > this.readOnlyLimit
    ) {
      this.readOnlyLimit = Math.min(
        this.readOnlyCeiling,
        Math.max(this.readOnlyLimit, Math.trunc(demand)),
      );
    }

    return Math.min(this.readOnlyLimit, this.readOnlyCeiling);
  }

  /** Halve the affected role's live concurrency budget (floor 1) and enter cooldown. */
  recordRateLimit(roleReadOnly: boolean, now = this.nowFn()): void {
    this.consecutiveRateLimits += 1;
    this.cooldownUntil = now + this.cooldownMs;

    if (!this.dynamicEnabled) return;

    if (roleReadOnly) {
      this.readOnlyLimit = Math.max(MIN_CONCURRENCY, Math.floor(this.readOnlyLimit / 2));
      this.readOnlyBackedOff = true;
      this.readOnlyRecoveryCount = 0;
    } else {
      this.executorLimit = Math.max(MIN_CONCURRENCY, Math.floor(this.executorLimit / 2));
      this.executorBackedOff = true;
      this.executorRecoveryCount = 0;
    }
  }

  /** Record a healthy completion. Once cooldown expires and `recoverySuccesses`
   *  consecutive successes accrue, steps the role's budget up by `scaleUpStep`. */
  recordSuccess(roleReadOnly: boolean, now = this.nowFn()): void {
    if (now < this.cooldownUntil) return;
    this.consecutiveRateLimits = 0;

    if (!this.dynamicEnabled) return;

    if (roleReadOnly) {
      if (this.readOnlyLimit >= this.readOnlyCeiling) {
        this.readOnlyBackedOff = false;
        this.readOnlyRecoveryCount = 0;
        return;
      }
      this.readOnlyRecoveryCount += 1;
      if (this.readOnlyRecoveryCount >= this.recoverySuccesses) {
        this.readOnlyRecoveryCount = 0;
        this.readOnlyLimit = Math.min(this.readOnlyCeiling, this.readOnlyLimit + this.scaleUpStep);
        if (this.readOnlyLimit >= this.readOnlyCeiling) {
          this.readOnlyBackedOff = false;
        }
      }
    } else {
      if (this.executorLimit >= this.executorCeiling) {
        this.executorBackedOff = false;
        this.executorRecoveryCount = 0;
        return;
      }
      this.executorRecoveryCount += 1;
      if (this.executorRecoveryCount >= this.recoverySuccesses) {
        this.executorRecoveryCount = 0;
        this.executorLimit = Math.min(this.executorCeiling, this.executorLimit + this.scaleUpStep);
        if (this.executorLimit >= this.executorCeiling) {
          this.executorBackedOff = false;
        }
      }
    }
  }

  /** Diagnostic snapshot for UI / logging / tests. */
  snapshot(now = this.nowFn()): SubagentScalerSnapshot {
    const inCooldown = now < this.cooldownUntil;
    return {
      readOnlyLimit: this.dynamicEnabled ? this.readOnlyLimit : this.readOnlyCeiling,
      readOnlyCeiling: this.readOnlyCeiling,
      executorLimit: this.dynamicEnabled ? this.executorLimit : this.executorCeiling,
      executorCeiling: this.executorCeiling,
      inCooldown,
      consecutiveRateLimits: this.consecutiveRateLimits,
    };
  }
}

let sharedSubagentScaler: SubagentScaler | undefined;

export function getSharedSubagentScaler(config?: SubagentScalerConfig): SubagentScaler {
  if (!sharedSubagentScaler) {
    sharedSubagentScaler = new SubagentScaler(config);
  } else if (config !== undefined) {
    sharedSubagentScaler.configure(config);
  }
  return sharedSubagentScaler;
}

export function resetSharedSubagentScaler(): void {
  sharedSubagentScaler = undefined;
}
