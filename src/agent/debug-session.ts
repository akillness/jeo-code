/**
 * In-process CDP (V8 Inspector Protocol) client driving a spawned `node --inspect-brk`
 * process (gjc `debug` parity, Node.js JavaScript/TypeScript ONLY).
 *
 * Scope, stated honestly:
 *  - Targets `node` specifically. Bun's own inspector speaks the WebKit Inspector
 *    Protocol dialect (Bun docs: "Bun speaks the WebKit Inspector Protocol"), and
 *    empirical testing here showed its `Debugger.paused`/resume sequencing does NOT
 *    behave like Node's — so Bun is NOT supported rather than silently half-working.
 *  - No DAP wire protocol, no other languages, no remote/attach mode — this speaks
 *    the underlying V8 protocol directly against a locally-spawned `node` process.
 *  - One debug session at a time, matching the tool's "one active session" model.
 *    `launch()` terminates any previous session first.
 *
 * Flow: `launch()` spawns `node --inspect-brk=0 <program> <args>`, connects over
 * WebSocket, enables the Debugger/Runtime domains, and resumes through Node's own
 * "Break on start" pause via `Runtime.runIfWaitingForDebugger` — the session is left
 * PAUSED there so the caller can set breakpoints before the first line of real user
 * code runs, then call `continue`.
 */
import * as path from "node:path";

interface CdpLocation {
  scriptId: string;
  lineNumber: number;
  columnNumber?: number;
}

interface CdpScope {
  type: string;
  object: { objectId?: string; description?: string };
}

interface CdpCallFrame {
  callFrameId: string;
  functionName: string;
  location: CdpLocation;
  scopeChain: CdpScope[];
}

interface PausedState {
  callFrames: CdpCallFrame[];
  reason: string;
}

/** Outcome of waiting for the next debug-relevant event: a real pause, the process
 *  actually exiting, or the script's execution context finishing while Node keeps
 *  the (now idle) process alive waiting for the debugger — see the
 *  `Runtime.executionContextDestroyed` handling in `handleMessage`. */
type WaitResult = PausedState | { exited: true; code: number | null } | { finished: true };

interface BreakpointRecord {
  id: string;
  file: string;
  line: number;
  condition?: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CONNECT_TIMEOUT_MS = 10_000;
const PAUSE_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_CHARS = 20_000;

export class DebugSession {
  private proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  private ws: WebSocket | undefined;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private paused: PausedState | undefined;
  private exitCode: number | null | undefined;
  private outputBuf = "";
  private scriptUrls = new Map<string, string>(); // scriptId -> url
  private breakpoints = new Map<string, BreakpointRecord>(); // cdp breakpointId -> record
  private pausedWaiters: Array<(p: WaitResult) => void> = [];

  get isActive(): boolean {
    return !!this.proc && this.exitCode === undefined;
  }

  get isPaused(): boolean {
    return !!this.paused;
  }

  private appendOutput(chunk: string): void {
    this.outputBuf += chunk;
    if (this.outputBuf.length > MAX_OUTPUT_CHARS) {
      this.outputBuf = "…[truncated]…\n" + this.outputBuf.slice(this.outputBuf.length - MAX_OUTPUT_CHARS);
    }
  }

  output(): string {
    return this.outputBuf;
  }

