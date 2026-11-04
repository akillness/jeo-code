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
	start(onMessage: (message: MessengerMessage) => Promise<void>, signal: AbortSignal): Promise<void>;
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
}

export interface MessengerConfig {
	/** Directory holding the loaded messenger.json, token file and run script; set by `loadMessengerConfig`. */
	profileDir?: string;
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

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isEnoent(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}
