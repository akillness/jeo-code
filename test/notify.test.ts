import { test, expect } from "bun:test";
import { shouldBell, emitBell, maybeBell, type NotifyConfig } from "../src/util/notify";

// gajae-code 0.7.8 parity: terminal-bell notifications, off by default.

test("shouldBell: off by default (no config, no env)", () => {
  expect(shouldBell("complete", undefined, {})).toBe(false);
  expect(shouldBell("ask", undefined, {})).toBe(false);
  expect(shouldBell("approval", {}, {})).toBe(false);
});

test("shouldBell: master toggle enables completion and ask events", () => {
  const cfg: NotifyConfig = { bell: true };
  expect(shouldBell("complete", cfg, {})).toBe(true);
  expect(shouldBell("ask", cfg, {})).toBe(true);
  expect(shouldBell("approval", cfg, {})).toBe(true);
});

test("shouldBell: per-event flag can disable a single event while master stays on", () => {
  expect(shouldBell("complete", { bell: true, onComplete: false }, {})).toBe(false);
  expect(shouldBell("ask", { bell: true, onComplete: false }, {})).toBe(true);
  expect(shouldBell("ask", { bell: true, onAsk: false }, {})).toBe(false);
  expect(shouldBell("approval", { bell: true, onAsk: false }, {})).toBe(false);
  // onComplete:false must not silence ask/approval, and vice-versa.
  expect(shouldBell("complete", { bell: true, onAsk: false }, {})).toBe(true);
});

test("shouldBell: env JEO_NOTIFY_BELL=1 forces on even without config", () => {
  expect(shouldBell("complete", undefined, { JEO_NOTIFY_BELL: "1" })).toBe(true);
  expect(shouldBell("ask", undefined, { JEO_NOTIFY_BELL: "true" })).toBe(true);
});

test("shouldBell: env JEO_NOTIFY_BELL=0 forces off even when config enables it", () => {
  expect(shouldBell("complete", { bell: true }, { JEO_NOTIFY_BELL: "0" })).toBe(false);
  expect(shouldBell("ask", { bell: true }, { JEO_NOTIFY_BELL: "false" })).toBe(false);
});

test("emitBell: writes exactly one ASCII BEL and never throws on a dead writer", () => {
  let captured = "";
  emitBell((s) => { captured += s; });
  expect(captured).toBe("\x07");
  // A throwing writer (terminal gone) must be swallowed.
  expect(() => emitBell(() => { throw new Error("EPIPE"); })).not.toThrow();
});

test("maybeBell: fires (and reports) only when shouldBell allows", () => {
  let writes = 0;
  const write = () => { writes++; };
  expect(maybeBell("complete", { bell: true }, write, {})).toBe(true);
  expect(writes).toBe(1);
  // Disabled → no write, returns false.
  expect(maybeBell("complete", { bell: false }, write, {})).toBe(false);
  expect(writes).toBe(1);
});
