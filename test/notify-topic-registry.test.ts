import { test, expect } from "bun:test";
import {
  TopicRegistry,
  emptyTopicRegistryState,
  type TopicRegistryState,
} from "../src/agent/notify/topic-registry";

// ── getOrCreateTopic ────────────────────────────────────────────────────────────

test("getOrCreateTopic: first call for a new session invokes create() and returns a TopicRecord", async () => {
  let createCalls = 0;
  const registry = new TopicRegistry();
  const record = await registry.getOrCreateTopic(
    "session-a",
    async () => {
      createCalls++;
      return 42;
    },
    () => 1000,
    "my topic",
  );
  expect(createCalls).toBe(1);
  expect(record).toEqual({ topicId: 42, createdAt: 1000, name: "my topic" });
});

test("getOrCreateTopic: name is undefined when omitted", async () => {
  const registry = new TopicRegistry();
  const record = await registry.getOrCreateTopic("session-a", async () => 7, () => 1000);
  expect(record.name).toBeUndefined();
});

test("getOrCreateTopic: second call for the same session does NOT re-invoke create(), returns the cached record", async () => {
  let createCalls = 0;
  const registry = new TopicRegistry();
  const first = await registry.getOrCreateTopic("session-a", async () => {
    createCalls++;
    return 42;
  });
  const second = await registry.getOrCreateTopic("session-a", async () => {
    createCalls++;
    return 999; // would prove a second create happened if returned
  });
  expect(createCalls).toBe(1);
  expect(second).toBe(first); // exact same cached record
  expect(second.topicId).toBe(42);
});

test("getOrCreateTopic: concurrency guard — two concurrent calls for the same new session share one create()", async () => {
  let createCalls = 0;
  const gate = Promise.withResolvers<number>();
  const registry = new TopicRegistry();

  const p1 = registry.getOrCreateTopic("session-a", async () => {
    createCalls++;
    return gate.promise;
  });
  const p2 = registry.getOrCreateTopic("session-a", async () => {
    createCalls++;
    return gate.promise; // must never run — the guard should dedupe before this create fires
  });

  gate.resolve(42);
  const [r1, r2] = await Promise.all([p1, p2]);

  expect(createCalls).toBe(1);
  expect(r1.topicId).toBe(42);
  expect(r2.topicId).toBe(42);
  expect(r1).toBe(r2); // same record instance
});

// ── sessionForTopic / sessionIds / get ──────────────────────────────────────────

test("sessionForTopic: reverse lookup resolves a created topic's id, undefined for unknown ids", async () => {
  const registry = new TopicRegistry();
  await registry.getOrCreateTopic("session-a", async () => 42);
  expect(registry.sessionForTopic(42)).toBe("session-a");
  expect(registry.sessionForTopic(999)).toBeUndefined();
});

test("sessionIds: returns all session ids with a topic record, empty when none", async () => {
  const registry = new TopicRegistry();
  expect(registry.sessionIds()).toEqual([]);
  await registry.getOrCreateTopic("session-a", async () => 1);
  await registry.getOrCreateTopic("session-b", async () => 2);
  expect(registry.sessionIds().sort()).toEqual(["session-a", "session-b"]);
});

test("get: returns the record for a known session, undefined for an unknown one", async () => {
  const registry = new TopicRegistry();
  await registry.getOrCreateTopic("session-a", async () => 42, () => 1000, "t");
  expect(registry.get("session-a")).toEqual({ topicId: 42, createdAt: 1000, name: "t" });
  expect(registry.get("session-z")).toBeUndefined();
});

// ── applyName ────────────────────────────────────────────────────────────────

test("applyName: first call updates .name and returns true", async () => {
  const registry = new TopicRegistry();
  await registry.getOrCreateTopic("session-a", async () => 42, () => 1000);
  const changed = registry.applyName("session-a", "repo@main");
  expect(changed).toBe(true);
  expect(registry.get("session-a")?.name).toBe("repo@main");
});

test("applyName: identical name on second call is a no-op — returns false, leaves createdAt/topicId untouched", async () => {
  const registry = new TopicRegistry();
  await registry.getOrCreateTopic("session-a", async () => 42, () => 1000);
  registry.applyName("session-a", "repo@main");
  const before = registry.get("session-a");
  const changed = registry.applyName("session-a", "repo@main");
  expect(changed).toBe(false);
  expect(registry.get("session-a")).toEqual(before);
  expect(registry.get("session-a")?.createdAt).toBe(1000);
  expect(registry.get("session-a")?.topicId).toBe(42);
});

test("applyName: a different name after a no-op call returns true again", async () => {
  const registry = new TopicRegistry();
  await registry.getOrCreateTopic("session-a", async () => 42, () => 1000);
  registry.applyName("session-a", "repo@main");
  registry.applyName("session-a", "repo@main"); // no-op
  const changed = registry.applyName("session-a", "repo@feature");
  expect(changed).toBe(true);
  expect(registry.get("session-a")?.name).toBe("repo@feature");
});

