import { test, expect } from "bun:test";
import { RateLimitPool, type RateLimitItem, type RateLimitLane } from "../src/agent/notify/rate-limit-pool";

function item(over: Partial<RateLimitItem<string>>): RateLimitItem<string> {
  return { sessionId: "s", lane: "finalized", payload: "payload", ...over };
}

// ── Basic submit + drain ─────────────────────────────────────────────────────

test("submit+drain: one item is returned by drain(), pending drops to 0", () => {
  const pool = new RateLimitPool<string>({ now: () => 0 });
  pool.submit(item({ payload: "hello" }));
  expect(pool.pending).toBe(1);
  const granted = pool.drain(0);
  expect(granted.map(g => g.payload)).toEqual(["hello"]);
  expect(pool.pending).toBe(0);
});

// ── Priority lanes ───────────────────────────────────────────────────────────

test("drain: returns items in lane priority order (ask, finalized, live, idle) regardless of submit order", () => {
  const pool = new RateLimitPool<string>({ now: () => 0 });
  // Submit in a scrambled, non-priority order to prove ordering isn't FIFO-by-submission.
  pool.submit(item({ sessionId: "s", lane: "idle", payload: "idle" }));
  pool.submit(item({ sessionId: "s", lane: "live", payload: "live" }));
  pool.submit(item({ sessionId: "s", lane: "ask", payload: "ask" }));
  pool.submit(item({ sessionId: "s", lane: "finalized", payload: "finalized" }));

  const granted = pool.drain(0);
  expect(granted.map(g => g.payload)).toEqual(["ask", "finalized", "live", "idle"]);
});

// ── Token bucket capacity ────────────────────────────────────────────────────

test("drain: a small capacity grants only that many tokens' worth at the same instant, leaving the rest pending", () => {
  const pool = new RateLimitPool<string>({ capacity: 2, refillPerSec: 1, now: () => 1000 });
  for (let i = 0; i < 5; i++) pool.submit(item({ payload: `p${i}` }));
  expect(pool.pending).toBe(5);

  // Same timestamp as construction → no elapsed time → no refill beyond the initial full capacity.
  const granted = pool.drain(1000);
  expect(granted.length).toBe(2);
  expect(pool.pending).toBe(3);
});

// ── Refill over time ─────────────────────────────────────────────────────────

test("availableTokens/drain: refills over simulated time so more items become grantable", () => {
  let now = 1000;
  const pool = new RateLimitPool<string>({ capacity: 2, refillPerSec: 1, now: () => now });
  for (let i = 0; i < 5; i++) pool.submit(item({ payload: `p${i}` }));

  const first = pool.drain(now); // drains the initial 2 tokens
  expect(first.length).toBe(2);
  expect(pool.availableTokens(now)).toBe(0);

  now += 3000; // 3 simulated seconds at refillPerSec=1 → 3 more tokens, capped at capacity=2
  expect(pool.availableTokens(now)).toBe(2);

  const second = pool.drain(now);
  expect(second.length).toBe(2);
  expect(pool.pending).toBe(1);
});

// ── Coalescing ───────────────────────────────────────────────────────────────

test("submit: two items with the same (sessionId, lane, coalesceKey) coalesce — pending stays 1, latest payload wins", () => {
  const pool = new RateLimitPool<string>({ now: () => 0 });
  pool.submit(item({ sessionId: "s", lane: "finalized", coalesceKey: "k", payload: "first" }));
  pool.submit(item({ sessionId: "s", lane: "finalized", coalesceKey: "k", payload: "second" }));
  expect(pool.pending).toBe(1);

  const granted = pool.drain(0);
  expect(granted.map(g => g.payload)).toEqual(["second"]);
});

test("submit: a different coalesceKey does NOT coalesce with either prior item", () => {
  const pool = new RateLimitPool<string>({ now: () => 0 });
  pool.submit(item({ sessionId: "s", lane: "finalized", coalesceKey: "k", payload: "first" }));
  pool.submit(item({ sessionId: "s", lane: "finalized", coalesceKey: "k", payload: "second" }));
  pool.submit(item({ sessionId: "s", lane: "finalized", coalesceKey: "other", payload: "third" }));
  expect(pool.pending).toBe(2);
});

// ── Per-session round-robin fairness ─────────────────────────────────────────

test("drain: per-session round-robin fairness alternates sessions within a lane rather than draining one first", () => {
  let now = 0;
  const pool = new RateLimitPool<string>({ capacity: 1, refillPerSec: 1, now: () => now });

  // Submit all of session A's items, THEN all of session B's — the harder case: if fairness
  // were absent (plain FIFO), A1..A3 would all grant before B1.
  pool.submit(item({ sessionId: "A", lane: "finalized", payload: "A1" }));
  pool.submit(item({ sessionId: "A", lane: "finalized", payload: "A2" }));
  pool.submit(item({ sessionId: "A", lane: "finalized", payload: "A3" }));
  pool.submit(item({ sessionId: "B", lane: "finalized", payload: "B1" }));
  pool.submit(item({ sessionId: "B", lane: "finalized", payload: "B2" }));
  pool.submit(item({ sessionId: "B", lane: "finalized", payload: "B3" }));

  const grantedOrder: string[] = [];
  // capacity:1 + refilling by 1 full second between drains forces exactly one grant per call.
  for (let i = 0; i < 6; i++) {
    const granted = pool.drain(now);
    expect(granted.length).toBe(1);
    grantedOrder.push(granted[0]!.payload);
    now += 1000;
  }

  expect(grantedOrder).toEqual(["A1", "B1", "A2", "B2", "A3", "B3"]);
});

// ── removeWhere ──────────────────────────────────────────────────────────────

test("removeWhere: removes and returns exactly the matching items, leaves the rest queued in relative order", () => {
  const pool = new RateLimitPool<string>({ now: () => 0 });
  pool.submit(item({ sessionId: "keep", lane: "finalized", payload: "k1" }));
  pool.submit(item({ sessionId: "drop", lane: "finalized", payload: "d1" }));
  pool.submit(item({ sessionId: "keep", lane: "idle", payload: "k2" }));
  pool.submit(item({ sessionId: "drop", lane: "idle", payload: "d2" }));
  pool.submit(item({ sessionId: "keep", lane: "finalized", payload: "k3" }));

  const tokensBefore = pool.availableTokens(0);
  const removed = pool.removeWhere(i => i.sessionId === "drop");

  expect(removed.map(r => r.payload)).toEqual(["d1", "d2"]);
  expect(pool.availableTokens(0)).toBe(tokensBefore); // removal never consumes tokens
  expect(pool.pending).toBe(3);

  const granted = pool.drain(0);
  // finalized (k1, k3) before idle (k2); FIFO preserved within each lane.
  expect(granted.map(g => g.payload)).toEqual(["k1", "k3", "k2"]);

  // Removed items never resurface on a later drain.
  expect(pool.drain(0)).toEqual([]);
});

// ── Invalid lane ─────────────────────────────────────────────────────────────

test("submit: an unknown lane throws with the exact error message", () => {
  const pool = new RateLimitPool<string>({ now: () => 0 });
  const bogusLane = "bogus" as unknown as RateLimitLane; // deliberately invalid, cast to exercise the runtime guard
  expect(() => pool.submit(item({ lane: bogusLane }))).toThrow("unknown rate-limit lane: bogus");
});
