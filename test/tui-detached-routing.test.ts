import { expect, test } from "bun:test";
import { dispatchSubagentDisplay } from "../src/commands/launch/stream";
import type { TaskSubEvent } from "../src/agent/task-tool";

test("detached events display only in their owning session and terminal events wait for the active turn", () => {
  const seen: string[] = [];
  const handlers = {
    original: (event: TaskSubEvent) => seen.push(`original:${event.kind}`),
    active: (event: TaskSubEvent) => seen.push(`active:${event.kind}`),
    deferred: (event: TaskSubEvent) => seen.push(`deferred:${event.kind}`),
    idle: (event: TaskSubEvent) => seen.push(`idle:${event.kind}`),
  };
  const event: TaskSubEvent = { role: "tester", kind: "done", runId: "run-1", detachedId: "worker-1", detail: "Finished", success: true };
  dispatchSubagentDisplay(event, { sameSession: true, originatingTurnOpen: true, activeTui: true, turnActive: true }, handlers);
  dispatchSubagentDisplay(event, { sameSession: true, originatingTurnOpen: false, activeTui: true, turnActive: true }, handlers);
  dispatchSubagentDisplay(event, { sameSession: true, originatingTurnOpen: false, activeTui: false, turnActive: true }, handlers);
  dispatchSubagentDisplay(event, { sameSession: true, originatingTurnOpen: false, activeTui: false, turnActive: false }, handlers);
  dispatchSubagentDisplay({ ...event, kind: "error" }, { sameSession: true, originatingTurnOpen: false, activeTui: false, turnActive: false }, handlers);
  dispatchSubagentDisplay({ ...event, kind: "tool" }, { sameSession: true, originatingTurnOpen: false, activeTui: false, turnActive: false }, handlers);
  dispatchSubagentDisplay(event, { sameSession: false, originatingTurnOpen: true, activeTui: true, turnActive: true }, handlers);
  dispatchSubagentDisplay(event, { sameSession: false, originatingTurnOpen: false, activeTui: true, turnActive: true }, handlers);
  dispatchSubagentDisplay(event, { sameSession: false, originatingTurnOpen: false, activeTui: false, turnActive: false }, handlers);
  expect(seen).toEqual(["original:done", "active:done", "deferred:done", "idle:done", "idle:error"]);
});
