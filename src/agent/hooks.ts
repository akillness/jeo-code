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
import { readGlobalConfig } from "./state";
import type { HookConfig } from "./state";

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
      else if (Array.isArray(parsed.hooks)) result = { kind: "hooks", hooks: parsed.hooks };
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

export async function loadHooks(cwd: string, signal?: AbortSignal): Promise<NonNullable<HookConfig["hooks"]>> {
  const config = await readGlobalConfig();
  if (!config.hooks?.enabled) {
    return [];
  }

  const sandbox = currentSandboxExecution();
  if (sandbox) {
    const result = await sandbox.supervisor.exec(["bun", "-e", "const file=Bun.file('.jeo/hooks.json');let value={};try{if(await file.exists())value=await file.json()}catch{}process.stdout.write(JSON.stringify(value));"], { cwd, signal: signal ?? sandbox.signal });
    if (!result.success || result.exitCode !== 0) throw new Error(`Sandbox project hook configuration read failed (exit code ${result.exitCode ?? "unavailable"}): ${result.error || result.output}`);
    let local: unknown;
    try { local = JSON.parse(result.stdout ?? result.output); }
    catch { throw new Error("Malformed sandbox project hook configuration"); }
    if (local && typeof local === "object") {
      if ("enabled" in local && local.enabled === false) return [];
      if ("hooks" in local && Array.isArray(local.hooks)) return local.hooks;
    }
    return config.hooks.hooks || [];
  }
  const local = await readLocalHooks(path.join(cwd, ".jeo", "hooks.json"));
  if (local.kind === "disabled") return [];
  if (local.kind === "hooks") return local.hooks;

  return config.hooks?.hooks || [];
}

async function runHookCommand(
  runCmd: string,
  payload: any,
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

export async function runPreToolHooks(
  cwd: string,
  tool: string,
  args: Record<string, any>,
  signal?: AbortSignal,
  onNotice?: (msg: string) => void
): Promise<{ vetoed: boolean; error?: string; output?: string }> {
  try {
    const hooks = await loadHooks(cwd, signal);
    const preToolHooks = hooks.filter(
      h => h.event === "pre-tool" && hookMatchesTool(h.match?.tool, tool)
    );

    for (const hook of preToolHooks) {
      const payload = {
        event: "pre-tool",
        tool,
        args,
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
    }
  } catch (err: any) {
    const msg = `Error executing pre-tool hooks: ${err.message}`;
    onNotice?.(msg);
    return { vetoed: true, error: msg, output: "" };
  }

  return { vetoed: false };
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
      const payload = matched.length === 1
        ? { event: "post-turn", tool: matched[0].tool, args: matched[0].args, success: matched[0].success, output: outputPreviewOf(matched[0].output) }
        : {
            event: "post-turn",
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
        event: "post-implementation",
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
