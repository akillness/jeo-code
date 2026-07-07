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

## Follow-up regression (v0.7.42 → v0.7.53): the "not other options" call reversed itself
§"Why not other options" above (this doc's original conclusion) explicitly rejected an
overall wall-clock cap as deliberately opt-in-only. v0.7.42 (a LATER, separate fix for a
different bug — a connected-but-never-terminating stream hanging "thinking" forever)
reversed that decision without updating this doc: `streamMaxMs()` was changed to default
to an ALWAYS-ON 300s overall deadline (`DEFAULT_CALL_TIMEOUT_MS`) instead of opt-in-off.

That 300s blanket cap then broke exactly the case this doc's original fix was protecting:
a GPT-5.5/o3-class model at HIGH/XHIGH reasoning effort streams continuously (wire
heartbeat correctly keeps the PER-CHUNK idle watchdog satisfied) but legitimately runs
longer than 5 minutes end-to-end — OpenAI's own documentation states xhigh trades latency
for depth deliberately. The overall deadline killed a healthy, actively-emitting stream
with `"stream exceeded the overall deadline (JEO_STREAM_MAX_MS) — slow-drip stream
aborted"`, reported live under Codex/ChatGPT OAuth (`codexResponsesStream`) with GPT-5.5.

**Resolution:** rather than re-reverting to opt-in-off (which would reopen a real gap for
direct non-turn-wrapped callers like `jeo chat`, since `JEO_TURN_MAX_MS`'s turn-level
stall-budget backstop — itself timer-armed as of v0.7.42 — only wraps `runAgentLoop`
steps), `DEFAULT_CALL_TIMEOUT_MS` was raised 300s → 30min, shared by both `streamMaxMs()`
and `callTimeoutMs()`. This matches `turnMaxMs()`'s own already-vetted 30min stall-budget
default and the OBSERVED ~20-30min infra-side connection-duration cap on OpenAI's
Codex/ChatGPT backend (a real boundary already handled elsewhere as a retryable
mid-stream socket close) — so 30min is a real, evidenced ceiling, not an arbitrary pick.
The non-streaming `call()` path's IDENTICAL bug (zero idle/activity tracking at all,
affecting subagents/compaction/goal-verify which never wire `onModelStream`) is fixed by
the same constant change. `friendlyProviderError` also gained explicit guidance for both
the bare `TimeoutError` DOMException and the overall-deadline message, naming the exact
env var to raise instead of surfacing an opaque timeout string.
