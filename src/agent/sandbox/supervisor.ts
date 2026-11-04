import * as path from "node:path";
import { createDockerBackend, SandboxLaunchError } from "./docker";
import { prepareHandsBundle } from "./bundle";
import { sandboxPathContains } from "./policy";
import { encodeHandsFrame, parseHandsResponse, readHandsFrames } from "./rpc";
import type { HandsRequest } from "./rpc";
import type { ToolHandler } from "../engine";
import type { ToolResult } from "../tools";
import type { SandboxBackend, SandboxCallOptions, SandboxExecOptions, SandboxExecResult, SandboxPolicy, SandboxProcess, SandboxSupervisor, SandboxTermination } from "./types";

interface PendingEffect {
  request: HandsRequest;
  frame: string;
  settled: boolean;
  result: PromiseWithResolvers<SandboxExecResult>;
  progress?: (text: string) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

export function createSandboxSupervisor(options: { policy: SandboxPolicy; backend?: SandboxBackend; bundlePath?: string }): SandboxSupervisor {
  const backend = options.backend ?? createDockerBackend();
  let policy = options.policy;
  let state: "ready" | "changing" | "revoked" | "closed" | "failed" = "ready";
  let reason = "";
  let generation = 0;
  let worker: SandboxProcess | undefined;
  let launching: Promise<SandboxProcess> | undefined;
  let launchFailure: Error | undefined;
  let stopping: Promise<SandboxTermination> | undefined;
  let active: PendingEffect | undefined;
  let pumping = false;
  const queue: PendingEffect[] = [];

  function settle(effect: PendingEffect, result: SandboxExecResult): void {
    if (effect.settled) return;
    effect.settled = true;
    if (effect.abort) effect.signal?.removeEventListener("abort", effect.abort);
    effect.result.resolve(result);
  }

  function invalidate(message: string, next: typeof state): number {
    state = state === "closed" ? "closed" : next;
    reason = message;
    generation++;
    const failure = { success: false, output: "", error: message };
    if (active) settle(active, failure);
    for (const effect of queue.splice(0)) settle(effect, failure);
    return generation;
  }

  function terminate(): Promise<SandboxTermination> {
    if (stopping) return stopping;
    const removal = (async (): Promise<SandboxTermination> => {
      const owned = worker ?? (launching ? await launching.catch(() => undefined) : undefined);
      const residual = owned ? [owned.name] : launchFailure instanceof SandboxLaunchError ? [...launchFailure.residual] : launchFailure ? [launchFailure.message] : [];
      try {
        const result = owned ? await owned.stop() : launchFailure instanceof SandboxLaunchError ? await launchFailure.cleanup() : launchFailure ? { gone: false, residual } : { gone: true, residual: [] };
        if (!result.gone || result.residual.length) {
          const remaining = result.residual.length ? [...result.residual] : residual;
          invalidate(`REVOKE_INCOMPLETE: ${remaining.join(", ") || "launch cleanup remains unverified"}`, "failed");
          return { gone: false, residual: remaining };
        }
        if (worker === owned) worker = undefined;
        launchFailure = undefined;
        return { gone: true, residual: [] };
      } catch (error) {
        invalidate(`REVOKE_INCOMPLETE: ${String(error)}`, "failed");
        return { gone: false, residual: residual.length ? residual : [String(error)] };
      }
    })();
    stopping = removal;
    void removal.then(result => { if (!result.gone && stopping === removal) stopping = undefined; });
    return removal;
  }

  function fail(error: unknown): void {
    if (state !== "ready") return;
    invalidate(String(error), "failed");
    void terminate();
  }

  async function start(): Promise<SandboxProcess> {
    if (worker) return worker;
    if (launching) return launching;
    const epoch = generation;
    launching = (async () => {
      const bundle = options.bundlePath ?? await prepareHandsBundle();
      const process = await backend.launch(policy, bundle).catch(error => {
        if (error instanceof SandboxLaunchError || (error instanceof Error && /REVOKE_INCOMPLETE/.test(error.message))) launchFailure = error;
        throw error;
      });
      worker = process;
      void (async () => {
        try {
          for await (const value of readHandsFrames(process.stdout)) {
            if (generation !== epoch || state !== "ready") continue;
            const response = parseHandsResponse(value);
            const effect = active;
            if (!effect || effect.settled || response.id !== effect.request.id) throw new Error("SANDBOX_PROTOCOL: unknown response correlation identity");
            if (response.type === "result") settle(effect, response.result);
            else { try { effect.progress?.(response.text); } catch { /* A UI progress callback is not authority. */ } }
          }
          if (generation === epoch) fail(new Error("SANDBOX_PROTOCOL: hands output closed"));
        } catch (error) { if (generation === epoch) fail(error); }
      })();
      void (async () => {
        const reader = process.stderr.getReader();
        try { while (!(await reader.read()).done) { /* Drain diagnostics without an unbounded parent buffer. */ } }
        catch (error) { if (generation === epoch) fail(error); }
        finally { reader.releaseLock(); }
      })();
      void process.exited.then(() => {
        if (generation === epoch) fail(new Error("SANDBOX_EXIT: hands runtime exited"));
      }, error => { if (generation === epoch) fail(error); });
      return process;
    })();
    try { return await launching; }
    finally { launching = undefined; }
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      while (state === "ready" && queue.length) {
        const effect = queue.shift()!;
        if (effect.settled) continue;
        active = effect;
        const epoch = generation;
        try {
          const process = await start();
          if (state !== "ready" || generation !== epoch || effect.settled) continue;
          await process.stdin.write(effect.frame);
          await process.stdin.flush();
          await effect.result.promise;
        } catch (error) { fail(error); }
        finally { if (active === effect) active = undefined; }
      }
    } finally { pumping = false; }
  }

