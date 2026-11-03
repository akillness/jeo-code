import type { Subprocess } from "bun";
import * as path from "node:path";
import { DEFAULT_TOOLS } from "../engine";
import type { ToolHandler } from "../engine";
import { executeComputerAction } from "../../commands/computer";
import { computerSupervisor } from "../computer-supervisor";
import { assertBashAllowed } from "../tools";
import { JobRegistry } from "../job-registry";
import { MonitorRegistry } from "../monitor-registry";
import { createJobTool } from "../job-tool";
import { createMonitorTool } from "../monitor-tool";
import { createGoalTool } from "../goal-tool";
import { createApproveTool } from "../approve-tool";
import { createWorkflowStateTool } from "../state";
import type { ToolResult } from "../tools";
import { encodeHandsFrame, MAX_FRAME_BYTES, parseHandsRequest, parseHandsResponse, readHandsFrames } from "./rpc";
import type { SandboxExecResult } from "./types";

// This kernel is not a sandbox. Its process and every descendant live INSIDE the OS container.
const EVAL_BOOTSTRAP = `
import {createInterface} from "node:readline";
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const format = value => typeof value === "string" ? value : (() => { try { return JSON.stringify(value) ?? String(value); } catch { return String(value); } })();
for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
  const {id,code,cwd,limit} = JSON.parse(line);
  const logs=[];
  let bytes=0;
  const log=(...values)=>{const text=values.map(format).join(" ");bytes+=Buffer.byteLength(text,"utf8")+1;if(bytes>limit)throw new Error("eval output size limit exceeded");logs.push(text);};
  let result;
  try {
    process.chdir(cwd);
    const value=await new AsyncFunction("log","print","display","console",code)(log,log,log,{log,info:log,warn:log,error:log,debug:log});
    if(value!==undefined)log(value);
    result={success:true,output:logs.join("\\n")||"(eval completed with no output)"};
  } catch(error) {result={success:false,output:"",error:"eval failed: "+String(error?.message??error)};}
  process.stdout.write(JSON.stringify({id,type:"result",result})+"\\n");
}
`;

export interface HandsWorkerOptions {
  input: ReadableStream<Uint8Array>;
  output: (line: string) => void | Promise<void>;
  cwd: string;
}

