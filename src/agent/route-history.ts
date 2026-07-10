/**
 * Routing decision history tracker — maintains a bounded FIFO queue of recent
 * routing decisions for `/route history` visibility and performance analysis.
 *
 * Session-scoped (one per REPL), not persisted to config.
 */

import type { RouteDecision } from "./prompt-router";

export interface RouteHistoryEntry extends RouteDecision {
  timestamp: number; // Date.now()
  /** 1-indexed sequence number of this RECORDED DECISION (not the REPL turn) —
   *  `add()` fires once for the pre-call routing pick AND once more per
   *  mid-turn equivalent-pool fallback (launch.ts's retry loop), so a single
   *  user turn that hits a fallback can produce several CONSECUTIVE entries
   *  here. Do not treat this as a 1:1 conversational-turn counter. */
  turnNumber: number;
}

/**
 * Bounded FIFO queue of routing decisions. Oldest entries are dropped when
 * the queue exceeds `maxSize`. The REPL constructs this with the default
 * `maxSize` (10) — `/route history <n>`'s `n` argument only WINDOWS this
 * already-capped retention (`launch.ts`'s single `new RouteHistory()` call
 * site never passes a wider size), so `/route history 50` silently returns
 * at most the last 10 decisions recorded this session, not 50.
 */
export class RouteHistory {
  private entries: RouteHistoryEntry[] = [];
  private turnNumber = 0;
  readonly maxSize: number;

  constructor(maxSize: number = 10) {
    this.maxSize = Math.max(1, maxSize);
  }

  /**
   * Record a routing decision. Increments the turn counter and adds the entry
   * to the queue, dropping the oldest if necessary.
   */
  add(decision: RouteDecision): void {
    this.turnNumber++;
    const entry: RouteHistoryEntry = {
      ...decision,
      timestamp: Date.now(),
      turnNumber: this.turnNumber,
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxSize) {
      this.entries.shift();
    }
  }

  /**
   * Get all recorded entries in chronological order (oldest first).
   */
  getAll(): RouteHistoryEntry[] {
    return [...this.entries];
  }

  /**
   * Get the most recent entry, if any.
   */
  getLast(): RouteHistoryEntry | undefined {
    return this.entries[this.entries.length - 1];
  }

  /**
   * Get entries for a specific model.
   */
  getByModel(model: string): RouteHistoryEntry[] {
    return this.entries.filter((e) => e.model === model);
  }

  /**
   * Get entries for a specific tier.
   */
  getByTier(tier: string): RouteHistoryEntry[] {
    return this.entries.filter((e) => e.tier === tier);
  }

  /**
   * Compute statistics over the history.
   */
  getStats(): {
    totalDecisions: number;
    modelFrequency: Record<string, number>;
    tierFrequency: Record<string, number>;
    averageConfidence: number;
  } {
    const modelFreq: Record<string, number> = {};
    const tierFreq: Record<string, number> = {};
    let totalConfidence = 0;

    for (const entry of this.entries) {
      modelFreq[entry.model] = (modelFreq[entry.model] ?? 0) + 1;
      tierFreq[entry.tier] = (tierFreq[entry.tier] ?? 0) + 1;
      totalConfidence += entry.confidence;
    }

    return {
      totalDecisions: this.entries.length,
      modelFrequency: modelFreq,
      tierFrequency: tierFreq,
      averageConfidence: this.entries.length > 0 ? totalConfidence / this.entries.length : 0,
    };
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.entries = [];
    this.turnNumber = 0;
  }
}
