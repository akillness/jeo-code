import { describe, expect, test } from "bun:test";
import {
	messengerConversationKey,
	messengerSessionIdentity,
	messengerSessionRoute,
} from "../src/messenger/gateway";
import type { MessengerMessage } from "../src/messenger/types";

function discord(overrides: Partial<MessengerMessage> = {}): MessengerMessage {
	return {
		platform: "discord",
		accountId: "bot",
		guildId: "guild",
		channelId: "channel",
		senderId: "user",
		messageId: "message",
		text: "hello",
		direct: false,
		mentioned: true,
		...overrides,
	};
}

describe("Discord canonical session identity", () => {
	test("documents the exact ordered tuple and tagged absence serialization", () => {
		expect(messengerSessionIdentity(discord())).toEqual([
			"messenger-session-v1",
			"discord",
			"bot",
			["present", "guild"],
			"channel",
			["absent"],
			["absent"],
			"user",
		]);
		expect(messengerSessionIdentity(discord({ guildId: undefined }))[3]).toEqual(["absent"]);
		expect(messengerConversationKey(discord({ threadId: "literal,[\"absent\"]" }))).not.toBe(
			messengerConversationKey(discord()),
		);
	});

	test("reuses only the complete unchanged tuple and isolates every included component", () => {
		const base = discord();
		const route = messengerSessionRoute("/repo", base);
		expect(messengerSessionRoute("/repo", { ...base, messageId: "later", text: "next" })).toBe(route);
		for (const changed of [
			{ ...discord(), platform: "telegram" as const },
			discord({ accountId: "other-bot" }),
			discord({ guildId: "other-guild" }),
			discord({ channelId: "other-channel" }),
			discord({ senderId: "other-user" }),
		]) {
			expect(messengerSessionRoute("/repo", changed)).not.toBe(route);
		}
	});

	test("isolates absent/present transitions in both directions for every optional component", () => {
		for (const [absent, present] of [
			[discord({ guildId: undefined }), discord({ guildId: "guild" })],
			[discord({ threadId: undefined }), discord({ threadId: "thread" })],
			[discord({ conversationId: undefined }), discord({ conversationId: "conversation" })],
		] as const) {
			const absentRoute = messengerSessionRoute("/repo", absent);
			const presentRoute = messengerSessionRoute("/repo", present);
			expect(absentRoute).not.toBe(presentRoute);
			expect(messengerSessionRoute("/repo", { ...present, ...absent })).toBe(absentRoute);
		}
	});

	test("isolates thread and conversation alternatives and rejects the ambiguous both-present case", () => {
		const plain = discord();
		const thread = discord({ channelId: "thread", parentChannelId: "channel", threadId: "thread" });
		const otherThread = { ...thread, channelId: "other-thread", threadId: "other-thread" };
		const otherParent = { ...thread, parentChannelId: "other-channel" };
		const conversation = discord({ conversationId: "conversation" });
		const otherConversation = discord({ conversationId: "other-conversation" });
		for (const [left, right] of [
			[plain, thread],
			[thread, otherThread],
			[thread, otherParent],
			[plain, conversation],
			[conversation, otherConversation],
			[thread, conversation],
		] as const) {
			expect(messengerSessionRoute("/repo", left)).not.toBe(messengerSessionRoute("/repo", right));
		}
		expect(() => messengerSessionIdentity(discord({ threadId: "thread", conversationId: "conversation" }))).toThrow(
			"mutually exclusive",
		);
	});

	test("rejects empty or boundary-whitespace identifiers instead of normalizing them into collisions", () => {
		for (const invalid of [
			discord({ guildId: "" }),
			discord({ threadId: " thread" }),
			discord({ conversationId: "conversation " }),
			discord({ channelId: "" }),
		]) {
			expect(() => messengerSessionIdentity(invalid)).toThrow("identifier is invalid");
		}
	});
});