export async function runHandsWorker(options: HandsWorkerOptions): Promise<void> {
  const jobs = new JobRegistry();
  const monitors = new MonitorRegistry();
  let kernel: { process: Subprocess<"pipe", "pipe", "pipe">; frames: AsyncGenerator<unknown> } | undefined;
  const evaluate: ToolHandler = async (args, cwd): Promise<ToolResult> => {
    if (typeof args.code !== "string" || !args.code.trim()) return { success: false, output: "", error: "eval requires a code body" };
    try { await assertBashAllowed(cwd); }
    catch (error) { return { success: false, output: "", error: String(error) }; }
    if (!kernel || kernel.process.exitCode !== null) {
      const child = Bun.spawn([process.execPath, "-e", EVAL_BOOTSTRAP], { cwd, env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      kernel = { process: child, frames: readHandsFrames(child.stdout) };
      void (async () => {
        const reader = child.stderr.getReader();
        try { while (!(await reader.read()).done) { /* User stderr cannot create an unbounded parent buffer. */ } }
        finally { reader.releaseLock(); }
      })().catch(() => {});
    }
    const current = kernel;
    const id = crypto.randomUUID();
    const timeoutMs = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
      ? Math.min(args.timeoutMs, 1_800_000) : 300_000;
    const timeout = Promise.withResolvers<ToolResult>();
    const timer = setTimeout(() => {
      current.process.kill("SIGKILL");
      if (kernel === current) kernel = undefined;
      timeout.resolve({ success: false, output: "", error: "eval execution timed out" });
    }, timeoutMs);
    try {
      // The outer request is byte-bounded already; this private child envelope adds trusted cwd metadata.
      await current.process.stdin.write(`${JSON.stringify({ id, code: args.code, cwd, limit: Math.floor(MAX_FRAME_BYTES / 2) })}\n`);
      await current.process.stdin.flush();
      const response = (async (): Promise<ToolResult> => {
        const frame = await current.frames.next();
        if (frame.done) throw new Error("eval child closed without a result");
        const parsed = parseHandsResponse(frame.value);
        if (parsed.id !== id || parsed.type !== "result") throw new Error("eval child returned an invalid result identity");
        return parsed.result;
      })();
      return await Promise.race([response, timeout.promise]);
    } catch (error) {
      current.process.kill("SIGKILL");
      if (kernel === current) kernel = undefined;
      return { success: false, output: "", error: `eval child failed: ${String(error)}` };
    } finally { clearTimeout(timer); }
  };
  const tools: Record<string, ToolHandler> = {
    ...DEFAULT_TOOLS,
    eval: evaluate,
    job: createJobTool(jobs),
    monitor: createMonitorTool(monitors),
    goal: createGoalTool(),
    // Private (not a model tool): consent comes only from the trusted parent wrapper.
    __computer: async (args): Promise<ToolResult> => {
      if (typeof args.enabled !== "boolean") return { success: false, output: "", error: "__computer requires boolean enabled" };
      if (!args.action || typeof args.action !== "object" || Array.isArray(args.action)) return { success: false, output: "", error: "Expected a computer action object." };
      computerSupervisor.setKillSwitchLive(true);
      computerSupervisor.heartbeat();
      return executeComputerAction(args.action as any, { enabledOverride: args.enabled });
    },
    __plan_approve: createApproveTool(),
    __workflow: createWorkflowStateTool(),
  };
  const output = async (id: string, result: SandboxExecResult): Promise<void> => {
    let frame: string;
    try { frame = encodeHandsFrame({ id, type: "result", result }); }
    catch { frame = encodeHandsFrame({ id, type: "result", result: { success: false, output: "", error: "SANDBOX_PROTOCOL: tool output size limit exceeded", mutationMayHaveOccurred: true } }); }
    await options.output(frame);
  };

  const exec = async (argv: string[], cwd: string, env?: Record<string, string>, stdin?: string): Promise<SandboxExecResult> => {
    await assertBashAllowed(cwd);
    const child = Bun.spawn(argv, { cwd, env: { ...process.env, ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const capture = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > Math.floor((MAX_FRAME_BYTES - 4096) / 4)) { child.kill(); throw new Error("sandbox exec output limit exceeded"); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      return Buffer.concat(chunks).toString("utf8");
    };
    const reads = Promise.all([capture(child.stdout), capture(child.stderr), child.exited]);
    if (stdin !== undefined) await child.stdin.write(stdin);
    await child.stdin.end();
    const [stdout, stderr, exitCode] = await reads;
    return { success: exitCode === 0, output: `${stdout}${stderr}`, stdout, stderr, exitCode, timedOut: false, aborted: false, ...(exitCode !== 0 ? { error: `Command exited ${exitCode}`, mutationMayHaveOccurred: true } : {}) };
  };

  try {
    for await (const frame of readHandsFrames(options.input)) {
      const request = parseHandsRequest(frame);
      let result: SandboxExecResult;
      try {
        if (request.type === "exec") {
          result = await exec(request.argv, request.cwd ? path.resolve(options.cwd, request.cwd) : options.cwd, request.env, request.stdin);
        } else if (!Object.hasOwn(tools, request.tool)) {
          result = { success: false, output: "", error: `Unknown or unavailable hands tool: ${request.tool}` };
        } else {
          result = await tools[request.tool]!(request.args, request.cwd ? path.resolve(options.cwd, request.cwd) : options.cwd, partial => {
            try { void options.output(encodeHandsFrame({ id: request.id, type: "progress", text: partial })); }
            catch { /* The bounded final result reports oversized output; progress is cosmetic. */ }
          });
        }
      } catch (error) { result = { success: false, output: "", error: String(error), mutationMayHaveOccurred: true }; }
      await output(request.id, result);
    }
  } finally {
    if (kernel) { kernel.process.kill("SIGKILL"); await kernel.process.exited; }
    jobs.cancelAll();
    monitors.cancelAll();
  }
}

if (import.meta.main) {
  if (process.env.JEO_SANDBOX_HANDS !== "1") throw new Error("Hands runtime requires its isolated backend");
  await runHandsWorker({ input: Bun.stdin.stream(), output: line => { process.stdout.write(line); }, cwd: process.cwd() });
}
