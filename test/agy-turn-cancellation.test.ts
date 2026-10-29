import { expect, test } from "bun:test";
import { runAgySessionTurn } from "../src/commands/launch/agy-turn";
import type { Message } from "../src/ai/types";

const header = { type: "session" as const, version: 1, id: "session", timestamp: "2026-01-01", cwd: "/test" };

for (const stage of ["load", "user append"] as const) {
  test(`cancellation during ${stage} prevents the agent turn and in-memory history mutation`, async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const history: Message[] = [{ role: "user", content: "prior" }];
    const original = structuredClone(history);
    const persisted: Message[] = [];
    let ran = false;
    const pending = runAgySessionTurn({ model: "agy/test", prompt: "remote prompt", cwd: "/test", sessionId: "session", history, signal: controller.signal }, {
      loadSession: async () => {
        if (stage === "load") { entered.resolve(); await release.promise; }
        return { header, messages: [] };
      },
      appendMessage: async (_id, message) => {
        if (stage === "user append") { entered.resolve(); await release.promise; }
        persisted.push(message);
      },
      runAgyTurn: async () => { ran = true; throw new Error("unexpected agent execution"); },
    });
    try {
      await entered.promise;
      controller.abort();
      release.resolve();
      await expect(pending).rejects.toThrow();
      expect(history).toEqual(original);
      expect(ran).toBe(false);
      expect(persisted).toEqual(stage === "load" ? [] : [{ role: "user", content: "remote prompt" }]);
    } finally { release.resolve(); }
  });
}
