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
  /** Bot account identity used to scope persisted topic ownership. */
  botId?: string;
  /** Paired Telegram chat identity used to scope persisted topic ownership. */
  chatId?: string;
}

export function emptyTopicRegistryState(): TopicRegistryState {
  return { topics: {} };
}

/** Runtime guards for persisted topic state and API-created records. */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidTopicId(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value) && value > 0;
}

function isTopicRecord(value: unknown): value is TopicRecord {
  if (!isRecordObject(value) || !isValidTopicId(value.topicId) ||
      typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return false;
  return value.name === undefined || typeof value.name === "string";
}

function validateTopicRecord(sessionId: string, value: unknown): TopicRecord {
  if (!isRecordObject(value)) throw new Error(`Invalid topic registry record for session '${sessionId}'`);
  if (!isValidTopicId(value.topicId)) throw new Error(`Invalid topic ID for session '${sessionId}'`);
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) {
    throw new Error(`Invalid creation timestamp for session '${sessionId}'`);
  }
  if (value.name !== undefined && typeof value.name !== "string") {
    throw new Error(`Invalid topic name for session '${sessionId}'`);
  }
  if (!isTopicRecord(value)) throw new Error(`Invalid topic registry record for session '${sessionId}'`);
  return value;
}

interface TopicRegistryIdentity {
  botId: string;
  chatId: string;
}

function parseTopicRegistryIdentity(state: Record<string, unknown>): TopicRegistryIdentity | undefined {
  const hasBotId = Object.hasOwn(state, "botId");
  const hasChatId = Object.hasOwn(state, "chatId");
  if (!hasBotId && !hasChatId) return undefined;
  if (!hasBotId || !hasChatId || typeof state.botId !== "string" || !state.botId ||
      typeof state.chatId !== "string" || !state.chatId) {
    throw new Error("Invalid topic registry identity: botId and chatId must be non-empty strings");
  }
  return { botId: state.botId, chatId: state.chatId };
}

function sameTopicRegistryIdentity(a: TopicRegistryIdentity, b: TopicRegistryIdentity | undefined): boolean {
  return b !== undefined && a.botId === b.botId && a.chatId === b.chatId;
}

/**
 * In-memory registry over a serializable state. Topic creation is injected via
 * `getOrCreateTopic`'s `create` callback (the daemon supplies a real
 * `createForumTopic` call); reuse-on-resume is automatic when a record exists.
 */
export class TopicRegistry {
  private topics: Map<string, TopicRecord>;
  /** Maps topicId -> sessionId for fast inbound routing. */
  private byTopic = new Map<number, string>();
  /** In-flight create promises, keyed by session, to dedupe concurrent creates. */
  private readonly inflight = new Map<string, Promise<TopicRecord>>();
  /** Invalidates in-flight creates when a validated state replaces the indexes. */
  private revision = 0;
  /** Identity of the persisted Telegram destination currently loaded. */
  private identity: TopicRegistryIdentity | undefined;

  constructor(state: TopicRegistryState = emptyTopicRegistryState()) {
    this.topics = new Map();
    this.load(state);
  }
  /** Merge a serialized state, replacing indexes atomically within its identity. */
  load(state: TopicRegistryState): void {
    if (!isRecordObject(state) || !isRecordObject(state.topics)) {
      throw new Error("Invalid topic registry state: topics must be an object");
    }

    const incomingIdentity = parseTopicRegistryIdentity(state);
    const resetForIdentity = this.identity !== undefined
      ? !sameTopicRegistryIdentity(this.identity, incomingIdentity)
      : incomingIdentity !== undefined && this.topics.size > 0;
    const nextTopics = resetForIdentity ? new Map<string, TopicRecord>() : new Map(this.topics);
    for (const [sessionId, rawRecord] of Object.entries(state.topics)) {
      nextTopics.set(sessionId, validateTopicRecord(sessionId, rawRecord));
    }

    const nextByTopic = new Map<number, string>();
    for (const [sessionId, rawRecord] of nextTopics) {
      const record = validateTopicRecord(sessionId, rawRecord);
      const owner = nextByTopic.get(record.topicId);
      if (owner !== undefined) {
        throw new Error(`Duplicate topic ID ${record.topicId} for sessions '${owner}' and '${sessionId}'`);
      }
      nextByTopic.set(record.topicId, sessionId);
    }

    this.topics = nextTopics;
    this.byTopic = nextByTopic;
    this.identity = incomingIdentity ?? (resetForIdentity ? undefined : this.identity);
    this.revision++;
    this.inflight.clear();
  }

  /** Resolve the owning session for a topic id (for fail-closed inbound routing). */
  sessionForTopic(topicId: number): string | undefined {
    if (!isValidTopicId(topicId)) return undefined;
    const sessionId = this.byTopic.get(topicId);
    if (sessionId === undefined) return undefined;
    const record = this.topics.get(sessionId);
    if (!record || !isTopicRecord(record) || record.topicId !== topicId) {
      this.byTopic.delete(topicId);
      return undefined;
    }
    return sessionId;
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
    if (existing) {
      if (!isTopicRecord(existing)) throw new Error(`Invalid topic registry record for session '${sessionId}'`);
      if (this.byTopic.get(existing.topicId) !== sessionId) {
        throw new Error(`Topic registry mapping for session '${sessionId}' is invalid`);
      }
      return existing;
    }
    // Concurrency guard: many session frames (identity/idle/turn/ask) can race
    // to first-use the same session. Without this, each call passes the
    // `existing` check before `create()` resolves and creates a DUPLICATE
    // forum topic. Share a single in-flight create per session id.
    const pending = this.inflight.get(sessionId);
    if (pending) return pending;
    const revision = this.revision;
    const promise = (async () => {
      const topicId = await create();
      if (revision !== this.revision) throw new Error("Topic registry changed while creating a topic");
      if (!isValidTopicId(topicId)) throw new Error("Invalid topic ID returned by topic creation");
      const owner = this.byTopic.get(topicId);
      if (owner !== undefined && owner !== sessionId) {
        throw new Error(`Duplicate topic ID ${topicId} already belongs to session '${owner}'`);
      }
      const record = validateTopicRecord(sessionId, { topicId, name, createdAt: now() });
      this.topics.set(sessionId, record);
      this.byTopic.set(topicId, sessionId);
      return record;
    })();
    this.inflight.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      if (this.inflight.get(sessionId) === promise) this.inflight.delete(sessionId);
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
    for (const [topicId, owner] of this.byTopic) {
      if (owner === sessionId) this.byTopic.delete(topicId);
    }
    return true;
  }

  /** Serialize for atomic persistence beside the daemon state. */
  serialize(): TopicRegistryState {
    const topics = Object.fromEntries(this.topics);
    return this.identity ? { topics, ...this.identity } : { topics };
  }
}
