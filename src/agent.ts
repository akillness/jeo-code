/**
 * jeoc agent — a real LLM coding-agent turn loop, mirroring gjc's agent-core:
 *   build [system + messages + tools] -> call provider -> if tool_calls, run
 *   tools and append results -> repeat until no tool call or maxTurns.
 *
 * Tools: bash, read_file, write_file, list_dir. Zero external dependencies.
 */
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import { resolveConfig, type JeocConfig } from "./config.ts";
import { callProvider, type ChatMessage, type ToolCall, type ToolDef } from "./provider.ts";

const SYSTEM_PROMPT = [
  "You are jeoc, a precise terminal coding agent.",
  "Work in the current directory. Use the provided tools to inspect and modify files and run commands.",
  "Make the smallest change that satisfies the task. Prefer reading before writing.",
  "When the task is done, reply with a short final summary and DO NOT call any more tools.",
].join("\n");

interface Tool extends ToolDef {
  run(args: Record<string, unknown>): string;
}

function truncate(s: string, n = 4000): string {
  return s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s;
}

const TOOLS: Tool[] = [
  {
    name: "bash",
    description: "Run a shell command in the current directory and return combined stdout/stderr.",
    parameters: { type: "object", properties: { cmd: { type: "string", description: "shell command" } }, required: ["cmd"] },
    run(args) {
      const cmd = String(args.cmd ?? "");
      if (!cmd) return "error: missing 'cmd'";
      try {
        return truncate(execSync(cmd, { encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"], shell: "/bin/bash" }) || "(no output)");
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        return truncate(`exit!=0: ${(err.stdout ?? "") + (err.stderr ?? "") || err.message}`);
      }
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file and return its contents.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    run(args) {
      const p = String(args.path ?? "");
      try {
        return truncate(fs.readFileSync(p, "utf8"));
      } catch (e) {
        return `error: ${(e as Error).message}`;
      }
    },
  },
  {
    name: "write_file",
    description: "Write (create/overwrite) a UTF-8 text file with the given content.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    run(args) {
      const p = String(args.path ?? "");
      if (!p) return "error: missing 'path'";
      try {
        fs.writeFileSync(p, String(args.content ?? ""));
        return `wrote ${p} (${String(args.content ?? "").length} bytes)`;
      } catch (e) {
        return `error: ${(e as Error).message}`;
      }
    },
  },
  {
    name: "list_dir",
    description: "List entries of a directory (default '.').",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    run(args) {
      const p = String(args.path ?? ".");
      try {
        return fs.readdirSync(p).join("\n") || "(empty)";
      } catch (e) {
        return `error: ${(e as Error).message}`;
      }
    },
  },
];

const TOOL_DEFS: ToolDef[] = TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));

export interface AgentResult {
  finalText: string;
  turns: number;
  toolRuns: number;
  stopReason: "finished" | "max_turns";
}

export interface AgentOptions {
  task: string;
  overrides?: Partial<JeocConfig>;
  log?: (line: string) => void;
  noTools?: boolean;
}

export async function runAgentLoop(opts: AgentOptions): Promise<AgentResult> {
  const cfg = resolveConfig(opts.overrides);
  const log = opts.log ?? (() => {});
  const tools = opts.noTools ? [] : TOOL_DEFS;
  const messages: ChatMessage[] = [{ role: "user", content: opts.task }];
  let toolRuns = 0;

  for (let turn = 1; turn <= cfg.maxTurns; turn++) {
    const resp = await callProvider(cfg, { system: SYSTEM_PROMPT, messages, tools });

    if (resp.toolCalls.length === 0) {
      if (resp.text) log(`\n${resp.text}`);
      return { finalText: resp.text, turns: turn, toolRuns, stopReason: "finished" };
    }

    // assistant turn that requested tools
    messages.push({ role: "assistant", content: resp.text, toolCalls: resp.toolCalls });
    if (resp.text) log(`\n[turn ${turn}] ${resp.text}`);

    for (const call of resp.toolCalls) {
      const tool = TOOLS.find((t) => t.name === call.name);
      const result = tool ? tool.run(call.args) : `error: unknown tool '${call.name}'`;
      toolRuns++;
      log(`  ↳ ${call.name}(${JSON.stringify(call.args)})\n    ${truncate(result, 500).replace(/\n/g, "\n    ")}`);
      messages.push({ role: "tool", content: result, toolCallId: call.id, toolName: call.name });
    }
  }
  return { finalText: "", turns: cfg.maxTurns, toolRuns, stopReason: "max_turns" };
}

function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = "true";
      else {
        flags[key] = next;
        i++;
      }
    } else positionals.push(a);
  }
  return { positionals, flags };
}

export async function runAgent(argv: string[]): Promise<void> {
  const { positionals, flags } = parseArgs(argv);
  if (positionals[0] === "help" || flags.help === "true" || positionals.length === 0) {
    console.log(
      [
        "jeoc agent — run the LLM coding-agent loop on a task",
        "",
        "  jeoc agent \"<task>\" [--provider P] [--model M] [--max N] [--no-tools] [--dry]",
        "",
        "provider/model resolve from `jeoc config` unless overridden. --dry prints the",
        "resolved config without calling the provider.",
      ].join("\n"),
    );
    return;
  }

  const overrides: Partial<JeocConfig> = {};
  if (flags.provider) overrides.provider = flags.provider as JeocConfig["provider"];
  if (flags.model) overrides.model = flags.model;
  if (flags.max) overrides.maxTurns = Number(flags.max);

  const cfg = resolveConfig(overrides);
  if (flags.dry === "true") {
    console.log(JSON.stringify({ provider: cfg.provider, model: cfg.model, hasApiKey: !!cfg.apiKey, apiKeySource: cfg.apiKeySource, maxTurns: cfg.maxTurns }, null, 2));
    return;
  }
  if (cfg.provider !== "mock" && !cfg.apiKey) {
    console.error(`jeoc agent: provider '${cfg.provider}' needs an API key. Run \`jeoc config show\` for hints.`);
    process.exit(1);
  }

  const task = positionals.join(" ");
  console.log(`jeoc agent [${cfg.provider}/${cfg.model}] task: ${task}`);
  try {
    const res = await runAgentLoop({ task, overrides, log: (l) => console.log(l), noTools: flags["no-tools"] === "true" });
    console.log(`\n— done (${res.stopReason}, turns=${res.turns}, toolRuns=${res.toolRuns})`);
    if (res.stopReason === "max_turns") process.exit(2);
  } catch (e) {
    console.error(`jeoc agent: ${(e as Error).message}`);
    process.exit(1);
  }
}

if (import.meta.main) runAgent(process.argv.slice(2));
