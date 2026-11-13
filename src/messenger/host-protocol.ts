import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { DiscordActionDecision, DiscordActionRequest, DiscordHostAction, DiscordHostBootstrap, DiscordHostTurn } from "./types";
import { isRecord } from "./types";

function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

// JSON IPC cannot carry cycles/nonfinite values; bound nesting before canonical digest work.
function canonical(value: unknown, seen = new Set<object>(), depth = 0): string {
	if (depth > 64) throw new TypeError("Host action nesting is too deep");
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (typeof value !== "object" || value === null || seen.has(value)) throw new TypeError("Host action must contain only finite JSON values");
	seen.add(value);
	try {
		if (Array.isArray(value)) return `[${Array.from(value, entry => canonical(entry, seen, depth + 1)).join(",")}]`;
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("Host action must contain only JSON records");
		return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], seen, depth + 1)}`).join(",")}}`;
	} finally { seen.delete(value); }
}

/** Bind a one-use decision to the exact effective action, independently of object key order. */
export function discordHostActionDigest(action: DiscordHostAction): string {
	return createHash("sha256").update(canonical(action)).digest("hex");
}

export function isDiscordHostAction(value: unknown): value is DiscordHostAction {
	if (!isRecord(value)) return false;
	if (value.kind === "tool") {
		if (!keys(value, ["kind", "tool", "cwd", "args"]) || !nonempty(value.tool) || !nonempty(value.cwd) || !isAbsolute(value.cwd) || !isRecord(value.args)) return false;
		try { canonical(value); return true; } catch { return false; }
	}
	// Discord delivery already permits at most ten files (the artifacts.ts admission limit).
	return value.kind === "artifact_upload" && keys(value, ["kind", "channelId", "files"]) && nonempty(value.channelId) && Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 10 && Array.from(value.files).every(file => isRecord(file) && keys(file, ["name", "size", "sha256"]) && nonempty(file.name) && Number.isSafeInteger(file.size) && (file.size as number) >= 0 && typeof file.sha256 === "string" && /^[a-f0-9]{64}$/.test(file.sha256));
}

export function isDiscordActionRequest(value: unknown): value is DiscordActionRequest {
	return isRecord(value) && keys(value, ["type", "nonce", "epoch", "runId", "requestId", "action"]) && value.type === "action_request" && nonempty(value.nonce) && nonempty(value.epoch) && nonempty(value.runId) && nonempty(value.requestId) && isDiscordHostAction(value.action);
}

export function isDiscordActionDecision(value: unknown): value is DiscordActionDecision {
	return isRecord(value) && keys(value, ["type", "nonce", "epoch", "runId", "requestId", "actionDigest", "decision"], ["reason"]) && value.type === "action_decision" && nonempty(value.nonce) && nonempty(value.epoch) && nonempty(value.runId) && nonempty(value.requestId) && typeof value.actionDigest === "string" && /^[a-f0-9]{64}$/.test(value.actionDigest) && (value.decision === "allow" || value.decision === "deny") && (value.reason === undefined || typeof value.reason === "string");
}

export function isDiscordHostTurn(value: unknown): value is DiscordHostTurn {
	return isRecord(value) && keys(value, ["type", "runId", "text"]) && value.type === "host_turn" && nonempty(value.runId) && typeof value.text === "string";
}

export function isDiscordHostBootstrap(value: unknown): value is DiscordHostBootstrap {
	if (!isRecord(value) || !keys(value, ["version", "mode", "scope", "nonce", "cwd", "workspaceRoot", "sourceRoot", "sessionDir", "cleanupReceipt"], ["bootStartedAt"]) || value.version !== 1 || value.mode !== "host" || !nonempty(value.nonce) || !isRecord(value.scope)) return false;
	const scope = value.scope;
	return keys(scope, ["sessionId", "generation", "epoch"]) && nonempty(scope.sessionId) && Number.isSafeInteger(scope.generation) && (scope.generation as number) >= 0 && nonempty(scope.epoch) && [value.cwd, value.workspaceRoot, value.sourceRoot, value.sessionDir, value.cleanupReceipt].every(entry => nonempty(entry) && isAbsolute(entry)) && (value.bootStartedAt === undefined || typeof value.bootStartedAt === "number" && Number.isFinite(value.bootStartedAt) && value.bootStartedAt > 0);
}
