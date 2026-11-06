import { AsyncLocalStorage } from "node:async_hooks";
import type { SandboxSupervisor } from "./sandbox/types";
import type { GrantAuthority } from "./sandbox/authority";

export interface SandboxExecutionScope {
  supervisor: SandboxSupervisor;
  authority?: GrantAuthority;
  signal?: AbortSignal;
  requestAccess?: (host: string, mode: "ro" | "rw") => Promise<unknown>;
}

const sandboxExecution = new AsyncLocalStorage<SandboxExecutionScope>();

export function currentSandboxExecution(): SandboxExecutionScope | undefined {
  return sandboxExecution.getStore();
}

export function withSandboxExecution<T>(scope: SandboxExecutionScope, run: () => T): T {
  return sandboxExecution.run(scope, run);
}

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolvePosixTool } from "../util/posix-tools";
import { readGlobalConfig, userHooksPath } from "./state";
import type { HookConfig, HookEntry, HookEvent } from "./state";

interface HookRunResult {
  stdout: string;
  stderr: string;
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}

/** A post-turn hook diagnostic the model should SEE (cycle 13): the run command,
 *  its non-zero exit code, and its (trimmed) output. Only emitted for hooks that
 *  ran to completion with a non-zero exit and non-empty output — a clean exit has
 *  nothing to fix, and timed-out/aborted hooks surface only the advisory notice. */
export interface PostTurnHookDiag {
  run: string;
  exitCode: number;
  output: string;
}

// Local `.jeo/hooks.json` read cache, keyed by absolute path → mtime/size. The
// global config is already mtime-cached in state.ts, but the per-project local
// override was re-read (fs.readFile + JSON.parse) on every loadHooks call — once
// per pre-tool hook check and once per post-turn batch. Cache the parsed outcome
// and re-read only when the file's mtime/size changes (any external write bumps
// both, so a stale entry is never served).
type LocalHooks =
  | { kind: "disabled" }
  | { kind: "hooks"; hooks: NonNullable<HookConfig["hooks"]> }
  | { kind: "fallback" };
const localHooksCache = new Map<string, { mtimeMs: number; size: number; result: LocalHooks }>();
const LOCAL_HOOKS_CACHE_CAP = 32;

