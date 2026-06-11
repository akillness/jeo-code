import * as fs from "node:fs/promises";
import * as path from "node:path";
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

export async function loadHooks(cwd: string): Promise<NonNullable<HookConfig["hooks"]>> {
  const config = await readGlobalConfig();
  if (!config.hooks?.enabled) {
    return [];
  }

  const localPath = path.join(cwd, ".joc", "hooks.json");
  try {
    const content = await fs.readFile(localPath, "utf-8");
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object") {
      if (parsed.enabled === false) {
        return [];
      }
      if (Array.isArray(parsed.hooks)) {
        return parsed.hooks;
      }
    }
  } catch (e) {
    // If local file is missing or invalid, fall back to global
  }

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

  const proc = Bun.spawn(["bash", "-c", runCmd], {
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

export async function runPreToolHooks(
  cwd: string,
  tool: string,
  args: Record<string, any>,
  signal?: AbortSignal,
  onNotice?: (msg: string) => void
): Promise<{ vetoed: boolean; error?: string; output?: string }> {
  try {
    const hooks = await loadHooks(cwd);
    const preToolHooks = hooks.filter(
      h => h.event === "pre-tool" && (!h.match?.tool || h.match.tool === tool)
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

export async function runPostTurnHooks(
  cwd: string,
  tool: string,
  args: Record<string, any>,
  success: boolean,
  output: string,
  signal?: AbortSignal,
  onNotice?: (msg: string) => void
): Promise<PostTurnHookDiag[]> {
  const diags: PostTurnHookDiag[] = [];
  try {
    const hooks = await loadHooks(cwd);
    const postTurnHooks = hooks.filter(
      h => h.event === "post-turn" && (!h.match?.tool || h.match.tool === tool)
    );

    const outputPreview = output.length > 10000 ? output.slice(0, 10000) + "\n... (truncated)" : output;

    for (const hook of postTurnHooks) {
      const payload = {
        event: "post-turn",
        tool,
        args,
        success,
        output: outputPreview,
      };

      const timeoutMs = hook.timeoutMs || 30000;
      const result = await runHookCommand(hook.run, payload, cwd, timeoutMs, signal);
      if (result.timedOut) {
        onNotice?.(`Post-turn hook "${hook.run}" timed out (advisory).`);
      } else if (result.aborted) {
        onNotice?.(`Post-turn hook "${hook.run}" was aborted (advisory).`);
      } else if (result.exitCode !== 0) {
        onNotice?.(`Post-turn hook "${hook.run}" exited with non-zero code ${result.exitCode} (advisory).`);
        // Feed the hook's diagnostics back to the MODEL so a post-edit
        // `tsc --noEmit`/lint/test hook drives in-loop self-correction. The
        // tool's own ok/fail is unaffected (the mutation already happened); this
        // is an advisory downstream signal. Engine truncates + dedupes per batch.
        const text = result.output.trim();
        if (text) diags.push({ run: hook.run, exitCode: result.exitCode ?? -1, output: text });
      }
    }
  } catch (err: any) {
    onNotice?.(`Error executing post-turn hooks (advisory): ${err.message}`);
  }
  return diags;
}

export async function runPostImplementationHooks(
  cwd: string,
  request: string,
  signal?: AbortSignal,
  onNotice?: (msg: string) => void
): Promise<{ success: boolean; output: string }> {
  try {
    const hooks = await loadHooks(cwd);
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