  function enqueue(request: HandsRequest, callOptions: SandboxCallOptions = {}): Promise<SandboxExecResult> {
    if (state !== "ready") return Promise.resolve({ success: false, output: "", error: reason || "SANDBOX_BLOCKED" });
    if (callOptions.signal?.aborted) return Promise.resolve({ success: false, output: "", error: "SANDBOX_ABORTED: request cancelled" });
    if (queue.length >= 100) return Promise.resolve({ success: false, output: "", error: "SANDBOX_QUEUE: capacity exceeded" });
    let frame: string;
    try { frame = encodeHandsFrame(request); }
    catch (error) { return Promise.resolve({ success: false, output: "", error: String(error) }); }
    const effect: PendingEffect = { request, frame, settled: false, result: Promise.withResolvers<SandboxExecResult>(), progress: callOptions.onProgress, signal: callOptions.signal };
    effect.abort = () => {
      if (effect.settled) return;
      if (active !== effect) { settle(effect, { success: false, output: "", error: "SANDBOX_ABORTED: queued request cancelled" }); return; }
      const epoch = invalidate("SANDBOX_ABORTED: active generation cancelled", "changing");
      void terminate().then(result => {
        if (result.gone && generation === epoch && state === "changing") { stopping = undefined; state = "ready"; reason = ""; }
      });
    };
    effect.signal?.addEventListener("abort", effect.abort, { once: true });
    queue.push(effect);
    void pump();
    return effect.result.promise;
  }

  /** A Windows host path that matches no mount is not "relative" to the Linux guest; it must never be forwarded. */
  function guestPath(value: string): string {
    const mount = path.isAbsolute(value) ? [...policy.mounts].sort((a, b) => b.host.length - a.host.length).find(item => sandboxPathContains(item.host, value)) : undefined;
    if (mount) {
      const relative = path.relative(mount.host, value).split(path.sep).join("/");
      return relative ? `${mount.guest}/${relative}` : mount.guest;
    }
    if (process.platform === "win32" && /^(?:[A-Za-z]:|[\\/]{2}|\\)/.test(value)) throw new Error("SANDBOX_POLICY: host path is outside approved mounts");
    return value;
  }

  function call(tool: string, args: Record<string, unknown>, callOptions?: SandboxCallOptions): Promise<ToolResult> {
    const mapped = { ...args };
    let cwd: string | undefined;
    try {
      for (const key of ["filePath", "path", "dirPath", "dir", "targetPath", "cwd", "subdir"]) {
        if (typeof mapped[key] === "string") mapped[key] = guestPath(mapped[key]);
      }
      if (callOptions?.cwd) cwd = guestPath(callOptions.cwd);
    } catch (error) {
      return Promise.resolve({ success: false, output: "", error: error instanceof Error ? error.message : String(error) });
    }
    return enqueue({ id: crypto.randomUUID(), type: "tool", tool: tool === "approve" ? "__plan_approve" : tool, args: mapped, ...(cwd ? { cwd } : {}) }, callOptions);
  }

  return {
    call,
    toolMap(names): Record<string, ToolHandler> {
      return Object.fromEntries(names.map(name => [name, (args: Record<string, unknown>, cwd: string, onProgress?: (text: string) => void) => call(name, args, { cwd, onProgress })]));
    },
    exec(argv: readonly string[], execOptions: SandboxExecOptions = {}): Promise<SandboxExecResult> {
      let cwd: string | undefined;
      try { if (execOptions.cwd) cwd = guestPath(execOptions.cwd); }
      catch (error) { return Promise.resolve({ success: false, output: "", error: error instanceof Error ? error.message : String(error) }); }
      return enqueue({ id: crypto.randomUUID(), type: "exec", argv: [...argv], ...(cwd ? { cwd } : {}), ...(execOptions.env ? { env: execOptions.env } : {}), ...(execOptions.stdin !== undefined ? { stdin: execOptions.stdin } : {}) }, { signal: execOptions.signal });
    },
    async replacePolicy(next): Promise<void> {
      if (state === "closed" || state === "changing" || next.sessionKey !== policy.sessionKey || next.revision <= policy.revision) throw new Error("SANDBOX_POLICY: closed, changing or invalid policy revision");
      const epoch = invalidate("SANDBOX_POLICY: replacing active generation", "changing");
      const result = await terminate();
      if (!result.gone) throw new Error(reason || "REVOKE_INCOMPLETE");
      if (generation !== epoch) throw new Error(reason || "SANDBOX_POLICY: generation changed");
      policy = next;
      stopping = undefined;
      state = "ready";
      reason = "";
    },
    async revoke(): Promise<SandboxTermination> {
      if (state !== "closed") invalidate("SANDBOX_REVOKED: session authority removed", "revoked");
      return terminate();
    },
    async close(): Promise<void> {
      invalidate("SANDBOX_CLOSED: supervisor closed", "closed");
      const result = await terminate();
      if (!result.gone) throw new Error("REVOKE_INCOMPLETE: sandbox close did not remove its environment");
    },
  };
}
