import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { acquireProcessLock, hostBootTimeMs, inspectLockOwner, isProcessAbsent } from "../agent/notify/daemon-control";
import { messengerConversationKey } from "./gateway";
import { isEnoent, isRecord, type DiscordRunRef, type DiscordThreadLifecycle, type DiscordWorkerOwner, type DiscordWorkerScope, type MessengerConfig, type MessengerMessage } from "./types";

export interface DiscordThreadWorkspace {
	id: string;
	sourceCwd: string;
	sourceRoot: string;
	commonDir: string;
	baseCommit: string;
	branch: string;
	worktreePath: string;
	state: "creating" | "ready" | "blocked";
}

export interface DiscordThreadRun {
	runId: string;
	messageKey: string;
	generation: number;
	state: "running" | "completed" | "failed" | "cancelled" | "interrupted";
	startedAt: number;
	settledAt?: number;
}

export interface DiscordThreadRecord {
	version: 1;
	profileKey: string;
	conversationKey: string;
	sessionId: string;
	generation: number;
	state: "creating" | "ready" | "archived" | "deleted" | "blocked";
	cwd: string;
	activeWorkspace?: string;
	workspaces: DiscordThreadWorkspace[];
	runs: DiscordThreadRun[];
	worker?: DiscordWorkerOwner;
	/** A blocked record is retained for explicit operator recovery, never automatically discarded. */
	blockedReason?: string;
}

export interface DiscordThreadAdmission {
	thread: DiscordThreadRecord;
	run: DiscordRunRef;
}

export type DiscordThreadRetirementReason = "cancel" | "cwd" | "archive" | "delete";
export type DiscordThreadRetire = (thread: DiscordThreadRecord, reason: DiscordThreadRetirementReason) => Promise<void>;

