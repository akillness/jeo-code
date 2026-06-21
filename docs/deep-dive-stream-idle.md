# Deep Dive — recurring `stream idle … (no chunk)` halt

Investigation of "근본문제 — 계속 오류나와서 멈춰" (keeps erroring and stops). Trace
stage mapped the causal chain across the runtime; the interview stage crystallized the
fix below. Evidence is from the source as of this change, not assumptions.

## Symptom
A turn intermittently aborts with `stream idle for <ms>ms (no chunk) …`, retries, and
after the attempt budget is spent the turn **stops** (fails) instead of completing.

## Causal trace (3 lanes)

**Lane A — where the abort fires.** `nextMaybeIdle` (`src/ai/model-manager.ts`) races
each `iter.next()` against a watchdog that rejects when no activity advances
`lastActivityAt` within `idleMs`. The very first `iter.next()` is also raced, so the
clock runs during the provider's `await fetch(...)` and time-to-first-byte, before any
SSE body byte exists.

**Lane B — heartbeat wiring.** `lastActivityAt` is bumped by (1) `onReasoning` /
`onReasoningStart` deltas and (2) `onStreamActivity` — a wire-level heartbeat fired by
`readLines`/`readSse` (`src/ai/sse.ts`) on ANY received byte chunk, threaded through all
six providers (`anthropic`, `openai`, `openai-responses`, `gemini`, `antigravity`,
`ollama`). Verified each streaming path passes `options.onStreamActivity`; the
non-streaming `call()` paths correctly do not (they use `DEFAULT_CALL_TIMEOUT_MS`).

**Lane C — retry/halt.** `defaultRetryable` (`src/util/retry.ts`) classifies
`stream idle` / `no chunk` as retryable; `withRetry` defaults to 3 attempts. If the
underlying stall repeats on every attempt, the budget exhausts and the error propagates
up the agent loop → the turn stops.

## Root cause
The wire heartbeat removes the false abort **whenever the provider emits bytes** within
each idle window (remote providers send `message_start` / role deltas / `ping`
keepalives). The residual, unfixable-by-heartbeat case is a **genuinely silent stream**:
a local backend (Ollama / llama.cpp) performs model load + prompt-eval before the first
token and emits **zero bytes and no keepalive** during that phase. On modest hardware or
a large context this routinely exceeds the old 120s cap. The heartbeat has nothing to
fire on, so the watchdog aborts an alive-but-quiet generation; each retry re-incurs the
same slow first byte; the budget exhausts; the turn stops. The 120s default was the
operative root: too tight for the realistic silent-first-byte worst case.

## Fix (this change)
1. **Wire-level heartbeat (already shipped):** any provider byte re-arms the watchdog —
   eliminates the false abort for every keepalive-emitting (remote) provider.
2. **Default idle window 120s → 300s:** the cap now only bites a genuinely dead stream
   after 5 minutes, covering silent local prompt-eval and longer server-side reasoning
   without killing alive generation. Remote providers rarely reach it (heartbeat).
3. **Surfaced `JEO_STREAM_IDLE_MS`** in README for backends silent even longer; Ctrl-C
   remains the interactive escape; `JEO_STREAM_MAX_MS` still opts into a hard overall cap.

## Why not other options
- A single overall wall-clock cap would kill long-but-active generations — deliberately
  opt-in only (`JEO_STREAM_MAX_MS`), unchanged.
- The watchdog cannot distinguish "dead socket" from "alive but silent" without
  protocol-level liveness the providers do not give during prompt-eval; a generous,
  overridable idle cap is the correct pragmatic resolution.
