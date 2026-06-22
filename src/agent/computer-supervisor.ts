/**
 * Pure-TypeScript supervisor for computer-use safety.
 * Implements a fail-closed supervisor pattern to prevent runaway desktop automation.
 */

export const HEARTBEAT_FRESH_MS = 2000;

export class ComputerSupervisor {
  #suspended = false;
  #killSwitchLive = false;
  #lastHeartbeatMs = 0;

  constructor(options?: { killSwitchLive?: boolean }) {
    this.#killSwitchLive = options?.killSwitchLive ?? false;
  }

  get inputAllowed(): boolean {
    // If the kill switch is not live, we fail closed.
    if (!this.#killSwitchLive) return false;
    // If the heartbeat is stale, we fail closed.
    if (Date.now() - this.#lastHeartbeatMs >= HEARTBEAT_FRESH_MS) return false;
    // If suspended by user, we fail closed.
    if (this.#suspended) return false;
    return true;
  }

  get isSuspended(): boolean {
    return this.#suspended;
  }

  get isKillSwitchLive(): boolean {
    return this.#killSwitchLive;
  }

  get lastHeartbeatMs(): number {
    return this.#lastHeartbeatMs;
  }

  setKillSwitchLive(live: boolean) {
    this.#killSwitchLive = live;
  }

  triggerStop() {
    this.#suspended = true;
  }

  reset() {
    // Only human interaction should call this.
    this.#suspended = false;
    this.heartbeat(); // refresh heartbeat on reset
  }

  heartbeat() {
    this.#lastHeartbeatMs = Date.now();
  }
}

// Global singleton instance for the process
export const computerSupervisor = new ComputerSupervisor();