export interface DiscordThreadRegistry {
	get(conversationKey: string): Promise<DiscordThreadRecord | undefined>;
	begin(message: MessengerMessage, signal: AbortSignal): Promise<DiscordThreadAdmission | undefined>;
	settle(run: DiscordRunRef, state: Exclude<DiscordThreadRun["state"], "running">): Promise<void>;
	changeCwd(conversationKey: string, requestedPath: string, signal: AbortSignal): Promise<DiscordThreadRecord>;
	cancel(conversationKey: string): Promise<void>;
	transition(event: DiscordThreadLifecycle): Promise<void>;
	recordWorker(scope: DiscordWorkerScope, owner: DiscordWorkerOwner): Promise<void>;
	close(): Promise<void>;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const absolute = (value: unknown): value is string => typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const contained = (root: string, target: string) => { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };
const aborted = (signal: AbortSignal) => { if (signal.aborted) throw new Error("Discord request aborted"); };

function sessionId(profile: string, key: string): string {
	const hex = digest(JSON.stringify([profile, key]));
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function privateDirectory(directory: string): Promise<void> {
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const stat = await fs.lstat(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error("Discord host storage must be a private owned directory");
}

async function readPrivateJson(filename: string): Promise<unknown> {
	const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error("Discord host record is not private or owned");
		return JSON.parse(await file.readFile("utf8"));
	} finally { await file.close(); }
}

async function writePrivateJson(filename: string, value: unknown): Promise<void> {
	const temporary = `${filename}.${randomUUID()}.tmp`;
	try {
		const file = await fs.open(temporary, "wx", 0o600);
		try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
		finally { await file.close(); }
		await fs.rename(temporary, filename);
		const directory = await fs.open(path.dirname(filename), "r");
		try { await directory.sync(); } finally { await directory.close(); }
	} finally { await fs.unlink(temporary).catch(error => { if (!isEnoent(error)) throw error; }); }
}

async function git(cwd: string, args: string[]): Promise<string> {
	// Do not inherit another checkout's GIT_DIR/INDEX_FILE, and never run checkout hooks while provisioning.
	const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("GIT_"))) as Record<string, string>;
	const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [output, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (code !== 0) throw new Error(`Discord host Git operation failed (exit ${code}); verify the selected Git project and retained workspace`);
	return output.trim();
}

interface GitSource { sourceCwd: string; sourceRoot: string; commonDir: string; baseCommit: string }

async function gitSource(requested: string): Promise<GitSource> {
	let sourceCwd: string;
	try { sourceCwd = await fs.realpath(requested); }
	catch { throw new Error("Select an existing Git project with /cwd before starting Discord host work"); }
	try {
		if (!(await fs.stat(sourceCwd)).isDirectory()) throw new Error("Not a directory");
		if (await git(sourceCwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") throw new Error("Not a worktree");
		const sourceRoot = await fs.realpath(await git(sourceCwd, ["rev-parse", "--show-toplevel"]));
		const commonDir = await fs.realpath(await git(sourceCwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
		const baseCommit = await git(sourceCwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
		if (!/^[a-f0-9]{40,64}$/.test(baseCommit) || !contained(sourceRoot, sourceCwd)) throw new Error("Invalid Git project mapping");
		return { sourceCwd, sourceRoot, commonDir, baseCommit };
	} catch { throw new Error("Discord host work requires a Git project with a committed HEAD; select one with /cwd"); }
}

function validOwner(value: unknown): value is DiscordWorkerOwner {
	return isRecord(value) && typeof value.sessionId === "string" && positive(value.generation) && typeof value.epoch === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(value.epoch) && positive(value.pid) && typeof value.startedAt === "number" && Number.isFinite(value.startedAt) && value.startedAt > 0 && absolute(value.cleanupReceipt) && (value.bootStartedAt === undefined || (typeof value.bootStartedAt === "number" && Number.isFinite(value.bootStartedAt) && value.bootStartedAt > 0));
}

/** Owns only profile metadata and linked worktrees; it never signals processes or removes user work. */
export function createDiscordThreadRegistry(config: MessengerConfig, retire: DiscordThreadRetire): DiscordThreadRegistry {
	let closed = false;
	let closing: Promise<void> | undefined;
	let initialization: Promise<void> | undefined;
	let release: (() => Promise<void>) | undefined;
	let sessionRoot = "";
	let profileKey = "";
	let recordsRoot = "";
	let worktreesRoot = "";
	const records = new Map<string, DiscordThreadRecord>();
	const lanes = new Map<string, Promise<unknown>>();
	const activeRuns = new Set<string>();
	const liveEpochs = new Set<string>();
	const publications = new Map<string, Set<{ generation: number; cancel(): void }>>();

	function initialize(): Promise<void> {
		return initialization ??= (async () => {
			await fs.mkdir(config.sessionDir, { recursive: true, mode: 0o700 });
			sessionRoot = await fs.realpath(config.sessionDir);
			await privateDirectory(sessionRoot);
			profileKey = config.profileKey ?? digest(sessionRoot);
			if (!/^[a-f0-9]{64}$/.test(profileKey)) throw new Error("Invalid internal Discord profile identity");
			const hostRoot = path.join(sessionRoot, "discord-host");
			await privateDirectory(hostRoot);
			recordsRoot = path.join(hostRoot, profileKey);
			await privateDirectory(recordsRoot);
			worktreesRoot = path.join(path.dirname(sessionRoot), `.discord-worktrees-${profileKey}`);
			const lock = await acquireProcessLock(path.join(recordsRoot, "owner.lock"), { strict: true });
			if (!lock) throw new Error("Discord host profile is already owned or has an unverified process lock; verify its previous gateway has stopped before recovery");
			release = lock.release;
		})();
	}

	function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
		if (closed) return Promise.reject(new Error("Discord host registry is closed"));
		const previous = lanes.get(key) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(async () => { await initialize(); return operation(); });
		lanes.set(key, next);
		void next.finally(() => { if (lanes.get(key) === next) lanes.delete(key); }).catch(() => {});
		return next;
	}

	const recordPath = (key: string) => path.join(recordsRoot, `${digest(key)}.json`);
	const workspacePath = (id: string, workspace: string) => path.join(worktreesRoot, id, workspace);
	const workspaceBranch = (id: string, workspace: string) => `jeo/discord/${profileKey}/${id}/${workspace}`;
	const receiptPath = (owner: DiscordWorkerOwner) => path.join(sessionRoot, "host-runtime", owner.sessionId, `${owner.epoch}.json`);
	const copy = (thread: DiscordThreadRecord): DiscordThreadRecord => structuredClone(thread);

	function validate(raw: unknown, key: string): DiscordThreadRecord {
		if (!isRecord(raw) || raw.version !== 1 || raw.profileKey !== profileKey || raw.conversationKey !== key || raw.sessionId !== sessionId(profileKey, key) || !positive(raw.generation) || !["creating", "ready", "archived", "deleted", "blocked"].includes(String(raw.state)) || !absolute(raw.cwd) || !Array.isArray(raw.workspaces) || !Array.isArray(raw.runs) || (raw.blockedReason !== undefined && typeof raw.blockedReason !== "string")) throw new Error("Invalid Discord thread record; explicit recovery is required");
		const workspaceIds = new Set<string>();
		for (const workspace of raw.workspaces) {
			if (!isRecord(workspace) || !absolute(workspace.sourceCwd) || !absolute(workspace.sourceRoot) || !contained(workspace.sourceRoot, workspace.sourceCwd) || !absolute(workspace.commonDir) || typeof workspace.baseCommit !== "string" || !/^[a-f0-9]{40,64}$/.test(workspace.baseCommit) || workspace.id !== digest(JSON.stringify([workspace.sourceRoot, workspace.commonDir])) || workspace.worktreePath !== workspacePath(String(raw.sessionId), String(workspace.id)) || workspace.branch !== workspaceBranch(String(raw.sessionId), String(workspace.id)) || !["creating", "ready", "blocked"].includes(String(workspace.state)) || workspaceIds.has(String(workspace.id))) throw new Error("Invalid Discord workspace ownership record");
			workspaceIds.add(String(workspace.id));
		}
		if (raw.activeWorkspace !== undefined && (typeof raw.activeWorkspace !== "string" || !workspaceIds.has(raw.activeWorkspace))) throw new Error("Invalid Discord active workspace");
		const runIds = new Set<string>();
		const messages = new Set<string>();
		for (const run of raw.runs) {
			if (!isRecord(run) || typeof run.runId !== "string" || !/^[a-f0-9-]{36}$/.test(run.runId) || typeof run.messageKey !== "string" || !positive(run.generation) || run.generation > raw.generation || !["running", "completed", "failed", "cancelled", "interrupted"].includes(String(run.state)) || !positive(run.startedAt) || (run.settledAt !== undefined && !positive(run.settledAt)) || runIds.has(run.runId) || messages.has(run.messageKey)) throw new Error("Invalid Discord admission ledger");
			runIds.add(run.runId); messages.add(run.messageKey);
		}
		if (raw.worker !== undefined && (!validOwner(raw.worker) || raw.worker.sessionId !== raw.sessionId || raw.worker.generation > raw.generation || raw.worker.cleanupReceipt !== receiptPath(raw.worker))) throw new Error("Invalid Discord worker ownership record");
		const thread = raw as unknown as DiscordThreadRecord;
		if (thread.activeWorkspace && !contained(thread.workspaces.find(workspace => workspace.id === thread.activeWorkspace)!.worktreePath, thread.cwd)) throw new Error("Discord cwd escaped its owned worktree");
		return thread;
	}

	async function load(key: string): Promise<DiscordThreadRecord | undefined> {
		const cached = records.get(key);
		if (cached) return cached;
		let raw: unknown;
		try { raw = await readPrivateJson(recordPath(key)); }
		catch (error) { if (isEnoent(error)) return undefined; throw error; }
		const thread = validate(raw, key);
		records.set(key, thread);
		return thread;
	}

	async function save(thread: DiscordThreadRecord): Promise<void> {
		validate(thread, thread.conversationKey);
		await writePrivateJson(recordPath(thread.conversationKey), thread);
		records.set(thread.conversationKey, thread);
	}

	async function block(thread: DiscordThreadRecord, reason: string): Promise<never> {
		if (thread.state !== "deleted") thread.state = "blocked";
		thread.blockedReason = reason;
		await save(thread);
		throw new Error(reason);
	}

	async function reconcileWorker(thread: DiscordThreadRecord): Promise<void> {
		const owner = thread.worker;
		if (!owner) return;
		const boot = await hostBootTimeMs();
		const rebooted = boot !== undefined && owner.bootStartedAt !== undefined && boot !== owner.bootStartedAt;
		if (!rebooted) {
			let receipt: unknown;
			try { receipt = await readPrivateJson(owner.cleanupReceipt); }
			catch { return block(thread, "Previous Discord worker cleanup is unconfirmed; verify its owned work has stopped before explicit recovery"); }
			if (!isRecord(receipt) || receipt.version !== 1 || receipt.sessionId !== owner.sessionId || receipt.generation !== owner.generation || receipt.epoch !== owner.epoch || receipt.pid !== owner.pid || receipt.gone !== true) return block(thread, "Previous Discord worker cleanup receipt does not match its owner");
			const status = await inspectLockOwner(owner);
			if (!status.verified || status.alive || !isProcessAbsent(owner.pid)) return block(thread, "Previous Discord worker process has not verifiably exited");
		}
		liveEpochs.delete(owner.epoch);
		delete thread.worker;
		await save(thread);
	}

	async function verifyWorkspace(workspace: DiscordThreadWorkspace): Promise<void> {
		if (workspace.state !== "ready") throw new Error("Discord worktree creation is incomplete; explicit recovery is required");
		if (await fs.realpath(workspace.worktreePath) !== workspace.worktreePath) throw new Error("Discord worktree path ownership changed");
		const [root, common, branch, gitDir] = await Promise.all([
			git(workspace.worktreePath, ["rev-parse", "--show-toplevel"]),
			git(workspace.worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
			git(workspace.worktreePath, ["symbolic-ref", "--quiet", "HEAD"]),
			git(workspace.worktreePath, ["rev-parse", "--absolute-git-dir"]),
		]);
		if (await fs.realpath(root) !== workspace.worktreePath || await fs.realpath(common) !== workspace.commonDir || branch !== `refs/heads/${workspace.branch}` || !contained(path.join(workspace.commonDir, "worktrees"), await fs.realpath(gitDir))) throw new Error("Discord linked worktree or branch ownership changed");
		const backlink = (await fs.readFile(path.join(gitDir, "gitdir"), "utf8")).trim();
		if (path.resolve(gitDir, backlink) !== path.join(workspace.worktreePath, ".git")) throw new Error("Discord worktree registration does not belong to this thread");
		await git(workspace.worktreePath, ["cat-file", "-e", `${workspace.baseCommit}^{commit}`]);
	}

	async function selectWorkspace(thread: DiscordThreadRecord, requested: string, signal: AbortSignal): Promise<void> {
		aborted(signal);
		const source = await gitSource(requested);
		aborted(signal);
		// Selecting a retained worktree's subdirectory reuses its edits instead of forking it again.
		let workspace = thread.workspaces.find(entry => entry.worktreePath === source.sourceRoot);
		const relative = path.relative(source.sourceRoot, source.sourceCwd);
		workspace ??= thread.workspaces.find(entry => entry.sourceRoot === source.sourceRoot && entry.commonDir === source.commonDir);
		if (!workspace) {
			if (contained(source.sourceRoot, worktreesRoot) || contained(worktreesRoot, source.sourceRoot) || contained(sessionRoot, worktreesRoot) || contained(worktreesRoot, sessionRoot)) throw new Error("Discord managed worktree storage must be disjoint from the source checkout and session history");
			const id = digest(JSON.stringify([source.sourceRoot, source.commonDir]));
			workspace = { ...source, id, worktreePath: workspacePath(thread.sessionId, id), branch: workspaceBranch(thread.sessionId, id), state: "creating" };
			thread.workspaces.push(workspace);
			await save(thread); // Keep the owned partial record if Git is interrupted or rejects creation.
			try {
				await privateDirectory(worktreesRoot);
				await privateDirectory(path.dirname(workspace.worktreePath));
				try { await fs.lstat(workspace.worktreePath); throw new Error("Refusing an existing unowned Discord worktree path"); }
				catch (error) { if (!isEnoent(error)) throw error; }
				await git(source.sourceRoot, ["worktree", "add", "--no-track", "-b", workspace.branch, workspace.worktreePath, workspace.baseCommit]);
				workspace.state = "ready";
				await verifyWorkspace(workspace);
			} catch (error) {
				workspace.state = "blocked";
				return block(thread, error instanceof Error ? error.message : "Discord worktree creation failed");
			}
		} else {
			await verifyWorkspace(workspace);
		}
		const cwd = await fs.realpath(path.join(workspace.worktreePath, relative));
		if (!contained(workspace.worktreePath, cwd)) throw new Error("Selected cwd escapes the owned Discord worktree");
		thread.activeWorkspace = workspace.id;
		thread.cwd = cwd;
		thread.state = "ready";
		delete thread.blockedReason;
		await save(thread);
		aborted(signal);
	}

	async function fence(thread: DiscordThreadRecord, reason: DiscordThreadRetirementReason): Promise<void> {
		thread.generation++;
		// A startup callback may be queued on this lane while pool.stop waits for its publication.
		for (const publication of publications.get(thread.sessionId) ?? []) if (publication.generation < thread.generation) publication.cancel();
		for (const run of thread.runs) if (run.state === "running") { run.state = "cancelled"; run.settledAt = Date.now(); activeRuns.delete(run.runId); }
		if (reason === "archive" || reason === "delete") thread.state = reason === "archive" ? "archived" : "deleted";
		await save(thread);
		try {
			await retire(copy(thread), reason);
			await reconcileWorker(thread);
		} catch (error) {
			if (thread.state !== "deleted") thread.state = "blocked";
			thread.blockedReason = error instanceof Error ? error.message : "Discord worker retirement failed";
			await save(thread);
			throw error;
		}
	}

	return {
		get: key => serial(key, async () => { const thread = await load(key); return thread && copy(thread); }),
		begin: (message, signal) => {
			const key = messengerConversationKey(message);
			return serial(key, async () => {
				aborted(signal);
				if (message.platform !== "discord" || config.platforms.discord?.workerMode !== "host") throw new Error("Discord host mode is not enabled");
				let thread = await load(key);
				const messageKey = JSON.stringify([message.platform, message.accountId, message.messageId]);
				if (thread?.runs.some(run => run.messageKey === messageKey)) return undefined;
				if (thread?.state === "archived" || thread?.state === "deleted") throw new Error(`Discord thread is ${thread.state}`);
				if (thread?.state === "blocked") throw new Error(thread.blockedReason ?? "Discord thread is blocked pending explicit recovery");
				if (!thread) {
					thread = { version: 1, profileKey, conversationKey: key, sessionId: sessionId(profileKey, key), generation: 1, state: "creating", cwd: path.resolve(config.cwd), workspaces: [], runs: [] };
					await save(thread);
				}
				if (thread.worker && !liveEpochs.has(thread.worker.epoch)) await reconcileWorker(thread);
				for (const run of thread.runs) if (run.state === "running" && !activeRuns.has(run.runId)) { run.state = "interrupted"; run.settledAt = Date.now(); }
				if (!thread.activeWorkspace) await selectWorkspace(thread, config.cwd, signal);
				else {
					try {
						const workspace = thread.workspaces.find(entry => entry.id === thread!.activeWorkspace)!;
						await verifyWorkspace(workspace);
						const cwd = await fs.realpath(thread.cwd);
						if (cwd !== thread.cwd || !contained(workspace.worktreePath, cwd)) throw new Error("Discord cwd ownership changed");
					}
					catch { return block(thread, "Discord worktree ownership could not be verified; no worker was started"); }
				}
				aborted(signal);
				const run: DiscordThreadRun = { runId: randomUUID(), messageKey, generation: thread.generation, state: "running", startedAt: Date.now() };
				thread.runs.push(run);
				await save(thread); // Durable admission precedes any caller writing worker stdin.
				activeRuns.add(run.runId);
				return { thread: copy(thread), run: { conversationKey: key, sessionId: thread.sessionId, generation: thread.generation, runId: run.runId } };
			});
		},
		settle: (run, state) => serial(run.conversationKey, async () => {
			const thread = await load(run.conversationKey);
			if (!thread || thread.sessionId !== run.sessionId) return;
			const admitted = thread.runs.find(entry => entry.runId === run.runId && entry.generation === run.generation);
			if (!admitted || admitted.state !== "running") return;
			admitted.state = state; admitted.settledAt = Date.now(); activeRuns.delete(run.runId);
			await save(thread);
		}),
		changeCwd: (key, requestedPath, signal) => serial(key, async () => {
			aborted(signal);
			const thread = await load(key);
			if (!thread) throw new Error("No Discord thread session exists yet");
			if (thread.state === "deleted" || thread.state === "archived" || thread.state === "blocked") throw new Error(`Discord thread is ${thread.state}`);
			const requested = path.resolve(thread.cwd, requestedPath);
			await gitSource(requested);
			await fence(thread, "cwd");
			await selectWorkspace(thread, requested, signal);
			return copy(thread);
		}),
		cancel: key => serial(key, async () => { const thread = await load(key); if (thread && thread.state !== "deleted") await fence(thread, "cancel"); }),
		transition: event => {
			const key = messengerConversationKey({ platform: "discord", accountId: event.accountId, guildId: event.guildId, channelId: event.threadId, parentChannelId: event.parentChannelId, threadId: event.threadId, senderId: "lifecycle", messageId: "lifecycle", text: "", direct: false, mentioned: false });
			return serial(key, async () => {
				const thread = await load(key);
				if (!thread || thread.state === "deleted") return;
				if (event.kind === "unarchive") {
					if (thread.state === "archived") { thread.state = "ready"; await save(thread); }
					return;
				}
				if (event.kind === "archive" && thread.state === "archived") return;
				await fence(thread, event.kind);
			});
		},
		recordWorker: (scope, owner) => {
			const thread = [...records.values()].find(entry => entry.sessionId === scope.sessionId);
			if (!thread) return Promise.reject(new Error("Discord worker has no admitted thread"));
			if (thread.generation !== scope.generation) return Promise.reject(new Error("Discord worker generation was retired before publication"));
			const cancelled = Promise.withResolvers<never>();
			let invalidated = false;
			const publication = { generation: scope.generation, cancel() { invalidated = true; cancelled.reject(new Error("Discord worker generation was retired before publication")); } };
			const pending = publications.get(scope.sessionId) ?? new Set();
			publications.set(scope.sessionId, pending);
			pending.add(publication);
			const operation = serial(thread.conversationKey, async () => {
				if (invalidated) throw new Error("Discord worker generation was retired before publication");
				if (!validOwner(owner) || owner.sessionId !== scope.sessionId || owner.generation !== scope.generation || owner.epoch !== scope.epoch || owner.cleanupReceipt !== receiptPath(owner) || thread.generation !== scope.generation || thread.state !== "ready") throw new Error("Discord worker ownership does not match the live thread generation");
				if (thread.worker && thread.worker.epoch !== scope.epoch) await reconcileWorker(thread);
				thread.worker = { ...owner };
				await save(thread);
				liveEpochs.add(owner.epoch);
			});
			return Promise.race([operation, cancelled.promise]).finally(() => {
				pending.delete(publication);
				if (!pending.size) publications.delete(scope.sessionId);
			});
		},
		close: () => closing ??= (async () => {
			closed = true;
			await Promise.allSettled([...lanes.values()]);
			await initialization?.catch(() => {});
			await release?.();
		})(),
	};
}
