import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isMessengerMessageAllowed, messengerConversationKey } from "./gateway";
import { discordHostActionDigest, isDiscordHostAction } from "./host-protocol";
import type { DiscordHostAction, DiscordRunRef, MessengerConfig, MessengerMessage } from "./types";
import { messengerProfilePrivatePaths } from "./config";
import { jeoHomeDir, notifySessionsDir } from "../agent/notify/paths";

export interface DiscordHostAuthority {
  bind(run: DiscordRunRef, message: MessengerMessage, workspaceRoot: string): void;
  authorize(run: DiscordRunRef, action: DiscordHostAction, signal: AbortSignal): Promise<void>;
  decide(message: MessengerMessage, requestId: string, decision: "approve" | "deny"): string;
  invalidate(conversationKey: string): void;
  release(run: DiscordRunRef): void;
  close(): void;
}

interface Binding {
  run: DiscordRunRef;
  message: MessengerMessage;
  workspaceRoot: string;
}
interface Pending {
  binding: Binding;
  digest: string;
  action: DiscordHostAction;
  settle(error?: Error): void;
}

function sameRun(a: DiscordRunRef, b: DiscordRunRef): boolean {
  return a.conversationKey === b.conversationKey && a.sessionId === b.sessionId && a.generation === b.generation && a.runId === b.runId;
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Resolve existing ancestors as well as the leaf, so symlinked new-file parents cannot escape. */
function canonicalPath(target: string): string {
  let parent = path.resolve(target);
  const suffix: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync(parent), ...suffix.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Host action path could not be verified");
      const next = path.dirname(parent);
      if (next === parent) throw new Error("Host action path could not be verified");
      suffix.push(path.basename(parent));
      parent = next;
    }
  }
}

const AUTO_TOOLS: Record<string, true> = { read: true, write: true, edit: true, find: true, search: true, ls: true, mkdir: true, ast_grep: true, ast_edit: true, lsp: true, lsp_rename: true, calc: true, web_search: true };
const READ_COMMANDS: Record<string, true> = { pwd: true, ls: true, cat: true, head: true, tail: true, wc: true, grep: true, rg: true, find: true, stat: true, file: true, sort: true, uniq: true, diff: true, cmp: true, printf: true, echo: true, true: true, false: true, test: true, "[": true };
const SAFE_GIT: Record<string, true> = { status: true, diff: true, log: true, show: true, "rev-parse": true, "ls-files": true, "ls-tree": true, "check-ignore": true, describe: true };
const SAFE_ENV: Record<string, true> = { CI: true, NODE_ENV: true, FORCE_COLOR: true, NO_COLOR: true, TERM: true, COLUMNS: true, LINES: true, TZ: true };
const PACKAGE_COMMANDS: Record<string, true> = { bun: true, npm: true, pnpm: true, yarn: true };
const BUILD_COMMANDS: Record<string, true> = { cargo: true, go: true, dotnet: true, swift: true, gradle: true, gradlew: true, mvn: true };
const TEST_COMMANDS: Record<string, true> = { pytest: true, jest: true, vitest: true, tsc: true, eslint: true, biome: true };
// Only understood read-only option spellings are automatic; clustered/attached unknowns ask.
const SAFE_READ_FLAGS: Record<string, RegExp> = {
  pwd: /^-[LP]+$/, ls: /^-[aAbBcCdDfFgGhHiklmMnNopqQrRsStTuUvwx1]+$/,
  cat: /^-[benstuvAET]+$/, head: /^-(?:[ncvq]|[0-9]+)$/, tail: /^-(?:[ncvqfF]|[0-9]+)$/,
  wc: /^-[clmwL]+$/, grep: /^-[aAbBcEeFGhHilLmnNoPqsUuvwxzZ]+$/,
  rg: /^-[aAbBcEeFgGhHiIlmMnNoPqrsStTuUvVwxz]+$|^--(?:files|hidden|no-ignore|no-heading|line-number|files-with-matches|files-without-match|count|fixed-strings|ignore-case|smart-case|glob|type|type-add|json|stats|max-count|max-depth)(?:=|$)/,
  find: /^-(?:name|iname|path|ipath|regex|iregex|type|maxdepth|mindepth|print|print0|not|and|or|a|o)$/,
  stat: /^-[fLnqrsx]+$/, file: /^-[bhiIkLnNprsvz0]+$/,
  sort: /^-[bcdfghiMnrRsuVz]+$/, uniq: /^-[cdiu]+$/, diff: /^-[abBceEfinNpPqsStuUwWy]+$/, cmp: /^-[bls]+$/,
  printf: /^--$/, echo: /^-[enE]+$/,
};
const SAFE_GIT_FLAG = /^-(?:[0-9]+|[pquswbMCr]+|n[0-9]*|U[0-9]*)$|^--(?:short|branch|porcelain|stat|shortstat|numstat|name-only|name-status|cached|staged|no-ext-diff|no-textconv|color|word-diff|check|relative|unified|ignore-space-at-eol|ignore-space-change|ignore-all-space|oneline|decorate|graph|all|max-count|format|pretty|abbrev-ref|show-toplevel|show-prefix|show-cdup|git-common-dir|is-inside-work-tree)(?:=|$)/;

