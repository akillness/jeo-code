import { test, expect } from "bun:test";
import { runComputerSlash, type ComputerSlashCtx } from "../src/commands/launch/computer-slash";

const baseCtx = (overrides: Partial<ComputerSlashCtx> = {}): ComputerSlashCtx => ({
  sessionComputerOverride: undefined,
  computerConfigEnabled: false,
  ...overrides,
});

test("/computer (bare) reports off when nothing is configured", () => {
  const result = runComputerSlash("/computer", baseCtx());
  expect(result.sessionComputerOverride).toBeUndefined();
  expect(result.lines[0]).toBe("computer use: off (this session)");
  expect(result.lines[1]).toContain("/computer on");
});

test("/computer status reports on when config.computer.enabled is true", () => {
  const result = runComputerSlash("/computer status", baseCtx({ computerConfigEnabled: true }));
  expect(result.lines[0]).toBe("computer use: on (this session)");
  expect(result.lines[1]).toContain("kill-switch/heartbeat supervisor");
});

test("/computer status: sessionComputerOverride wins over computerConfigEnabled", () => {
  const off = runComputerSlash("/computer status", baseCtx({ computerConfigEnabled: true, sessionComputerOverride: false }));
  expect(off.lines[0]).toBe("computer use: off (this session)");

  const on = runComputerSlash("/computer status", baseCtx({ computerConfigEnabled: false, sessionComputerOverride: true }));
  expect(on.lines[0]).toBe("computer use: on (this session)");
});

test("/computer on sets sessionComputerOverride true and reports it", () => {
  const result = runComputerSlash("/computer on", baseCtx());
  expect(result.sessionComputerOverride).toBe(true);
  expect(result.lines).toEqual(["computer use: on (this session)"]);
});

test("/computer off sets sessionComputerOverride false and reports it", () => {
  const result = runComputerSlash("/computer off", baseCtx({ sessionComputerOverride: true }));
  expect(result.sessionComputerOverride).toBe(false);
  expect(result.lines).toEqual(["computer use: off (this session)"]);
});

test("unknown /computer subcommand prints a usage hint, never throws", () => {
  const result = runComputerSlash("/computer bogus", baseCtx());
  expect(result.sessionComputerOverride).toBeUndefined();
  expect(result.lines[0]).toContain("bogus");
  expect(result.lines[1]).toBe("Usage: /computer [status|on|off]");
});
