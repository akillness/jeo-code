/**
 * StepBudget — gjc-style flexible step budgeting ("retry flow") for the agent loop.
 *
 * Replaces the bare `step <= maxSteps` counter with a budget that EXTENDS itself
 * while the turn is demonstrably making progress (recent tool calls succeeding on
 * distinct targets) and fails fast into consolidation when it is stalled. Mirrors
 * gjc's provider retry budgets: a base budget, a bounded number of extensions, an
 * absolute hard cap, and explicit fail-fast classes (a stalled window — too many
 * failures or no distinct targets — never earns an extension).
 *
 * The existing engine guards (MAX_REPEAT identical calls, MAX_FAILURES consecutive
 * failures, parse-bounce salvage) remain the early fail-fast layer; this module
 * only governs what happens when the step counter reaches the current limit.
 */

export interface StepBudgetConfig {
  /** Initial step budget (the caller's `maxSteps`). */
  baseSteps: number;
  /** Steps granted per extension. */
  extensionSteps: number;
  /** How many times the budget may extend (0 = legacy fixed counter). */
  maxExtensions: number;
  /** Absolute ceiling no extension may cross. */
  hardCap: number;
  /** Recent tool-call window scored for progress. */
  windowSize: number;
  /** Required ok-ratio in the window to earn an extension. */
  minProgressRatio: number;
  /** Required distinct call signatures in the window (anti-spin). */
  minDistinct: number;
}

export interface ExtensionDecision {
  extend: boolean;
  /** Human-readable reason — surfaced as an onNotice/onBudget line. */
  reason: string;
  /** The (possibly new) current limit after the decision. */
  limit: number;
}

type EnvLike = Record<string, string | undefined>;

function envNum(env: EnvLike, key: string, dflt: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/**
 * Resolve the effective budget config: defaults ← env (`JOC_STEP_*`) ← caller overrides.
 * Defaults keep the flow ON for the main agent (2 extensions, half-budget each, 3× cap);
 * bounded delegation (task/team subagents) passes `{ maxExtensions: 0 }` so a parent's
 * step contract stays exact.
 */
export function resolveStepBudgetConfig(
  baseSteps: number,
  env: EnvLike = process.env,
  overrides?: Partial<StepBudgetConfig>,
): StepBudgetConfig {
  const base = Math.max(1, Math.trunc(baseSteps));
  const cfg: StepBudgetConfig = {
    baseSteps: base,
    extensionSteps: envNum(env, "JOC_STEP_EXTENSION_SIZE", Math.max(4, Math.ceil(base / 2)), 1, 100),
    maxExtensions: envNum(env, "JOC_STEP_EXTENSIONS", 2, 0, 8),
    hardCap: envNum(env, "JOC_STEP_HARD_CAP", base * 3, base, base * 10),
    windowSize: envNum(env, "JOC_STEP_WINDOW", 8, 2, 32),
    minProgressRatio: 0.5,
    minDistinct: 2,
  };
  const merged = { ...cfg, ...overrides };
  // Sanity: the cap can never undercut the base budget.
  merged.baseSteps = Math.max(1, Math.trunc(merged.baseSteps));
  merged.hardCap = Math.max(merged.baseSteps, Math.trunc(merged.hardCap));
  merged.maxExtensions = Math.max(0, Math.trunc(merged.maxExtensions));
  merged.extensionSteps = Math.max(1, Math.trunc(merged.extensionSteps));
  merged.windowSize = Math.max(2, Math.trunc(merged.windowSize));
  return merged;
}

export class StepBudget {
  private readonly cfg: StepBudgetConfig;
  private readonly window: { signature: string; success: boolean }[] = [];
  private extensions = 0;
  private currentLimit: number;

  constructor(cfg: StepBudgetConfig) {
    this.cfg = cfg;
    this.currentLimit = Math.min(cfg.baseSteps, cfg.hardCap);
  }

  /** The current step limit (base + granted extensions). */
  limit(): number {
    return this.currentLimit;
  }

  /** Extensions granted so far. */
  extensionsUsed(): number {
    return this.extensions;
  }

  /** Record an executed tool call (ring-buffered to the scoring window). */
  record(signature: string, success: boolean): void {
    this.window.push({ signature, success });
    if (this.window.length > this.cfg.windowSize) this.window.shift();
  }

  /** Progress over the recent window: ok count, total, distinct signatures. */
  progress(): { ok: number; total: number; distinct: number } {
    const ok = this.window.filter(r => r.success).length;
    const distinct = new Set(this.window.map(r => r.signature)).size;
    return { ok, total: this.window.length, distinct };
  }

  /**
   * Called when the step counter reaches the current limit. Grants a bounded
   * extension when the recent window shows real progress; otherwise declines
   * with an explicit fail-fast reason (the loop then consolidates).
   */
  tryExtend(): ExtensionDecision {
    const decline = (why: string): ExtensionDecision => ({
      extend: false,
      reason: why,
      limit: this.currentLimit,
    });
    if (this.cfg.maxExtensions <= 0) return decline("step extensions disabled");
    if (this.extensions >= this.cfg.maxExtensions) {
      return decline(`extension budget exhausted (${this.extensions}/${this.cfg.maxExtensions})`);
    }
    if (this.currentLimit >= this.cfg.hardCap) {
      return decline(`hard step cap ${this.cfg.hardCap} reached`);
    }
    const p = this.progress();
    if (p.total < 2) return decline(`not enough recent tool activity (${p.total} call(s))`);
    const ratio = p.ok / p.total;
    if (ratio < this.cfg.minProgressRatio || p.distinct < this.cfg.minDistinct) {
      return decline(
        `no recent progress (${p.ok}/${p.total} ok, ${p.distinct} distinct target(s))`,
      );
    }
    this.extensions++;
    this.currentLimit = Math.min(this.currentLimit + this.cfg.extensionSteps, this.cfg.hardCap);
    return {
      extend: true,
      reason:
        `progress detected (${p.ok}/${p.total} recent tools ok, ${p.distinct} targets) — ` +
        `step budget extended to ${this.currentLimit} (extension ${this.extensions}/${this.cfg.maxExtensions})`,
      limit: this.currentLimit,
    };
  }
}
