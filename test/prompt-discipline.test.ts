import { test, expect } from "bun:test";
import { TOOL_PROTOCOL, WORKING_DISCIPLINE, OUTPUT_DISCIPLINE, executorSystemPrompt } from "../src/agent/engine";
import { buildToolProtocol } from "../src/commands/launch";

// P1 — tool calibration + web_search reflex. The reflex only belongs where web_search
// is advertised (engine TOOL_PROTOCOL); the calibration line must reach BOTH the executor
// protocol AND the interactive buildToolProtocol (the interactive path uses its own,
// separate protocol string — adding only to TOOL_PROTOCOL would miss the default user).
test("P1: TOOL_PROTOCOL carries tool-calibration and web_search reflex", () => {
  expect(TOOL_PROTOCOL).toContain("Tool calibration");
  expect(TOOL_PROTOCOL).toContain("web_search reflex");
  expect(TOOL_PROTOCOL).toContain("Locate before you open");
});

test("P1: interactive buildToolProtocol carries the calibration line (no web_search there)", () => {
  const proto = buildToolProtocol(new Set(["read", "write", "edit", "bash", "find", "search", "ls"]));
  expect(proto).toContain("Tool calibration");
  // web_search is not an interactive tool, so its reflex must NOT be advertised here.
  expect(proto).not.toContain("web_search reflex");
});

// P2 — reply discipline, injected into interactive + executor prompts only.
test("P2: OUTPUT_DISCIPLINE is reply discipline and is woven into executorSystemPrompt", () => {
  expect(OUTPUT_DISCIPLINE).toContain("Reply discipline");
  expect(OUTPUT_DISCIPLINE).toContain("Lead with the answer");
  expect(executorSystemPrompt()).toContain("Reply discipline");
});

// Workstream B honesty lines folded into WORKING_DISCIPLINE (plan_jeo 1+2, line 3 merged).
test("WORKING_DISCIPLINE: don't-assume-disk + anti-hallucination + merged trust/verify line", () => {
  expect(WORKING_DISCIPLINE).toContain("Don't assume disk/state");
  expect(WORKING_DISCIPLINE).toContain("Don't fabricate API/library surfaces");
  expect(WORKING_DISCIPLINE).toContain("Trust tool output, but re-read/re-run on failure");
  // The standalone "Re-read before acting if a tool fails" line was merged into the
  // trust/verify line, not duplicated.
  expect(WORKING_DISCIPLINE).not.toContain("Re-read before acting if a tool fails");
});

// P7 — done-gate self-check replaces the bare "Always verify" directive.
test("P7: executorSystemPrompt done self-check replaces the bare verify directive", () => {
  const p = executorSystemPrompt();
  expect(p).toContain("Before calling done, self-check");
  expect(p).not.toContain("Always verify (run tests / execute the program) before calling done.");
});

// FABLE-5 §2.4 (mistake ownership) → WORKING_DISCIPLINE; §2.7 (bounded web quoting) → TOOL_PROTOCOL.
test("fable5 disciplines: failure-posture in WORKING_DISCIPLINE, bounded web-quote in TOOL_PROTOCOL", () => {
  expect(WORKING_DISCIPLINE).toContain("fix the cause and continue");
  expect(WORKING_DISCIPLINE).toContain("no apology loops");
  expect(TOOL_PROTOCOL).toContain("paraphrase by default");
});

// Token budget: WORKING_DISCIPLINE's original intent was "<300 tokens". It was deliberately
// enriched with the fable5 HIGH-leverage disciplines (don't-assume-disk, anti-hallucination,
// failure-posture) and trimmed to stay lean; assert it does not balloon past a small headroom
// over the original intent (coarse chars/4 proxy; real cl100k count is lower).
test("token budget: WORKING_DISCIPLINE stays lean after fable5 enrichment", () => {
  const approxTokens = (s: string) => Math.ceil(s.length / 4);
  expect(approxTokens(WORKING_DISCIPLINE)).toBeLessThan(340);
  expect(approxTokens(OUTPUT_DISCIPLINE)).toBeLessThan(120);
});
