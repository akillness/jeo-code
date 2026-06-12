import { test, expect } from "bun:test";
import { nonInteractiveEnv, inputTimeoutMs } from "../src/commands/deep-interview";

// Regression: `jeo deep-interview` run inside an orchestrator PTY (isTTY true, no
// human) used to block forever on `rl.question`. These helpers drive the two guards
// that bound the wait: explicit non-interactive env → auto, and an idle timeout.

test("nonInteractiveEnv: CI / JEO_NONINTERACTIVE flip auto on even when stdin is a TTY", () => {
  expect(nonInteractiveEnv({})).toBe(false);
  expect(nonInteractiveEnv({ CI: "1" })).toBe(true);
  expect(nonInteractiveEnv({ CI: "true" })).toBe(true);
  expect(nonInteractiveEnv({ JEO_NONINTERACTIVE: "1" })).toBe(true);
  expect(nonInteractiveEnv({ JEO_NONINTERACTIVE: "yes" })).toBe(true);
});

test("nonInteractiveEnv: falsey / absent values stay interactive", () => {
  expect(nonInteractiveEnv({ CI: "" })).toBe(false);
  expect(nonInteractiveEnv({ CI: "0" })).toBe(false);
  expect(nonInteractiveEnv({ CI: "false" })).toBe(false);
  expect(nonInteractiveEnv({ CI: "no" })).toBe(false);
  expect(nonInteractiveEnv({ JEO_NONINTERACTIVE: "0" })).toBe(false);
});

test("inputTimeoutMs: bounded default, env override, and 0 = disabled", () => {
  expect(inputTimeoutMs({})).toBe(300_000); // generous for a human, finite for automation
  expect(inputTimeoutMs({ JEO_INPUT_TIMEOUT_MS: "4000" })).toBe(4000);
  expect(inputTimeoutMs({ JEO_INPUT_TIMEOUT_MS: "0" })).toBe(0); // opt back into legacy block-forever
  // Garbage falls back to the safe default rather than NaN (which would never fire).
  expect(inputTimeoutMs({ JEO_INPUT_TIMEOUT_MS: "abc" })).toBe(300_000);
  expect(inputTimeoutMs({ JEO_INPUT_TIMEOUT_MS: "-5" })).toBe(300_000);
});
