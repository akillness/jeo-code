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

export async function loadHooks(cwd: string): Promise<NonNullable<HookConfig["hooks"]>> {
  const config = await readGlobalConfig();
  const localPath = path.join(cwd, ".joc", "hooks.json");
  try {
    const content = await fs.readFile(localPath, "utf-8");
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object") {
      if (parsed.enabled === false) return [];
      if (Array.isArray(parsed.hooks)) return parsed.hooks;
    }
  } catch (e) {}
  return config.hooks?.hooks || [];
}

async function runHookCommand(
  runCmd: string,
  payload: any,
  cwd: string,
  timeoutMs = 30000,
  signal?: AbortSignal
): Promise<HookRunResult> {
  const proc = Bun.spawn(["bash", "-c", runCmd], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
  try { if (proc.stdin) { proc.stdin.write(JSON.stringify(payload)); await proc.stdin.end(); } } catch (err) {}
  try { await proc.exited; } finally { clearTimeout(timer); }
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, output: [stdout, stderr].filter(Boolean).join("\n"), exitCode: proc.exitCode, timedOut, aborted: false };
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
      const result = await runHookCommand(hook.run, { event: "post-implementation", request }, cwd, hook.timeoutMs || 120000, signal);
      combinedOutput += result.output + "\n";
      if (result.exitCode !== 0) {
        allSuccess = false;
        onNotice?.();
      }
    }
    // GJC Collaboration Logic: If hooks fail, we force a re-implementation turn with the output
    return { success: allSuccess, output: combinedOutput.trim() };
  } catch (err: any) {
    return { success: false, output: err.message };
  }
}