const HOOK_EVENTS: ReadonlySet<string> = new Set<HookEvent>(["pre-tool", "post-turn", "post-implementation", "pre-prompt", "turn-end"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Hook files are written by installers as well as by hand: drop entries that cannot run
 *  (unknown event, missing command, bad timeout) instead of letting one poison the batch. */
function isHookEntry(value: unknown): value is HookEntry {
  if (!isRecord(value)) return false;
  if (typeof value.event !== "string" || !HOOK_EVENTS.has(value.event)) return false;
  if (typeof value.run !== "string" || !value.run.trim()) return false;
  if (value.timeoutMs !== undefined && !(typeof value.timeoutMs === "number" && value.timeoutMs > 0)) return false;
  if (value.match !== undefined && !isRecord(value.match)) return false;
  return true;
}

async function readLocalHooks(localPath: string): Promise<LocalHooks> {
  let st: { mtimeMs: number; size: number };
  try {
    st = await fs.stat(localPath);
  } catch {
    localHooksCache.delete(localPath);
    return { kind: "fallback" };
  }
  const hit = localHooksCache.get(localPath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.result;
  let result: LocalHooks = { kind: "fallback" };
  try {
    const parsed = JSON.parse(await fs.readFile(localPath, "utf-8"));
    if (parsed && typeof parsed === "object") {
      if (parsed.enabled === false) result = { kind: "disabled" };
      else if (Array.isArray(parsed.hooks)) result = { kind: "hooks", hooks: parsed.hooks.filter(isHookEntry) };
    }
  } catch {
    // Missing/invalid local file → fall back to the global config hooks.
  }
  if (localHooksCache.size >= LOCAL_HOOKS_CACHE_CAP && !localHooksCache.has(localPath)) {
    const oldest = localHooksCache.keys().next().value;
    if (oldest !== undefined) localHooksCache.delete(oldest);
  }
  localHooksCache.set(localPath, { mtimeMs: st.mtimeMs, size: st.size, result });
  return result;
}

/**
 * A sandboxed session reads the project hook file through the supervisor so the host
 * never trusts workspace content it did not mediate. Same outcome shape as
 * `readLocalHooks`.
 */
async function readSandboxLocalHooks(sandbox: SandboxExecutionScope, cwd: string, signal?: AbortSignal): Promise<LocalHooks> {
  const result = await sandbox.supervisor.exec(["bun", "-e", "const file=Bun.file('.jeo/hooks.json');let value={};try{if(await file.exists())value=await file.json()}catch{}process.stdout.write(JSON.stringify(value));"], { cwd, signal: signal ?? sandbox.signal });
  if (!result.success || result.exitCode !== 0) throw new Error(`Sandbox project hook configuration read failed (exit code ${result.exitCode ?? "unavailable"}): ${result.error || result.output}`);
  let local: unknown;
  try { local = JSON.parse(result.stdout ?? result.output); }
  catch { throw new Error("Malformed sandbox project hook configuration"); }
  if (isRecord(local)) {
    if (local.enabled === false) return { kind: "disabled" };
    if (Array.isArray(local.hooks)) return { kind: "hooks", hooks: local.hooks.filter(isHookEntry) };
  }
  return { kind: "fallback" };
}

/**
 * Effective hook list, in run order: user registry (`userHooksPath()`) first, then the
 * configured list.
 *
 * Precedence, strongest first:
 *  1. `config.hooks.enabled === false` — global kill switch; nothing runs.
 *  2. Project `.jeo/hooks.json` with `enabled: false` — project opt-out; nothing runs.
 *  3. The user registry runs unless it opts itself out (`enabled: false`). It is
 *     user-owned and installer-managed, so it does NOT need `config.hooks.enabled: true`.
 *  4. `config.hooks.hooks` / the project `.jeo/hooks.json` list run only when
 *     `config.hooks.enabled === true` (so an untrusted repo cannot enable its own hooks);
 *     the project list replaces the config list, as before, but never the user registry.
 *
 * Sandboxed sessions skip the user registry: its commands live on the host and cannot
 * run inside the sandbox.
 */
export async function loadHooks(cwd: string, signal?: AbortSignal): Promise<HookEntry[]> {
  const config = await readGlobalConfig();
  if (config.hooks?.enabled === false) return [];

  const sandbox = currentSandboxExecution();
  const configHooksOn = config.hooks?.enabled === true;
  // Sandboxed sessions read the project file only when hooks are explicitly enabled, as before.
  if (sandbox && !configHooksOn) return [];
  // The registry lives on the host; a sandboxed session never runs it.
  const user = sandbox ? undefined : await readLocalHooks(userHooksPath());
  const userHooks = user?.kind === "hooks" ? user.hooks : [];
  // Common case (no registry, hooks not enabled): nothing can run, so skip the project file.
  if (!configHooksOn && userHooks.length === 0) return [];

  const local = sandbox
    ? await readSandboxLocalHooks(sandbox, cwd, signal)
    : await readLocalHooks(path.join(cwd, ".jeo", "hooks.json"));
  if (local.kind === "disabled") return [];

  const configured = !configHooksOn ? [] : local.kind === "hooks" ? local.hooks : config.hooks?.hooks ?? [];
  return userHooks.length ? [...userHooks, ...configured] : configured;
}

/** One hook file as `describeHooks` sees it, read fresh (never from the loader cache). */
export interface HookFileReport {
  path: string;
  /** `missing`; `ok`; `disabled` (`enabled: false`); `unreadable` (not valid JSON or not an object). */
  state: "missing" | "ok" | "disabled" | "unreadable";
  /** Entries that can run. */
  entries: number;
  /** Entries dropped as unrunnable (unknown event, missing `run`, bad `timeoutMs`). */
  invalid: number;
}

export interface HookReport {
  /** `config.hooks.enabled`: `on` (true), `off` (false: global kill switch), `unset`. */
  gate: "on" | "off" | "unset";
  registry: HookFileReport;
  project: HookFileReport;
  /** What `loadHooks(cwd)` returns right now, counted by event. */
  active: Partial<Record<HookEvent, number>>;
  total: number;
}

async function inspectHookFile(file: string): Promise<HookFileReport> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf-8");
  } catch (err: unknown) {
    const missing = isRecord(err) && err.code === "ENOENT";
    return { path: file, state: missing ? "missing" : "unreadable", entries: 0, invalid: 0 };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { path: file, state: "unreadable", entries: 0, invalid: 0 }; }
  if (!isRecord(parsed)) return { path: file, state: "unreadable", entries: 0, invalid: 0 };
  const list = Array.isArray(parsed.hooks) ? parsed.hooks : [];
  const entries = list.filter(isHookEntry).length;
  return { path: file, state: parsed.enabled === false ? "disabled" : "ok", entries, invalid: list.length - entries };
}

/**
 * Read-only account of the hook setup for `jeo doctor`: the global switch, the user
 * registry and the project file as written (with how many entries were dropped as
 * unrunnable), and what actually runs for `cwd`. Installers write these files, and a bad
 * entry is otherwise dropped silently, so this is the one place to see why a hook is idle.
 */
export async function describeHooks(cwd: string): Promise<HookReport> {
  const config = await readGlobalConfig();
  const gate = config.hooks?.enabled === true ? "on" : config.hooks?.enabled === false ? "off" : "unset";
  const [registry, project] = await Promise.all([inspectHookFile(userHooksPath()), inspectHookFile(path.join(cwd, ".jeo", "hooks.json"))]);
  const active: Partial<Record<HookEvent, number>> = {};
  let total = 0;
  try {
    for (const hook of await loadHooks(cwd)) {
      active[hook.event] = (active[hook.event] ?? 0) + 1;
      total++;
    }
  } catch {
    // An unreadable project file must not take the whole report down.
  }
  return { gate, registry, project, active, total };
}

async function runHookCommand(
  runCmd: string,
  payload: unknown,
  cwd: string,
  timeoutMs = 30000,
  signal?: AbortSignal
): Promise<HookRunResult> {
  if (signal?.aborted) {
    return { stdout: "", stderr: "", output: "", exitCode: null, timedOut: false, aborted: true };
  }
  const sandbox = currentSandboxExecution();
  if (sandbox) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const result = await sandbox.supervisor.exec(["/bin/sh", "-c", runCmd], {
      cwd, stdin: JSON.stringify(payload), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (result.exitCode === undefined) throw new Error(result.error || "Malformed sandbox hook result: missing exitCode");
    return {
      stdout: result.stdout ?? result.output, stderr: result.stderr ?? "", output: result.output,
      exitCode: result.exitCode, timedOut: result.timedOut === true || timeout.aborted,
      aborted: result.aborted === true || signal?.aborted === true,
    };
  }

  const proc = Bun.spawn([resolvePosixTool("bash"), "-c", runCmd], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let aborted = false;

  const onAbort = () => {
    aborted = true;
    try {
      proc.kill();
    } catch {}
  };

  if (signal) {
    signal.addEventListener("abort", onAbort);
  }

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {}
    killTimer = setTimeout(() => {
      try {
        proc.kill(9);
      } catch {}
    }, 3000);
  }, timeoutMs);

  try {
    if (proc.stdin) {
      proc.stdin.write(JSON.stringify(payload));
      await proc.stdin.end();
    }
  } catch (err) {
    // Ignore write errors if process died quickly
  }

  try {
    await proc.exited;
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
  }

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const output = [stdout, stderr].filter(Boolean).join("\n");

  return {
    stdout,
    stderr,
    output,
    exitCode: proc.exitCode,
    timedOut,
    aborted,
  };
}


/** True when a hook's `match.tool` selects `tool`. Accepts a single name or a
 *  `|`-separated list (`"edit|write"`) — so one post-edit tsc hook can cover
 *  every mutating tool without duplicate entries. No match = all tools. */
export function hookMatchesTool(matchTool: string | undefined, tool: string): boolean {
  if (!matchTool) return true;
  return matchTool.split("|").some(t => t.trim() === tool);
}

let hookSessionId = "";

/** Set by the launch loop so every hook payload carries the live session id
 *  (`session_id`, Claude hook protocol). Empty string when no session is active. */
export function setHookSessionId(sessionId: string | undefined): void {
  hookSessionId = sessionId ?? "";
}

/**
 * Fields every hook payload carries. `event` is jeo's own name (kept for existing hooks);
 * `hook_event_name`/`session_id`/`cwd` follow the Claude hook protocol so scripts written
 * for Claude Code / Codex (`UserPromptSubmit`, `Stop`, `PreToolUse`) run unmodified.
 *
 * A sandboxed hook runs in the guest, so it gets the legacy payload only: never the host
 * `cwd` or session id.
 */
function basePayload(event: HookEvent, claudeEvent: string, cwd: string) {
  if (currentSandboxExecution()) return { event };
  return { event, hook_event_name: claudeEvent, session_id: hookSessionId, cwd };
}

/** Claude-protocol aliases (`tool_name`/`tool_input`) for a tool call; none in a sandbox. */
function toolAliases(tool: string, args: Record<string, unknown>) {
  return currentSandboxExecution() ? {} : { tool_name: tool, tool_input: args };
}

const MAX_HOOK_CONTEXT_CHARS = 8_000;

function parseHookJson(stdout: string): Record<string, unknown> | undefined {
  const text = stdout.trim();
  if (!text.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function clampContext(text: string): string {
  return text.length > MAX_HOOK_CONTEXT_CHARS ? `${text.slice(0, MAX_HOOK_CONTEXT_CHARS)}\n... (hook context truncated)` : text;
}

/** `additionalContext` from a Claude-protocol hook output (`hookSpecificOutput.additionalContext`,
 *  top-level `additionalContext`, or `context`). Empty when the output carries none. */
function jsonHookContext(json: Record<string, unknown>): string {
  const specific = isRecord(json.hookSpecificOutput) ? json.hookSpecificOutput : {};
  for (const value of [specific.additionalContext, json.additionalContext, json.context]) {
    if (typeof value === "string" && value.trim()) return clampContext(value.trim());
  }
  return "";
}

/** A deny decision a hook returned with exit 0 (Claude `permissionDecision: deny|ask`,
 *  legacy `decision: block`, or `continue: false`). jeo has no approval prompt for hooks,
 *  so `ask` is treated as deny — the safe reading. */
function jsonHookDenial(json: Record<string, unknown>): { reason: string } | undefined {
  const specific = isRecord(json.hookSpecificOutput) ? json.hookSpecificOutput : {};
  const decision = specific.permissionDecision ?? json.decision;
  const denied = decision === "deny" || decision === "ask" || decision === "block" || json.continue === false;
  if (!denied) return undefined;
  const reason = [specific.permissionDecisionReason, json.reason, json.stopReason].find(v => typeof v === "string" && v.trim());
  return { reason: typeof reason === "string" ? reason.trim() : "no reason given" };
}

export async function runPreToolHooks(
  cwd: string,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  onNotice?: (msg: string) => void
): Promise<{ vetoed: boolean; error?: string; output?: string; context?: string }> {
  const contexts: string[] = [];
  try {
    const hooks = await loadHooks(cwd, signal);
    const preToolHooks = hooks.filter(
      h => h.event === "pre-tool" && hookMatchesTool(h.match?.tool, tool)
    );

    for (const hook of preToolHooks) {
      const payload = {
        ...basePayload("pre-tool", "PreToolUse", cwd),
        tool,
        args,
        ...toolAliases(tool, args),
      };

      const timeoutMs = hook.timeoutMs || 30000;
      const result = await runHookCommand(hook.run, payload, cwd, timeoutMs, signal);
      if (result.timedOut) {
        const msg = `Pre-tool hook "${hook.run}" timed out after ${timeoutMs}ms.`;
        onNotice?.(msg);
        return { vetoed: true, error: msg, output: result.output };
      }
      if (result.aborted) {
        const msg = `Pre-tool hook "${hook.run}" was aborted.`;
        onNotice?.(msg);
        return { vetoed: true, error: msg, output: result.output };
      }
      if (result.exitCode !== 0) {
        const msg = `Pre-tool hook "${hook.run}" vetoed execution (exit code ${result.exitCode}).`;
        onNotice?.(msg);
        return { vetoed: true, error: msg, output: result.output };
      }
      // Exit 0 can still carry a structured decision (Claude-protocol hooks never exit 2
      // to deny; they print `permissionDecision`). Plain stdout stays ignored so a
      // hook's own logging never leaks into the model's tool result.
      const json = parseHookJson(result.stdout);
      if (!json) continue;
      const denial = jsonHookDenial(json);
      if (denial) {
        const msg = `Pre-tool hook "${hook.run}" denied execution: ${denial.reason}`;
        onNotice?.(msg);
        return { vetoed: true, error: msg };
      }
      const context = jsonHookContext(json);
      if (context) contexts.push(context);
    }
  } catch (err: unknown) {
    const msg = `Error executing pre-tool hooks: ${err instanceof Error ? err.message : String(err)}`;
    onNotice?.(msg);
    return { vetoed: true, error: msg, output: "" };
  }

  return contexts.length ? { vetoed: false, context: contexts.join("\n") } : { vetoed: false };
}

/** One executed tool call fed to the post-turn hooks of a batch. */
export interface PostTurnCall {
  tool: string;
  args: Record<string, any>;
  success: boolean;
  output: string;
}

function outputPreviewOf(output: string): string {
  return output.length > 10000 ? output.slice(0, 10000) + "\n... (truncated)" : output;
}

/**
 * Run post-turn hooks for a whole batch of executed tool calls, invoking each
 * matching hook EXACTLY ONCE — not once per result. A project-wide checker
 * (`tsc --noEmit`/lint/test) that matches every edit in a batch previously ran N
 * times sequentially; now it runs a single time. Distinct hooks run concurrently.
 *
 * Payload back-compat: a hook that matches a single call gets the legacy
 * `{event,tool,args,success,output}` shape; a hook matching several gets the same
 * fields plus a `calls[]` array (every matched call) so a payload-aware per-file
 * hook can still iterate the changed files in one invocation.
 */
export async function runPostTurnHooksForBatch(
  cwd: string,
  calls: readonly PostTurnCall[],
  signal?: AbortSignal,
  onNotice?: (msg: string) => void
): Promise<{ diags: PostTurnHookDiag[]; ran: number }> {
  const diags: PostTurnHookDiag[] = [];
  // Hooks that ran to COMPLETION (not timed out/aborted) — lets the engine treat
  // "hooks ran clean" (clear a pending failure) differently from "no hook ran".
  let ran = 0;
  try {
    const hooks = await loadHooks(cwd, signal);
    const jobs = hooks
      .filter(h => h.event === "post-turn")
      .map(hook => ({ hook, matched: calls.filter(c => hookMatchesTool(hook.match?.tool, c.tool)) }))
      .filter(j => j.matched.length > 0);

    // Distinct hooks are independent commands → run them concurrently. Each hook
    // itself runs once for the whole batch (the redundancy this fix removes).
    const settled = await Promise.all(jobs.map(async ({ hook, matched }) => {
      const base = basePayload("post-turn", "PostToolUse", cwd);
      const payload = matched.length === 1
        ? { ...base, tool: matched[0].tool, args: matched[0].args, ...toolAliases(matched[0].tool, matched[0].args), success: matched[0].success, output: outputPreviewOf(matched[0].output) }
        : {
            ...base,
            tool: matched.map(c => c.tool).join(","),
            calls: matched.map(c => ({ tool: c.tool, args: c.args, success: c.success })),
            success: matched.every(c => c.success),
            output: outputPreviewOf(matched.map(c => c.output).join("\n")),
          };
      const timeoutMs = hook.timeoutMs || 30000;
      const result = await runHookCommand(hook.run, payload, cwd, timeoutMs, signal);
      return { hook, result };
    }));

    for (const { hook, result } of settled) {
      if (result.timedOut) {
        onNotice?.(`Post-turn hook "${hook.run}" timed out (advisory).`);
      } else if (result.aborted) {
        onNotice?.(`Post-turn hook "${hook.run}" was aborted (advisory).`);
      } else if (result.exitCode !== 0) {
        ran++;
        onNotice?.(`Post-turn hook "${hook.run}" exited with non-zero code ${result.exitCode} (advisory).`);
        // Feed the hook's diagnostics back to the MODEL so a post-edit
        // `tsc --noEmit`/lint/test hook drives in-loop self-correction. The
        // tool's own ok/fail is unaffected (the mutation already happened); this
        // is an advisory downstream signal. Engine truncates + dedupes per batch.
        const text = result.output.trim();
        if (text) diags.push({ run: hook.run, exitCode: result.exitCode ?? -1, output: text });
      } else {
        ran++;
      }
    }
  } catch (err: any) {
    onNotice?.(`Error executing post-turn hooks (advisory): ${err.message}`);
  }
  return { diags, ran };
}

/** Single-call convenience wrapper (kept for direct callers/tests). Delegates to
 *  the batch runner with one call, preserving the legacy payload shape. */
export async function runPostTurnHooks(
  cwd: string,
  tool: string,
  args: Record<string, any>,
  success: boolean,
  output: string,
  signal?: AbortSignal,
  onNotice?: (msg: string) => void
): Promise<{ diags: PostTurnHookDiag[]; ran: number }> {
  return runPostTurnHooksForBatch(cwd, [{ tool, args, success, output }], signal, onNotice);
}

export async function runPostImplementationHooks(
  cwd: string,
  request: string,
  signal?: AbortSignal,
  onNotice?: (msg: string) => void
): Promise<{ success: boolean; output: string }> {
  try {
    const hooks = await loadHooks(cwd, signal);
    const postImplHooks = hooks.filter(h => h.event === "post-implementation");
    
    let combinedOutput = "";
    let allSuccess = true;

    for (const hook of postImplHooks) {
      const payload = {
        ...basePayload("post-implementation", "post-implementation", cwd),
        request,
      };

      const timeoutMs = hook.timeoutMs || 60000; // Implementation hooks get longer timeout
      const result = await runHookCommand(hook.run, payload, cwd, timeoutMs, signal);
      combinedOutput += result.output + "\n";
      
      if (result.exitCode !== 0) {
        allSuccess = false;
        onNotice?.(`Post-implementation hook "${hook.run}" failed (exit code ${result.exitCode}).`);
      }
    }
    
    return { success: allSuccess, output: combinedOutput.trim() };
  } catch (err: any) {
    const msg = `Error executing post-implementation hooks: ${err.message}`;
    onNotice?.(msg);
    return { success: false, output: msg };
  }
}

const PRE_PROMPT_TIMEOUT_MS = 10_000;
const TURN_END_TIMEOUT_MS = 30_000;
const MAX_PROMPT_PAYLOAD_CHARS = 20_000;
const MAX_RESPONSE_PAYLOAD_CHARS = 200_000;

export interface PrePromptHookResult {
  /** Context the hooks asked to place in front of the model (empty when none). */
  context: string;
  /** Hooks that ran to completion (exit 0) — lets callers tell "nothing to add" from "no hook". */
  ran: number;
}

/**
 * Run `pre-prompt` hooks once for a real user prompt, before the model sees it
 * (Claude `UserPromptSubmit`). Payload: `{event, hook_event_name:"UserPromptSubmit",
 * session_id, cwd, prompt}`. A hook contributes context by printing either plain text or a
 * Claude-protocol JSON object (`hookSpecificOutput.additionalContext` / `additionalContext`
 * / `context`). This is a routing/enrichment point, never a gate: a hook that fails, times
 * out or is aborted yields a notice and no context, so a broken hook can't block a prompt.
 */
export async function runPrePromptHooks(
  cwd: string,
  prompt: string,
  signal?: AbortSignal,
  onNotice?: (msg: string) => void,
): Promise<PrePromptHookResult> {
  const contexts: string[] = [];
  let ran = 0;
  try {
    const hooks = (await loadHooks(cwd, signal)).filter(h => h.event === "pre-prompt");
    if (hooks.length === 0 || !prompt.trim()) return { context: "", ran: 0 };
    const payload = { ...basePayload("pre-prompt", "UserPromptSubmit", cwd), prompt: prompt.slice(0, MAX_PROMPT_PAYLOAD_CHARS) };
    const settled = await Promise.all(hooks.map(async hook => {
      try {
        return { hook, result: await runHookCommand(hook.run, payload, cwd, hook.timeoutMs || PRE_PROMPT_TIMEOUT_MS, signal) };
      } catch (err: unknown) {
        onNotice?.(`Pre-prompt hook "${hook.run}" failed to start (advisory): ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    }));
    // Hook order, not completion order, decides how contexts are stacked.
    for (const entry of settled) {
      if (!entry) continue;
      const { hook, result } = entry;
      if (result.timedOut) onNotice?.(`Pre-prompt hook "${hook.run}" timed out (advisory).`);
      else if (result.aborted) continue;
      else if (result.exitCode !== 0) onNotice?.(`Pre-prompt hook "${hook.run}" exited with non-zero code ${result.exitCode} (advisory).`);
      else {
        ran++;
        const json = parseHookJson(result.stdout);
        const context = json ? jsonHookContext(json) : clampContext(result.stdout.trim());
        if (context) contexts.push(context);
      }
    }
  } catch (err: unknown) {
    onNotice?.(`Error executing pre-prompt hooks (advisory): ${err instanceof Error ? err.message : String(err)}`);
  }
  return { context: contexts.join("\n\n"), ran };
}

export interface TurnEndInfo {
  prompt: string;
  /** The final reply text of the turn. */
  response: string;
  /** True when the model signalled completion (false for a step-limit/unverified stop). */
  done: boolean;
  steps: number;
  model?: string;
}

/**
 * Run `turn-end` hooks once per finished turn (Claude `Stop`). Payload carries the turn's
 * final reply under `response` and `last_assistant_message` (and `assistant_output`) so
 * scripts that ingest assistant output can read it directly, alongside `prompt`, `done`,
 * `steps`, `model`, `session_id`, `cwd`. Advisory only: failures yield a notice and never
 * change the turn's result. Awaited so a one-shot `jeo -p` does not exit before they finish.
 */
export async function runTurnEndHooks(
  cwd: string,
  info: TurnEndInfo,
  signal?: AbortSignal,
  onNotice?: (msg: string) => void,
): Promise<{ ran: number }> {
  let ran = 0;
  try {
    const hooks = (await loadHooks(cwd, signal)).filter(h => h.event === "turn-end");
    if (hooks.length === 0) return { ran: 0 };
    const response = info.response.length > MAX_RESPONSE_PAYLOAD_CHARS ? info.response.slice(0, MAX_RESPONSE_PAYLOAD_CHARS) : info.response;
    const payload = {
      ...basePayload("turn-end", "Stop", cwd),
      prompt: info.prompt.slice(0, MAX_PROMPT_PAYLOAD_CHARS),
      response,
      last_assistant_message: response,
      assistant_output: response,
      done: info.done,
      steps: info.steps,
      model: info.model ?? "",
      stop_hook_active: false,
    };
    const settled = await Promise.all(hooks.map(async hook => {
      try {
        return { hook, result: await runHookCommand(hook.run, payload, cwd, hook.timeoutMs || TURN_END_TIMEOUT_MS, signal) };
      } catch (err: unknown) {
        onNotice?.(`Turn-end hook "${hook.run}" failed to start (advisory): ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    }));
    for (const entry of settled) {
      if (!entry) continue;
      const { hook, result } = entry;
      if (result.timedOut) onNotice?.(`Turn-end hook "${hook.run}" timed out (advisory).`);
      else if (result.aborted) continue;
      else if (result.exitCode !== 0) onNotice?.(`Turn-end hook "${hook.run}" exited with non-zero code ${result.exitCode} (advisory).`);
      else ran++;
    }
  } catch (err: unknown) {
    onNotice?.(`Error executing turn-end hooks (advisory): ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ran };
}
