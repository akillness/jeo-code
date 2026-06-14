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
  // `key` is the legacy JEO_* name; the JEO_* spelling is preferred when both are set.
  const raw = env[key.replace(/^JEO_/, "JEO_")] ?? env[key];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/**
 * Resolve the effective budget config: defaults ← env (`JEO_STEP_*`) ← caller overrides.
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
    extensionSteps: envNum(env, "JEO_STEP_EXTENSION_SIZE", Math.max(4, Math.ceil(base / 2)), 1, 100),
    maxExtensions: envNum(env, "JEO_STEP_EXTENSIONS", 2, 0, 8),
    hardCap: envNum(env, "JEO_STEP_HARD_CAP", base * 3, base, base * 10),
    windowSize: envNum(env, "JEO_STEP_WINDOW", 8, 2, 32),
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

/** True when `key` carries a non-empty value in `env`. */
function envSet(env: EnvLike, key: string): boolean {
  const raw = env[key.replace(/^JEO_/, "JEO_")] ?? env[key];
  return raw !== undefined && raw !== "";
}

/**
 * Dynamic (process-driven) budget — the default when the caller passes no explicit
 * `--max-steps`: there is no SMALL hardcoded step ceiling. The budget starts at a
 * rolling base (`JEO_STEP_BASE`, default 24) and keeps extending itself for as long
 * as the recent tool window shows real progress; only a stalled window declines the
 * extension, at which point the loop dynamically CONSOLIDATES a final wrap-up
 * instead of dying at a fixed count.
 *
 * Termination is still GUARANTEED: extensions are unlimited in count, but the
 * absolute ceiling defaults to `DYNAMIC_HARD_CAP` (600 steps) instead of Infinity.
 * An unbounded ceiling turned every hole in the progress heuristic into a literal
 * infinite loop (e.g. a model cycling successful reads forever); a large finite cap
 * keeps long autonomous runs alive while converting a pathological spin into a
 * consolidation wrap-up. Setting `JEO_STEP_EXTENSIONS` / `JEO_STEP_HARD_CAP`
 * restores a fully bounded budget; caller overrides win over both.
 */
export const DYNAMIC_HARD_CAP = 600;

export function dynamicStepBudgetConfig(
  env: EnvLike = process.env,
  overrides?: Partial<StepBudgetConfig>,
): StepBudgetConfig {
  const base = envNum(env, "JEO_STEP_BASE", 24, 1, 10_000);
  const dynamic: Partial<StepBudgetConfig> = {};
  if (!envSet(env, "JEO_STEP_EXTENSIONS")) dynamic.maxExtensions = Number.POSITIVE_INFINITY;
  if (!envSet(env, "JEO_STEP_HARD_CAP")) dynamic.hardCap = Math.max(base, DYNAMIC_HARD_CAP);
  return resolveStepBudgetConfig(base, env, { ...dynamic, ...overrides });
}

/** The step limit a dynamic turn starts from — seeds the `step N/M` display before
 *  the engine's onBudget extensions grow the denominator. */
export function initialDynamicStepLimit(env: EnvLike = process.env): number {
  return dynamicStepBudgetConfig(env).baseSteps;
}

/**
 * Fixed-size hash of a tool-call signature (two interleaved FNV-1a streams).
 * Signature strings embed the full JSON arguments — a `write` call carries the
 * whole file body — so per-turn bookkeeping (the novelty `seen` set, the scoring
 * window, the engine's repeat/cycle guards) stores this digest instead. Bounds a
 * long turn's signature memory at O(steps × ~14 bytes) without changing any
 * equality semantics the guards rely on.
 */
export function hashSignature(s: string): string {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ (c + i), 0x01000193);
  }
  return (h1 >>> 0).toString(36) + "." + (h2 >>> 0).toString(36);
}

export class StepBudget {
  private readonly cfg: StepBudgetConfig;
  private readonly window: { signature: string; success: boolean }[] = [];
  private extensions = 0;
  private currentLimit: number;
  /** Every signature executed this turn — basis of the novelty rule. */
  private readonly seen = new Set<string>();
  /** Never-seen-before signatures recorded since the last granted extension.
   *  An extension requires ≥ 1: a window that merely CYCLES through previously
   *  executed calls (read A, read B, read A, …) is a spin, not progress, even
   *  when every call succeeds and the distinct-count check passes. */
  private novelSinceExtension = 0;

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

  /** Record an executed tool call (ring-buffered to the scoring window).
   *  Stored as a fixed-size digest — see `hashSignature` (memory bound). */
  record(signature: string, success: boolean): void {
    const sig = hashSignature(signature);
    if (!this.seen.has(sig)) {
      this.seen.add(sig);
      this.novelSinceExtension++;
    }
    this.window.push({ signature: sig, success });
    if (this.window.length > this.cfg.windowSize) this.window.shift();
  }

  /** A mid-turn steering message arrived — fresh, user-driven work. Grant headroom
   *  (capped at the hard cap, without consuming the extension budget) and clear the
   *  scoring window so the new instruction is never declined by the previous
   *  sub-task's stall/failure signals. */
  noteSteer(): void {
    this.window.length = 0;
    this.novelSinceExtension = 0;
    this.currentLimit = Math.min(this.currentLimit + this.cfg.extensionSteps, this.cfg.hardCap);
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
    if (this.novelSinceExtension < 1) {
      return decline(
        `no novel tool calls since the last extension (cycling through ${p.distinct} repeated target(s))`,
      );
    }
    this.extensions++;
    this.novelSinceExtension = 0;
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
