import { test, expect, mock } from "bun:test";
import { runAgentLoop } from "../src/agent/engine";
import { LaunchTui } from "../src/tui/app";

// gjc v0.10.1 parity: "make provider-reported usage the SSOT for context tokens/%".
//
// Before this fix, `LaunchTui`'s footer context meter (`ctx NN%/max` in the status
// bar) was seeded ONCE per turn from a client-side character-count estimate
// (`historyTokens(history)`, ~4 chars/token) and never updated again for the rest
// of the turn — even though the engine's `onUsage` event already carried the
// PROVIDER's own reported `input_tokens` for every completed call. The estimate and
// the real number could disagree arbitrarily (cached tokens, non-ASCII text,
// tool-call JSON overhead, provider-side prompt truncation, …), so the displayed
// percentage did not reflect what the provider actually measured/billed.
//
// These tests assert the fixed contract:
//   1. `runAgentLoop`'s `onUsage` event exposes the RAW single-call usage (`lastCall`)
//      separately from the cumulative turn total — the raw signal a context meter
//      needs must actually exist on the wire, not just be reconstructable.
//   2. `LaunchTui`'s footer adopts `lastCall.inputTokens` as `contextUsedTokens` the
//      moment a real provider response arrives, overriding whatever pre-call estimate
//      was seeded via `setContextUsage` — proving the DISPLAYED number is
//      provider-anchored, not the independent client-side estimate.

type TuiInternals = { footer: { contextUsedTokens?: number; contextMaxTokens?: number } };

test("runAgentLoop: onUsage exposes the raw single-call usage (lastCall) alongside the cumulative total", async () => {
  let turn = 0;
  // mock.module requires the mocked implementation to be resolved by a later dynamic
  // import — engine.ts's invokeCallLlm loads "./loop" at call time, so this indirection
  // is what actually substitutes callLlm; there is no static-import alternative here.
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (_h: unknown, opts: { onUsage?: (u: { inputTokens: number; outputTokens: number }) => void }) => {
      turn++;
      // Each step resends the whole (growing) history — a realistic provider would
      // report a LARGER input_tokens on step 2 than step 1, never a plain doubling.
      opts.onUsage?.(turn === 1 ? { inputTokens: 5_000, outputTokens: 50 } : { inputTokens: 5_400, outputTokens: 80 });
      if (turn === 1) return JSON.stringify({ tool: "noop", arguments: {} });
      return JSON.stringify({ tool: "done", arguments: { reason: "ok" } });
    },
  }));
  const seenCumulative: { inputTokens: number; outputTokens: number }[] = [];
  const seenLastCall: ({ inputTokens: number; outputTokens: number } | undefined)[] = [];
  const result = await runAgentLoop([{ role: "user" as const, content: "go" }], {
    cwd: process.cwd(),
    maxSteps: 5,
    tools: { noop: async () => ({ success: true, output: "ok" }) },
    events: {
      onUsage: (u, lastCall) => {
        seenCumulative.push(u);
        seenLastCall.push(lastCall);
      },
    },
  });
  expect(result.done).toBe(true);
  expect(seenCumulative.length).toBe(2);
  // Cumulative total keeps summing across steps (unchanged — drives /usage billing).
  expect(seenCumulative[0]).toEqual({ inputTokens: 5_000, outputTokens: 50 });
  expect(seenCumulative[1]).toEqual({ inputTokens: 10_400, outputTokens: 130 });
  // `lastCall` is the RAW per-call figure — step 2's own reported context size, not
  // the sum. A regression that drops `lastCall` (or reuses the cumulative value) would
  // fail this assertion, since 10_400 !== 5_400.
  expect(seenLastCall[0]).toEqual({ inputTokens: 5_000, outputTokens: 50 });
  expect(seenLastCall[1]).toEqual({ inputTokens: 5_400, outputTokens: 80 });
});

test("LaunchTui footer: contextUsedTokens is overwritten by the provider's own lastCall usage, not the pre-call client-side estimate", () => {
  const tui = new LaunchTui({ model: "claude-sonnet-5", write: () => {} });
  const internals = tui as unknown as TuiInternals;
  tui.start();
  const ev = tui.events();

  // Turn start: the REPL seeds the footer with a client-side character-count
  // estimate before any provider response exists (launch.ts's real call site:
  // `tui.setContextUsage(historyTokens(history), contextTokens)`).
  tui.setContextUsage(1_234, 1_000_000);
  expect(internals.footer.contextUsedTokens).toBe(1_234);

  // The provider responds. Its OWN reported usage for this call is very different
  // from the crude character estimate above (e.g. cached/native tool-schema tokens
  // the client-side heuristic never accounted for).
  ev.onUsage?.({ inputTokens: 47_832, outputTokens: 210 }, { inputTokens: 47_832, outputTokens: 210 });

  // The footer's context meter must now show the PROVIDER's number, not the stale
  // pre-call estimate — this is the exact drift gjc's fix eliminates.
  expect(internals.footer.contextUsedTokens).toBe(47_832);
  expect(internals.footer.contextUsedTokens).not.toBe(1_234);
  // contextMaxTokens (the catalog ceiling) is untouched by onUsage — only the used
  // count is provider-anchored.
  expect(internals.footer.contextMaxTokens).toBe(1_000_000);

  tui.finish("done");
});

test("LaunchTui footer: a multi-step turn's context meter tracks the LATEST call, not a running sum", () => {
  const tui = new LaunchTui({ model: "claude-sonnet-5", write: () => {} });
  const internals = tui as unknown as TuiInternals;
  tui.start();
  const ev = tui.events();
  tui.setContextUsage(0, 200_000);

  // Step 1: provider reports 5k input tokens for this call.
  ev.onUsage?.({ inputTokens: 5_000, outputTokens: 50 }, { inputTokens: 5_000, outputTokens: 50 });
  expect(internals.footer.contextUsedTokens).toBe(5_000);

  // Step 2: the turn resent the growing history — provider now reports 5.4k for
  // THIS call. The cumulative total across both calls would be 10_400; the context
  // meter must show the latest call's own figure (5_400), never the sum.
  ev.onUsage?.({ inputTokens: 10_400, outputTokens: 130 }, { inputTokens: 5_400, outputTokens: 80 });
  expect(internals.footer.contextUsedTokens).toBe(5_400);
  expect(internals.footer.contextUsedTokens).not.toBe(10_400);

  tui.finish("done");
});
