import type { SandboxConfig } from "../agent/sandbox/types";

export type MessengerPlatform = "discord" | "telegram" | "slack";

export interface MessengerMessage {
	platform: MessengerPlatform;
	accountId: string;
	channelId: string;
	senderId: string;
	messageId: string;
	text: string;
	/** Discord guild snowflake. Absent for DMs. */
	guildId?: string;
	threadId?: string;
	/** Platform-level conversation identifier when the conversation is not a Discord thread. */
	conversationId?: string;
	parentChannelId?: string;
	direct: boolean;
	mentioned: boolean;
	attachments?: { url: string; filename: string; size: number }[];
}

/** Report a short, human-readable description of the work in progress. */
export type MessengerActivityReporter = (text: string) => void;

export interface MessengerAdapter {
	platform: MessengerPlatform;
	start(onMessage: (message: MessengerMessage) => Promise<void>, signal: AbortSignal, onThreadLifecycle?: (event: DiscordThreadLifecycle) => Promise<void>): Promise<void>;
	send(message: MessengerMessage, text: string, signal?: AbortSignal): Promise<void>;
	prepare?(message: MessengerMessage, signal?: AbortSignal): Promise<MessengerMessage>;
	status?(
		message: MessengerMessage,
		status: "processing" | "success" | "failure",
		signal?: AbortSignal,
	): Promise<void>;
	/** Update the request's progress; undefined finishes it with the supplied outcome. */
	activity?(message: MessengerMessage, text: string | undefined, signal?: AbortSignal, outcome?: "success" | "failure" | "cancelled"): Promise<void>;
}

export interface MessengerPlatformConfig {
	tokenEnv: string;
	appTokenEnv?: string;
	allowedUserIds: string[];
	allowedChannelIds?: string[];
	/** Dedicated operator-approved directory for Discord output files. */
	artifactDir?: string;
	/** Optional platform-specific model and persistent-usage-limit fallback. */
	model?: string;
	usageFallbackModel?: string;
	/** Explicit Discord-only CLI trust mode; other platforms reject this setting. */
	workerMode?: DiscordWorkerMode;
}

export interface MessengerConfig {
	/** Directory holding the loaded messenger.json, token file and run script; set by `loadMessengerConfig`. */
	profileDir?: string;
	/** Internal identity derived from the loaded configuration path, never accepted from JSON. */
	profileKey?: string;
	cwd: string;
	sessionDir: string;
	toolNames: string[];
	sandbox?: SandboxConfig;
	platforms: Partial<Record<MessengerPlatform, MessengerPlatformConfig>>;
}

export interface MessengerTransportDeps {
	fetch?: typeof fetch;
	WebSocket?: typeof WebSocket;
}

export type MessengerReply = (
	message: MessengerMessage,
	signal: AbortSignal,
	onActivity?: MessengerActivityReporter,
) => Promise<string>;

/** A partially initialized runtime must not be retried inside a live gateway. */
export class MessengerFatalError extends Error {
	constructor() {
		super("Messenger session initialization failed; restart required");
		this.name = "MessengerFatalError";
	}
}

/** The agent turn ended without verified completion; `reply` is the UNVERIFIED-marked answer for the user. */
export class MessengerUnverifiedReplyError extends Error {
	constructor(readonly reply: string) {
		super("Messenger agent turn ended without verified completion");
		this.name = "MessengerUnverifiedReplyError";
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isEnoent(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

export type DiscordWorkerMode = "sandbox" | "host";

export interface DiscordRunRef {
	conversationKey: string;
	sessionId: string;
	generation: number;
	runId: string;
}

export interface DiscordWorkerScope {
	sessionId: string;
	generation: number;
	epoch: string;
}

export interface DiscordWorkerOwner extends DiscordWorkerScope {
	pid: number;
	startedAt: number;
	bootStartedAt?: number;
	cleanupReceipt: string;
}

/** Private parent-created bootstrap; it is not a general sandbox exemption. */
export interface DiscordHostBootstrap {
	version: 1;
	mode: "host";
	scope: DiscordWorkerScope;
	nonce: string;
	cwd: string;
	workspaceRoot: string;
	sourceRoot: string;
	sessionDir: string;
	cleanupReceipt: string;
	bootStartedAt?: number;
}

/** Keep the run identifier ordered with its literal prompt on the stdin channel. */
export interface DiscordHostTurn {
	type: "host_turn";
	runId: string;
	text: string;
}

export type DiscordHostAction = {
	kind: "tool";
	tool: string;
	cwd: string;
	args: Readonly<Record<string, unknown>>;
} | {
	kind: "artifact_upload";
	channelId: string;
	files: readonly { name: string; size: number; sha256: string }[];
};

/** Requests carry no actor or conversation claims; the parent binds those. */
export interface DiscordActionRequest {
	type: "action_request";
	nonce: string;
	epoch: string;
	runId: string;
	requestId: string;
	action: DiscordHostAction;
}

export interface DiscordActionDecision {
	type: "action_decision";
	nonce: string;
	epoch: string;
	runId: string;
	requestId: string;
	actionDigest: string;
	decision: "allow" | "deny";
	reason?: string;
}

/** A trusted Discord adapter event, not a synthetic authenticated message. */
export interface DiscordThreadLifecycle {
	kind: "archive" | "unarchive" | "delete";
	accountId: string;
	guildId?: string;
	parentChannelId: string;
	threadId: string;
}

export type MessengerRequestOutcome = "completed" | "failed" | "cancelled";