  private async drain(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        this.appendOutput(decoder.decode(value, { stream: true }));
      }
    } catch {
      // stream torn down on terminate — nothing further to drain
    }
  }

  private send(method: string, params: Record<string, any> = {}): Promise<any> {
    if (!this.ws) return Promise.reject(new Error("No active debug session."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "Debugger.scriptParsed") {
      this.scriptUrls.set(msg.params.scriptId, msg.params.url);
    } else if (msg.method === "Debugger.paused") {
      this.paused = { callFrames: msg.params.callFrames, reason: msg.params.reason };
      const waiters = this.pausedWaiters.splice(0);
      for (const w of waiters) w(this.paused);
    } else if (msg.method === "Debugger.resumed") {
      this.paused = undefined;
    } else if (msg.method === "Debugger.breakpointResolved") {
      const rec = this.breakpoints.get(msg.params.breakpointId);
      if (rec) this.scriptUrls.set(msg.params.location.scriptId, this.scriptUrls.get(msg.params.location.scriptId) ?? rec.file);
    } else if (msg.method === "Runtime.executionContextDestroyed") {
      // Node keeps the process alive after the script finishes while a debugger is
      // attached (it waits to be told to exit) — proc.exited would hang forever, so
      // this event is the real "the script is done" signal. Settle any waiter with
      // `finished`, then kill the now-idle process ourselves; nothing further to debug.
      const waiters = this.pausedWaiters.splice(0);
      for (const w of waiters) w({ finished: true });
      void this.terminate();
    }
  }

  /** Resolve on the next `Debugger.paused`, OR immediately if the process has already
   *  exited (so a `continue`/`step` after the last breakpoint doesn't hang forever). */
  private waitForPausedOrExit(): Promise<WaitResult> {
    if (this.exitCode !== undefined) return Promise.resolve({ exited: true, code: this.exitCode });
    return new Promise((resolve) => {
      let done = false;
      const settle = (v: WaitResult) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      this.pausedWaiters.push(settle);
      this.proc?.exited.then((code) => settle({ exited: true, code }));
      setTimeout(() => settle({ exited: true, code: null }), PAUSE_TIMEOUT_MS);
    });
  }

  async launch(program: string, args: string[], cwd: string): Promise<{ success: boolean; output: string; error?: string }> {
    await this.terminate();

    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn(["node", "--inspect-brk=0", program, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (err: any) {
      return { success: false, output: "", error: `Failed to spawn 'node': ${err.message}` };
    }
    this.proc = proc;
    this.exitCode = undefined;
    this.outputBuf = "";
    this.scriptUrls.clear();
    this.breakpoints.clear();
    this.paused = undefined;
    void proc.exited.then((code) => { if (this.proc === proc) this.exitCode = code; });
    void this.drain(proc.stdout);

    const url = await this.waitForInspectorUrl(proc.stderr);
    if (!url) {
      await this.terminate();
      return { success: false, output: "", error: "node did not print an inspector WebSocket URL in time — is 'node' installed and on PATH?" };
    }

    try {
      const ws = new WebSocket(url);
      this.ws = ws;
      // Guard against a STALE socket delivering buffered messages after a newer
      // session has replaced `this.ws` (e.g. a killed process's socket flushing its
      // last frames concurrently with the next `launch()`) — without this, a
      // straggler event would mutate the singleton's live session state from a dead
      // session's listener closure.
      ws.addEventListener("message", (ev) => { if (this.ws === ws) this.handleMessage(ev.data as string); });
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("Timed out connecting to the inspector WebSocket.")), CONNECT_TIMEOUT_MS);
        ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
        ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("Inspector WebSocket connection failed.")); }, { once: true });
      });
      await this.send("Debugger.enable");
      await this.send("Runtime.enable");
      await this.send("Runtime.runIfWaitingForDebugger");
    } catch (err: any) {
      await this.terminate();
      return { success: false, output: "", error: err.message };
    }

    const settled = await this.waitForPausedOrExit();
    if ("exited" in settled) {
      return { success: false, output: "", error: `Program exited (code ${settled.code}) before an initial breakpoint could be established.` };
    }
    if ("finished" in settled) {
      return { success: false, output: "", error: "The program finished before an initial breakpoint could be established." };
    }
    return {
      success: true,
      output: `Launched 'node ${program} ${args.join(" ")}'. Paused at program start (${settled.reason}). ` +
        `Set breakpoints, then 'continue' to run.`,
    };
  }

  private async waitForInspectorUrl(stderr: ReadableStream<Uint8Array>): Promise<string | undefined> {
    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: false }>((r) => setTimeout(() => r({ value: undefined, done: false }), 200)),
        ]);
        if (done) break;
        if (value) {
          const text = decoder.decode(value, { stream: true });
          buf += text;
          this.appendOutput(text);
          const m = /ws:\/\/\S+/.exec(buf);
          if (m) return m[0];
        }
      }
    } finally {
      reader.releaseLock();
      // Keep draining the rest of stderr into captured output after url discovery.
      void this.drain(stderr).catch(() => {});
    }
    return undefined;
  }

  async setBreakpoint(file: string, line1: number, cwd: string, condition?: string): Promise<{ success: boolean; output: string; error?: string }> {
    if (!this.isActive) return { success: false, output: "", error: "No active debug session. Launch one first." };
    const absPath = path.resolve(cwd, file);
    try {
      const res = await this.send("Debugger.setBreakpointByUrl", {
        lineNumber: line1 - 1,
        urlRegex: escapeRegex(absPath),
        condition,
      });
      this.breakpoints.set(res.breakpointId, { id: res.breakpointId, file: absPath, line: line1, condition });
      const resolvedNote = res.locations?.length ? "" : " (not yet resolved — script not loaded yet, will resolve once it is)";
      return { success: true, output: `Breakpoint ${res.breakpointId} set at ${file}:${line1}${resolvedNote}.` };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  async removeBreakpoint(id: string): Promise<{ success: boolean; output: string; error?: string }> {
    if (!this.isActive) return { success: false, output: "", error: "No active debug session." };
    if (!this.breakpoints.has(id)) return { success: false, output: "", error: `Unknown breakpoint id '${id}'.` };
    try {
      await this.send("Debugger.removeBreakpoint", { breakpointId: id });
      this.breakpoints.delete(id);
      return { success: true, output: `Breakpoint ${id} removed.` };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private async resumeLike(method: string, label: string): Promise<{ success: boolean; output: string; error?: string }> {
    if (!this.isActive) return { success: false, output: "", error: "No active debug session." };
    if (!this.isPaused) return { success: false, output: "", error: `Cannot '${label}': the session is not paused.` };
    try {
      await this.send(method);
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
    const settled = await this.waitForPausedOrExit();
    if ("exited" in settled) {
      return { success: true, output: `Program exited (code ${settled.code}).` };
    }
    if ("finished" in settled) {
      return { success: true, output: "Program finished (execution completed)." };
    }
    return { success: true, output: this.formatPaused(settled) };
  }

  continue(): Promise<{ success: boolean; output: string; error?: string }> {
    return this.resumeLike("Debugger.resume", "continue");
  }

  stepOver(): Promise<{ success: boolean; output: string; error?: string }> {
    return this.resumeLike("Debugger.stepOver", "step_over");
  }

  stepIn(): Promise<{ success: boolean; output: string; error?: string }> {
    return this.resumeLike("Debugger.stepInto", "step_in");
  }

  stepOut(): Promise<{ success: boolean; output: string; error?: string }> {
    return this.resumeLike("Debugger.stepOut", "step_out");
  }

  async pause(): Promise<{ success: boolean; output: string; error?: string }> {
    if (!this.isActive) return { success: false, output: "", error: "No active debug session." };
    if (this.isPaused) return { success: true, output: this.formatPaused(this.paused!) };
    try {
      await this.send("Debugger.pause");
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
    const settled = await this.waitForPausedOrExit();
    if ("exited" in settled) return { success: true, output: `Program exited (code ${settled.code}).` };
    if ("finished" in settled) return { success: true, output: "Program finished (execution completed)." };
    return { success: true, output: this.formatPaused(settled) };
  }

  async evaluate(expression: string, frameIndex = 0): Promise<{ success: boolean; output: string; error?: string }> {
    if (!this.isActive) return { success: false, output: "", error: "No active debug session." };
    try {
      let result: any;
      if (this.isPaused) {
        const frame = this.paused!.callFrames[frameIndex];
        if (!frame) return { success: false, output: "", error: `No stack frame at index ${frameIndex}.` };
        result = await this.send("Debugger.evaluateOnCallFrame", { callFrameId: frame.callFrameId, expression });
      } else {
        result = await this.send("Runtime.evaluate", { expression });
      }
      if (result.exceptionDetails) {
        return { success: false, output: "", error: this.describeRemoteObject(result.result) };
      }
      return { success: true, output: this.describeRemoteObject(result.result) };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  private describeRemoteObject(obj: any): string {
    if (!obj) return "undefined";
    if (obj.type === "object" && obj.subtype === "error") return obj.description ?? "Error";
    if (obj.value !== undefined) return typeof obj.value === "string" ? obj.value : JSON.stringify(obj.value);
    return obj.description ?? obj.className ?? obj.type ?? "undefined";
  }

  private formatPaused(p: PausedState): string {
    const lines = [`Paused (${p.reason}):`];
    p.callFrames.slice(0, 10).forEach((f, i) => lines.push(`  #${i} ${this.frameLabel(f)}`));
    return lines.join("\n");
  }

  private frameLabel(f: CdpCallFrame): string {
    const url = this.scriptUrls.get(f.location.scriptId) ?? f.location.scriptId;
    return `${f.functionName || "(anonymous)"} (${url}:${f.location.lineNumber + 1})`;
  }

  stackTrace(): { success: boolean; output: string; error?: string } {
    if (!this.isActive) return { success: false, output: "", error: "No active debug session." };
    if (!this.isPaused) return { success: false, output: "", error: "The session is not paused." };
    return { success: true, output: this.formatPaused(this.paused!) };
  }

  scopes(frameIndex = 0): { success: boolean; output: string; error?: string; scopes?: { type: string; objectId?: string }[] } {
    if (!this.isActive) return { success: false, output: "", error: "No active debug session." };
    if (!this.isPaused) return { success: false, output: "", error: "The session is not paused." };
    const frame = this.paused!.callFrames[frameIndex];
    if (!frame) return { success: false, output: "", error: `No stack frame at index ${frameIndex}.` };
    const scopes = frame.scopeChain.map((s) => ({ type: s.type, objectId: s.object.objectId }));
    return { success: true, output: scopes.map((s) => s.objectId ? `${s.type}: ${s.objectId}` : `${s.type} (no variables)`).join("\n"), scopes };
  }

  async variables(objectId: string): Promise<{ success: boolean; output: string; error?: string }> {
    if (!this.isActive) return { success: false, output: "", error: "No active debug session." };
    try {
      const res = await this.send("Runtime.getProperties", { objectId, ownProperties: true });
      const lines = (res.result ?? [])
        .filter((p: any) => p.enumerable !== false)
        .map((p: any) => `${p.name} = ${this.describeRemoteObject(p.value)}`);
      return { success: true, output: lines.length ? lines.join("\n") : "(no properties)" };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }

  threads(): { success: boolean; output: string } {
    return { success: true, output: this.isActive ? "1 thread: main (node is single-threaded here)" : "No active debug session." };
  }

  async terminate(): Promise<{ success: boolean; output: string }> {
    const wasActive = this.isActive;
    try {
      this.ws?.close();
    } catch { /* best-effort */ }
    this.ws = undefined;
    if (this.proc) {
      try {
        this.proc.kill();
      } catch { /* best-effort */ }
    }
    this.proc = undefined;
    this.paused = undefined;
    this.pending.clear();
    const waiters = this.pausedWaiters.splice(0);
    for (const w of waiters) w({ exited: true, code: this.exitCode ?? null });
    return { success: true, output: wasActive ? "Debug session terminated." : "No active debug session." };
  }
}

/** Process-wide singleton — one active debug session (gjc `debug` tool parity). */
export const debugSession = new DebugSession();

// Safety net: never leave a debugged `node` process running past the CLI's own exit.
process.on("exit", () => {
  void debugSession.terminate();
});