test("applyName: returns false for a session with no topic record", () => {
  const registry = new TopicRegistry();
  expect(registry.applyName("no-such-session", "anything")).toBe(false);
});

// ── wouldRename ──────────────────────────────────────────────────────────────

test("wouldRename: true for a new name on an existing topic, and does NOT mutate the record", async () => {
  const registry = new TopicRegistry();
  await registry.getOrCreateTopic("session-a", async () => 42, () => 1000);
  const before = registry.get("session-a");
  expect(registry.wouldRename("session-a", "repo@main")).toBe(true);
  expect(registry.get("session-a")).toEqual(before);
  expect(registry.get("session-a")?.name).toBeUndefined();
});

test("wouldRename: false once applyName has committed the same name", async () => {
  const registry = new TopicRegistry();
  await registry.getOrCreateTopic("session-a", async () => 42, () => 1000);
  registry.applyName("session-a", "repo@main");
  expect(registry.wouldRename("session-a", "repo@main")).toBe(false);
  expect(registry.wouldRename("session-a", "repo@feature")).toBe(true);
});

test("wouldRename: false for a session with no topic record", () => {
  const registry = new TopicRegistry();
  expect(registry.wouldRename("no-such-session", "anything")).toBe(false);
});

test("wouldRename: repeated calls with a failed-to-commit name stay true (peek never mutates, so a caller can retry after a failed remote rename)", async () => {
  const registry = new TopicRegistry();
  await registry.getOrCreateTopic("session-a", async () => 42, () => 1000);
  expect(registry.wouldRename("session-a", "repo@main")).toBe(true);
  // Simulate: caller checked wouldRename, attempted a remote rename, it
  // failed, so applyName was never called — the peek must still say "yes,
  // this would still be a change" on the next attempt.
  expect(registry.wouldRename("session-a", "repo@main")).toBe(true);
  expect(registry.get("session-a")?.name).toBeUndefined();
});

// ── delete ───────────────────────────────────────────────────────────────────

test("delete: removes the record, reverse lookup and get() both become undefined, returns true", async () => {
  const registry = new TopicRegistry();
  await registry.getOrCreateTopic("session-a", async () => 42);
  const removed = registry.delete("session-a");
  expect(removed).toBe(true);
  expect(registry.get("session-a")).toBeUndefined();
  expect(registry.sessionForTopic(42)).toBeUndefined();
});

test("delete: returns false when the session had no record to begin with", () => {
  const registry = new TopicRegistry();
  expect(registry.delete("no-such-session")).toBe(false);
});

// ── serialize / load / constructor round-trip ───────────────────────────────

test("serialize()/constructor round-trip: a fresh registry built from serialized state reflects it identically", async () => {
  const registry = new TopicRegistry();
  await registry.getOrCreateTopic("session-a", async () => 1, () => 100, "a");
  await registry.getOrCreateTopic("session-b", async () => 2, () => 200, "b");

  const state: TopicRegistryState = registry.serialize();
  const restored = new TopicRegistry(state);

  expect(restored.sessionIds().sort()).toEqual(["session-a", "session-b"]);
  expect(restored.get("session-a")).toEqual({ topicId: 1, createdAt: 100, name: "a" });
  expect(restored.get("session-b")).toEqual({ topicId: 2, createdAt: 200, name: "b" });
  expect(restored.sessionForTopic(1)).toBe("session-a");
  expect(restored.sessionForTopic(2)).toBe("session-b");
});

test("load(): merges additional sessions into an already-populated registry without dropping existing ones", async () => {
  const registry = new TopicRegistry();
  await registry.getOrCreateTopic("session-a", async () => 1, () => 100, "a");

  const extra: TopicRegistryState = {
    topics: { "session-b": { topicId: 2, createdAt: 200, name: "b" } },
  };
  registry.load(extra);

  expect(registry.sessionIds().sort()).toEqual(["session-a", "session-b"]);
  expect(registry.get("session-a")).toEqual({ topicId: 1, createdAt: 100, name: "a" });
  expect(registry.get("session-b")).toEqual({ topicId: 2, createdAt: 200, name: "b" });
  expect(registry.sessionForTopic(1)).toBe("session-a");
  expect(registry.sessionForTopic(2)).toBe("session-b");
});

test("load(): a record for an existing session id overwrites that session's record (last-write-wins merge)", () => {
  const registry = new TopicRegistry({
    topics: { "session-a": { topicId: 1, createdAt: 100, name: "old" } },
  });
  registry.load({ topics: { "session-a": { topicId: 1, createdAt: 100, name: "new" } } });
  expect(registry.get("session-a")?.name).toBe("new");
});

// ── emptyTopicRegistryState ──────────────────────────────────────────────────

test("emptyTopicRegistryState returns {topics: {}}", () => {
  expect(emptyTopicRegistryState()).toEqual({ topics: {} });
});

test("constructor defaults to an empty state when none is passed", () => {
  const registry = new TopicRegistry();
  expect(registry.sessionIds()).toEqual([]);
  expect(registry.serialize()).toEqual({ topics: {} });
});
