/**
 * Per-session forum-topic registry for the threaded session surface (gjc
 * `topic-registry.ts` parity, adapted: numeric topicId, no identitySent
 * tracking).
 *
 * Each jeo session owns one active Telegram forum topic in the paired private
 * DM. The topic is created via `createForumTopic`, reused while the session
 * remains active, and removed from the registry when the daemon deletes it on
 * shutdown. Unlike gjc, this registry does NOT track whether the one-time
 * identity header has been sent — that is a session-side decision (the
 * session-endpoint owns a simple boolean for "have I sent my own identity
 * this run") and does not need to survive daemon restarts.
 *
 * State is a plain serializable map persisted beside the daemon state files;
 * topic creation is injected so this module is pure and unit-testable without
 * a live Bot API.
 */

/** Persisted record for one session's topic. */
export interface TopicRecord {
  /** Telegram forum topic id (message_thread_id). */
  topicId: number;
  /** Creation timestamp (ms epoch). */
  createdAt: number;
  /** Last applied topic title (for rename detection). */
  name?: string;
}

/** Serializable shape persisted to disk. */
export interface TopicRegistryState {
  /** sessionId -> record. */
  topics: Record<string, TopicRecord>;
}

export function emptyTopicRegistryState(): TopicRegistryState {
  return { topics: {} };
}

/**
 * In-memory registry over a serializable state. Topic creation is injected via
 * `getOrCreateTopic`'s `create` callback (the daemon supplies a real
 * `createForumTopic` call); reuse-on-resume is automatic when a record exists.
 */
export class TopicRegistry {
  private readonly topics: Map<string, TopicRecord>;
  /** Maps topicId -> sessionId for fast inbound routing. */
  private readonly byTopic = new Map<number, string>();
  /** In-flight create promises, keyed by session, to dedupe concurrent creates. */
  private readonly inflight = new Map<string, Promise<TopicRecord>>();

  constructor(state: TopicRegistryState = emptyTopicRegistryState()) {
    this.topics = new Map(Object.entries(state.topics ?? {}));
    for (const [sessionId, record] of this.topics) this.byTopic.set(record.topicId, sessionId);
  }

  /** Merge a serialized state into this registry, preserving all persisted fields. */
  load(state: TopicRegistryState): void {
    for (const [sessionId, record] of Object.entries(state.topics ?? {})) {
      this.topics.set(sessionId, record);
      this.byTopic.set(record.topicId, sessionId);
    }
  }

  /** Resolve the owning session for a topic id (for fail-closed inbound routing). */
  sessionForTopic(topicId: number): string | undefined {
    return this.byTopic.get(topicId);
  }

  /** All session ids with a persisted topic record. */
  sessionIds(): string[] {
    return [...this.topics.keys()];
  }

  /** The existing topic record for a session, if any. */
  get(sessionId: string): TopicRecord | undefined {
    return this.topics.get(sessionId);
  }

  /**
   * Return the existing active topic for `sessionId`, or create one via
   * `create` (called only on first use).
   */
  async getOrCreateTopic(
    sessionId: string,
    create: () => Promise<number>,
    now: () => number = Date.now,
    name?: string,
  ): Promise<TopicRecord> {
    const existing = this.topics.get(sessionId);
    if (existing) return existing;
    // Concurrency guard: many session frames (identity/idle/turn/ask) can race
    // to first-use the same session. Without this, each call passes the
    // `existing` check before `create()` resolves and creates a DUPLICATE
    // forum topic. Share a single in-flight create per session id.
    const pending = this.inflight.get(sessionId);
    if (pending) return pending;
    const promise = (async () => {
      const topicId = await create();
      const record: TopicRecord = { topicId, name, createdAt: now() };
      this.topics.set(sessionId, record);
      this.byTopic.set(topicId, sessionId);
      return record;
    })();
    this.inflight.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(sessionId);
    }
  }

  /**
   * Pure peek: true when applying `name` to `sessionId`'s topic would
   * actually change it (no topic record, or already at that name, both
   * return false). Does NOT mutate — pair with `applyName`, called only
   * AFTER a remote rename (`editForumTopic`) confirms success. Committing
   * the name here unconditionally (as a prior version did) let a transient
   * remote failure leave the LOCAL registry believing the rename had already
   * applied, so the next identical `identity_header` reassertion silently
   * skipped retrying and the remote topic stayed stuck at its provisional
   * name forever.
   */
  wouldRename(sessionId: string, name: string): boolean {
    const record = this.topics.get(sessionId);
    return !!record && record.name !== name;
  }

  /**
   * Record the topic's applied title. Returns `true` when it changed (so the
   * caller should `editForumTopic`), `false` when already current or unknown.
   */
  applyName(sessionId: string, name: string): boolean {
    const record = this.topics.get(sessionId);
    if (!record || record.name === name) return false;
    record.name = name;
    return true;
  }

  /** Remove a session topic record after Telegram deletes the topic. */
  delete(sessionId: string): boolean {
    const record = this.topics.get(sessionId);
    if (!record) return false;
    this.topics.delete(sessionId);
    this.byTopic.delete(record.topicId);
    return true;
  }

  /** Serialize for atomic persistence beside the daemon state. */
  serialize(): TopicRegistryState {
    return { topics: Object.fromEntries(this.topics) };
  }
}