/** Shell syntax we do not classify is approval-only, never guessed safe. Script internals remain CLI-trusted. */
function shellNeedsApproval(command: string, env: unknown, cwd: string, workspaceRoot: string, privateRoots: readonly string[]): boolean {
  if (!command.trim() || /[\x00-\x08]/.test(command)) throw new Error("Invalid host shell command");
  const plain = command.replace(/["'\\]/g, "");
  if (/:\(\)\s*\{\s*:\s*\|\s*:&?\s*;?\s*\}\s*;\s*:/.test(plain) || /\b(?:mkfs(?:\.\w+)?|diskutil\s+erase\w*)\b/i.test(plain) || /\bdd\b[^\n]*\bof=\/dev\//i.test(plain)) throw new Error("Catastrophic host shell actions are not permitted");
  if (/\brm\s+[^;\n|]*-[^;\n|]*[rf][^;\n|]*(?:\s|=)(?:\/|~|\$HOME|\$\{HOME\})(?:\s|$|[;&|])/i.test(plain)) throw new Error("Root or home deletion is not permitted");
  for (const match of plain.matchAll(/(?:^|\s)(?:[^\s]*\/)?rm\s+([^;\n|]+)/g)) {
    const args = match[1].split(/\s+/);
    if (!args.some(arg => arg === "--recursive" || /^-[^-]*r/i.test(arg)) || !args.some(arg => arg === "--force" || /^-[^-]*f/.test(arg))) continue;
    for (const arg of args.filter(arg => arg && !arg.startsWith("-"))) {
      const expanded = arg === "~" ? os.homedir() : arg.startsWith("~/") ? path.join(os.homedir(), arg.slice(2)) : arg;
      const target = path.resolve(cwd, expanded);
      if (target === path.parse(target).root || canonicalPath(target) === canonicalPath(os.homedir())) throw new Error("Root or home deletion is not permitted");
    }
  }
  if (/\b(?:setsid|disown)\b/.test(plain)) throw new Error("Detached host process ownership cannot be verified");
  if (env && (typeof env !== "object" || Object.keys(env).some(key => !SAFE_ENV[key]))) return true;
  // Substitution, code evaluation, redirection, multiline programs and grouping require an exact decision.
  if (/[`$<>\n\r(){}]/.test(command)) return true;
  const segments: string[][] = [[]];
  let word = "";
  let quoted = false;
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) { quote = ""; quoted = true; }
      else if (char === "\\" && quote === '"') {
        if (++i >= command.length) return true;
        // Bash preserves a quoted backslash before ordinary characters.
        word += command[i] === '"' || command[i] === "\\" ? command[i] : `\\${command[i]}`;
      }
      else word += char;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === "\\") { if (++i >= command.length) return true; word += command[i]; }
    else if (/\s/.test(char) || ";&|".includes(char)) {
      if (word || quoted) { segments[segments.length - 1].push(word); word = ""; quoted = false; }
      if (";&|".includes(char) && segments[segments.length - 1].length) segments.push([]);
    } else word += char;
  }
  if (quote) return true;
  if (word || quoted) segments[segments.length - 1].push(word);
  // A cd's success and shell/subshell lifetime cannot be inferred from split operators.
  if (segments.filter(tokens => tokens.length).length > 1 && segments.some(tokens => tokens[0] === "cd")) return true;
  return segments.map(tokens => {
    if (!tokens.length) return false;
    // Even innocuous-looking wrappers can change executable/environment resolution.
    const executable = tokens[0];
    if (executable.includes("/") || executable.includes("=") || /[*?\[\]]/.test(executable)) return true;
    let unsafeOperand = false;
    if (READ_COMMANDS[executable] || PACKAGE_COMMANDS[executable] || BUILD_COMMANDS[executable] || TEST_COMMANDS[executable] || executable === "git" || executable === "cd") {
      let endOptions = false;
      for (const token of tokens.slice(1)) {
        if (!endOptions && token === "--") { endOptions = true; continue; }
        if (/[*?\[\]~]/.test(token)) { unsafeOperand = true; continue; }
        const operand = !endOptions && token.startsWith("-") ? token.includes("=") ? token.slice(token.indexOf("=") + 1) : undefined : token;
        if (operand === undefined) { if (/[\/\\]/.test(token)) unsafeOperand = true; continue; }
        const target = canonicalPath(path.resolve(cwd, operand));
        if (privateRoots.some(root => within(canonicalPath(root), target))) throw new Error("Private host configuration and credentials are not accessible through Discord tools");
        if (!within(workspaceRoot, target)) unsafeOperand = true;
        // diff follows file symlinks discovered inside directory operands even without -r.
        if (executable === "diff" && fs.existsSync(target) && fs.statSync(target).isDirectory()) unsafeOperand = true;
      }
    }
    if (READ_COMMANDS[executable]) {
      if (tokens.slice(1).some(token => token.startsWith("-") && token !== "--" && !SAFE_READ_FLAGS[executable]?.test(token))) return true;
      return unsafeOperand;
    }
    if (executable === "cd") return tokens.length !== 2 || unsafeOperand;
    if (executable === "git") return unsafeOperand || !SAFE_GIT[tokens[1]] || tokens.slice(2).some(token => token.startsWith("-") && token !== "--" && !SAFE_GIT_FLAG.test(token));
    // Attached short-option values are not a generic grammar (e.g. Maven -f.., pytest -cfile).
    if ((PACKAGE_COMMANDS[executable] || BUILD_COMMANDS[executable] || TEST_COMMANDS[executable]) && tokens.slice(1).some(token => /^-[^-].+/.test(token))) return true;
    if (PACKAGE_COMMANDS[executable]) {
      const script = tokens[1] === "run" ? tokens[2] : tokens[1];
      return unsafeOperand || !/^(?:test|build|lint|typecheck|check|format)(?::[\w-]+)?$/.test(script ?? "");
    }
    if (BUILD_COMMANDS[executable]) return unsafeOperand || !/^(?:test|build|check|clippy|vet|fmt|compile|test-compile)$/.test(tokens[1] ?? "");
    if (TEST_COMMANDS[executable]) return unsafeOperand;
    return true;
  }).some(Boolean);
}

function risk(action: DiscordHostAction, binding: Binding, privateRoots: readonly string[]): boolean {
  if (action.kind === "artifact_upload") {
    if (action.channelId !== (binding.message.threadId ?? binding.message.channelId)) throw new Error("Host artifact destination does not match its authenticated thread");
    return true;
  }
  const cwd = canonicalPath(action.cwd);
  if (privateRoots.some(root => within(root, cwd))) throw new Error("Private host configuration and credentials are not accessible through Discord tools");
  let approval = !within(binding.workspaceRoot, cwd);
  for (const key of ["filePath", "path", "dirPath", "targetPath", "dir"]) {
    const value = action.args[key];
    if (typeof value !== "string") continue;
    const target = canonicalPath(path.resolve(cwd, value));
    if (privateRoots.some(root => within(canonicalPath(root), target))) throw new Error("Private host configuration and credentials are not accessible through Discord tools");
    if (!within(binding.workspaceRoot, target)) approval = true;
  }
  if (action.tool === "bash") {
    const command = String(action.args.command ?? action.args.cmd ?? "");
    const plain = command.replace(/["'\\]/g, "");
    if (privateRoots.some(root => plain.includes(root)) || /(?:~|\$HOME|\$\{HOME\})\/\.(?:ssh|aws|gnupg|jeo)(?:\/|\b)/.test(plain)) throw new Error("Private host configuration and credentials are not accessible through Discord tools");
    return shellNeedsApproval(command, action.args.env, cwd, binding.workspaceRoot, privateRoots) || approval;
  }
  if (action.tool === "delete") return true;
  if (!AUTO_TOOLS[action.tool]) return true;
  // lsp may execute commands and is not a read-only name by itself.
  if (action.tool === "lsp" && /command|execute|restart|shutdown/i.test(String(action.args.action ?? action.args.method ?? ""))) return true;
  return approval;
}

function approvalDescription(action: DiscordHostAction, digest: string): string {
  const redacted = JSON.stringify(action, (key, value) => /^(?:env|content|editBlock|edit|text|token|password|secret|authorization)$/i.test(key) ? "[redacted]" : value);
  let safe = redacted.replace(/((?:authorization|proxy-authorization)\s*:\s*)(?:bearer|basic)\s+[^\s"'\\;]+/gi, "$1[redacted]").replace(/(?:https?:\/\/)[^\s"/@]+:[^\s"/@]+@/g, "https://[redacted]@").replace(/((?:token|password|secret|authorization|api[-_]?key)[= :]+)([^\s";]+)/gi, "$1[redacted]");
  for (const [key, value] of Object.entries(process.env)) if (/TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|NONCE|BOOTSTRAP/i.test(key) && value && value.length >= 4) safe = safe.split(value).join("[redacted]");
  if (safe.length > 6_000) safe = "Action arguments exceed the safe display limit; review the exact operation locally before approving.";
  return `${safe}\nExact action SHA-256: ${digest}`;
}

export function createDiscordHostAuthority(config: MessengerConfig, notify: (run: DiscordRunRef, text: string, signal: AbortSignal) => Promise<void>): DiscordHostAuthority {
  const bindings = new Map<string, Binding>();
  const pending = new Map<string, Pending>();
  // Replay decisions never become approvals for a later request or replacement worker.
  const consumedMessages = new Set<string>();
  const retiredRuns = new Set<string>();
  const generations = new Map<string, number>();
  let closed = false;
  const invalidate = (key: string) => {
    const binding = bindings.get(key);
    if (binding) retiredRuns.add(JSON.stringify([binding.run.conversationKey, binding.run.sessionId, binding.run.generation, binding.run.runId]));
    bindings.delete(key);
    for (const request of pending.values()) if (request.binding.run.conversationKey === key) request.settle(new Error("Discord host authorization invalidated"));
  };
  const current = (run: DiscordRunRef): Binding => {
    const binding = bindings.get(run.conversationKey);
    if (closed || !binding || !sameRun(binding.run, run)) throw new Error("Discord host run is not active");
    return binding;
  };
  return {
    bind(run, message, workspaceRoot) {
      if (closed || config.platforms.discord?.workerMode !== "host" || message.platform !== "discord" || !message.threadId || !isMessengerMessageAllowed(message, config) || messengerConversationKey(message) !== run.conversationKey || !Number.isSafeInteger(run.generation) || run.generation < 0 || !run.sessionId || !run.runId) throw new Error("Discord host binding requires an authenticated active thread");
      if (retiredRuns.has(JSON.stringify([run.conversationKey, run.sessionId, run.generation, run.runId])) || run.generation < (generations.get(run.conversationKey) ?? 0)) throw new Error("Discord host binding is stale");
      const existing = bindings.get(run.conversationKey);
      if (existing && sameRun(existing.run, run)) {
        if (existing.message.messageId !== message.messageId || existing.workspaceRoot !== canonicalPath(workspaceRoot)) throw new Error("Discord host run cannot be rebound to another message or workspace");
        return;
      }
      if (existing && !sameRun(existing.run, run)) invalidate(run.conversationKey);
      generations.set(run.conversationKey, run.generation);
      bindings.set(run.conversationKey, { run: { ...run }, message: structuredClone(message), workspaceRoot: canonicalPath(workspaceRoot) });
    },
    async authorize(run, action, signal) {
      const binding = current(run);
      signal.throwIfAborted();
      if (!isDiscordHostAction(action)) throw new Error("Invalid Discord host action");
      const snapshot = structuredClone(action);
      const digest = discordHostActionDigest(snapshot);
      const profilePaths = config.profileDir ? await messengerProfilePrivatePaths(config.profileDir, config.cwd) : [];
      const privateRoots = [config.sessionDir, ...profilePaths, jeoHomeDir(), notifySessionsDir(), path.join(os.homedir(), ".ssh"), path.join(os.homedir(), ".aws"), path.join(os.homedir(), ".gnupg")].map(canonicalPath);
      signal.throwIfAborted();
      if (current(run) !== binding || discordHostActionDigest(action) !== digest) throw new Error("Discord host action changed or became stale before authorization");
      if (!risk(snapshot, binding, privateRoots)) {
        signal.throwIfAborted();
        current(run);
        return;
      }
      const requestId = randomUUID();
      let settle!: (error?: Error) => void;
      const result = new Promise<void>((resolve, reject) => {
        const onAbort = () => settle(new Error("Discord host action cancelled"));
        settle = error => {
          if (!pending.delete(requestId)) return;
          signal.removeEventListener("abort", onAbort);
          error ? reject(error) : resolve();
        };
        pending.set(requestId, { binding, digest, action: snapshot, settle });
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      // Attach rejection before async transport work; abort during delivery cannot become unhandled.
      void result.catch(() => {});
      let delivered = false;
      try {
        await Promise.all([
          notify(binding.run, `Host action requires one-use approval in this thread.\n${approvalDescription(snapshot, digest)}\n/approve ${requestId}\n/deny ${requestId}\nApproval authorizes this exact operation, not future calls. Trusted test/build script internals are not OS-isolated.`, signal).then(() => { delivered = true; }),
          result,
        ]);
      } catch { settle(new Error("Discord host approval could not be delivered")); }
      await result;
      if (!delivered) throw new Error("Discord host approval could not be delivered");
      signal.throwIfAborted();
      if (current(run) !== binding || discordHostActionDigest(action) !== digest) throw new Error("Discord host action changed or became stale before execution");
    },
    decide(message, requestId, decision) {
      if (closed || message.platform !== "discord" || !message.threadId || !isMessengerMessageAllowed(message, config) || message.text !== `/${decision === "approve" ? "approve" : "deny"} ${requestId}`) return "Approval rejected: use the exact standalone control in its originating thread.";
      const messageKey = JSON.stringify([message.accountId, message.channelId, message.messageId]);
      if (consumedMessages.has(messageKey)) return "Approval rejected: this decision message was already consumed.";
      const request = pending.get(requestId);
      if (!request || messengerConversationKey(message) !== request.binding.run.conversationKey || bindings.get(request.binding.run.conversationKey) !== request.binding) return "Approval rejected: no current matching action exists in this thread.";
      consumedMessages.add(messageKey);
      request.settle(decision === "approve" ? undefined : new Error("Discord host action denied"));
      return decision === "approve" ? "Exact action approved once; execution has not been confirmed." : "Exact action denied.";
    },
    invalidate,
    release(run) { const binding = bindings.get(run.conversationKey); if (binding && sameRun(binding.run, run)) invalidate(run.conversationKey); },
    close() { closed = true; for (const key of bindings.keys()) invalidate(key); consumedMessages.clear(); },
  };
}
