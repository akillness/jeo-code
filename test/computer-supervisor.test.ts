import { expect, test, mock } from "bun:test";
import { ComputerSupervisor, HEARTBEAT_FRESH_MS } from "../src/agent/computer-supervisor";

test("ComputerSupervisor: fail-closed by default (no kill switch, no heartbeat)", () => {
  const supervisor = new ComputerSupervisor();
  expect(supervisor.inputAllowed).toBe(false);
});

test("ComputerSupervisor: fail-closed if heartbeat is missing/stale", () => {
  const supervisor = new ComputerSupervisor({ killSwitchLive: true });
  expect(supervisor.inputAllowed).toBe(false); // no heartbeat yet

  supervisor.heartbeat();
  expect(supervisor.inputAllowed).toBe(true);

  // Mock Date.now to simulate time passing
  const originalNow = Date.now;
  try {
    const now = Date.now();
    Date.now = () => now + HEARTBEAT_FRESH_MS + 100;
    expect(supervisor.inputAllowed).toBe(false);
  } finally {
    Date.now = originalNow;
  }
});

test("ComputerSupervisor: fail-closed if suspended", () => {
  const supervisor = new ComputerSupervisor({ killSwitchLive: true });
  supervisor.heartbeat();
  expect(supervisor.inputAllowed).toBe(true);

  supervisor.triggerStop();
  expect(supervisor.inputAllowed).toBe(false);
  expect(supervisor.isSuspended).toBe(true);

  // Resetting allows input again
  supervisor.reset();
  expect(supervisor.inputAllowed).toBe(true);
  expect(supervisor.isSuspended).toBe(false);
});
