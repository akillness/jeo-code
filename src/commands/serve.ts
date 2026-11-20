/**
 * `jeo serve` — Run inbound HTTP Agent Server
 * Provides OpenAI-compatible chat completions and GoalFlow native workflow run/resume APIs.
 */

import chalk from "chalk";
import { createAgentServer, type AgentServerOptions } from "../server/agent-api";
import type { JeoWorkflowMode } from "../agent/goalflow";

export interface ServeCliOptions {
  port: number;
  host: string;
  model: string;
  workflow: JeoWorkflowMode;
  autoApprove: boolean;
  qevUrl?: string;
  jevGuard: boolean;
  contextWindow?: number;
  maxSteps?: number;
  help: boolean;
}

export function parseServeArgs(args: string[]): ServeCliOptions {
  const opts: ServeCliOptions = {
    port: 8000,
    host: "127.0.0.1",
    model: "jeo-coding",
    workflow: "coding",
    autoApprove: false,
    jevGuard: true,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--help" || a === "-h") {
      opts.help = true;
    } else if (a === "--port" || a === "-p") {
      const val = Number.parseInt(args[++i] ?? "", 10);
      if (Number.isFinite(val) && val > 0) opts.port = val;
    } else if (a.startsWith("--port=")) {
      const val = Number.parseInt(a.slice("--port=".length), 10);
      if (Number.isFinite(val) && val > 0) opts.port = val;
    } else if (a === "--host") {
      if (args[i + 1]) opts.host = args[++i]!;
    } else if (a.startsWith("--host=")) {
      opts.host = a.slice("--host=".length);
    } else if (a === "--model" || a === "-m") {
      if (args[i + 1]) opts.model = args[++i]!;
    } else if (a.startsWith("--model=")) {
      opts.model = a.slice("--model=".length);
    } else if (a === "--workflow" || a === "-w") {
      const wf = (args[++i] ?? "").toLowerCase();
      if (wf === "spec-first" || wf === "coding") opts.workflow = wf;
    } else if (a.startsWith("--workflow=")) {
      const wf = a.slice("--workflow=".length).toLowerCase();
      if (wf === "spec-first" || wf === "coding") opts.workflow = wf;
    } else if (a === "--auto-approve") {
      opts.autoApprove = true;
    } else if (a === "--no-jev-guard") {
      opts.jevGuard = false;
    } else if (a === "--qev-url" && args[i + 1]) {
      opts.qevUrl = args[++i];
    } else if (a.startsWith("--qev-url=")) {
      opts.qevUrl = a.slice("--qev-url=".length);
    } else if (a === "--context-window" && args[i + 1]) {
      const parsed = Number.parseInt(args[++i]!, 10);
      if (Number.isFinite(parsed) && parsed > 0) opts.contextWindow = parsed;
    } else if (a.startsWith("--context-window=")) {
      const parsed = Number.parseInt(a.slice("--context-window=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) opts.contextWindow = parsed;
    } else if (a === "--max-steps" && args[i + 1]) {
      const parsed = Number.parseInt(args[++i]!, 10);
      if (Number.isFinite(parsed) && parsed > 0) opts.maxSteps = parsed;
    } else if (a.startsWith("--max-steps=")) {
      const parsed = Number.parseInt(a.slice("--max-steps=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) opts.maxSteps = parsed;
    }
  }

  return opts;
}

export function printServeHelp(): void {
  console.log(`
${chalk.bold("jeo serve")} — Inbound HTTP Agent Server (OpenAI-compatible & GoalFlow)

${chalk.bold("USAGE:")}
  jeo serve [flags]

${chalk.bold("FLAGS:")}
  -p, --port <number>         Port to listen on (default: 8000)
      --host <string>         Hostname to bind (default: 127.0.0.1)
  -m, --model <string>        Default model alias (default: jeo-coding)
  -w, --workflow <mode>       Default workflow: 'coding' | 'spec-first' (default: coding)
      --auto-approve          Auto-approve approval checkpoints without pausing
      --no-jev-guard          Disable Jev semantic runtime validation guard
      --qev-url <url>         Custom endpoint for Jev/Qev model
      --context-window <num>  Maximum token budget per turn
      --max-steps <num>       Maximum recursion loop iterations
  -h, --help                  Show this help message

${chalk.bold("ENDPOINTS:")}
  POST /v1/chat/completions   OpenAI-compatible chat completion (streaming SSE & JSON)
  POST /v1/workflows/run      Native GoalFlow workflow execution with event stream
  POST /v1/workflows/resume   Human-In-The-Loop checkpoint resumption
  GET  /v1/models             List available model engines & workflows
  GET  /health, /             Healthcheck and engine status
`);
}

export async function runServeCommand(args: string[]): Promise<void> {
  const opts = parseServeArgs(args);
  if (opts.help) {
    printServeHelp();
    return;
  }

  const serverOpts: AgentServerOptions = {
    port: opts.port,
    hostname: opts.host,
    defaultModel: opts.model,
    defaultWorkflow: opts.workflow,
    autoApprove: opts.autoApprove,
    jevGuard: opts.jevGuard,
    qevUrl: opts.qevUrl,
    contextWindow: opts.contextWindow,
    maxSteps: opts.maxSteps,
  };

  const instance = createAgentServer(serverOpts);

  console.log(`\n${chalk.bold.cyan("✦ jeo-code GoalFlow Inbound Agent Server")}`);
  console.log(`  ${chalk.dim("Listening on:")}      ${chalk.green(instance.url)}`);
  console.log(`  ${chalk.dim("Default Model:")}    ${chalk.yellow(opts.model)}`);
  console.log(`  ${chalk.dim("Default Workflow:")} ${chalk.magenta(opts.workflow)}`);
  console.log(`  ${chalk.dim("Auto-Approve:")}     ${opts.autoApprove ? chalk.yellow("enabled") : chalk.dim("disabled")}`);
  console.log(`  ${chalk.dim("Jev Guard:")}        ${opts.jevGuard ? chalk.green("active") : chalk.red("disabled")}`);
  console.log(`\n${chalk.dim("Endpoints:")}`);
  console.log(`  ${chalk.cyan("POST")} ${instance.url}/v1/chat/completions`);
  console.log(`  ${chalk.cyan("POST")} ${instance.url}/v1/workflows/run`);
  console.log(`  ${chalk.cyan("POST")} ${instance.url}/v1/workflows/resume`);
  console.log(`  ${chalk.cyan("GET ")} ${instance.url}/v1/models`);
  console.log(`  ${chalk.cyan("GET ")} ${instance.url}/health\n`);
  console.log(chalk.dim("Press Ctrl+C to stop the server.\n"));

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      console.log(`\n${chalk.dim("Shutting down jeo serve...")}`);
      instance.close();
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
