export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly usage?: string;
  readonly loader: () => Promise<(args: string[]) => Promise<void>>;
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "launch",
    summary: "Interactive coding agent (chat + tools). Default when no subcommand is given.",
    usage: "launch [\"one-shot request\"] [--resume [id]] [--list] [--tmux] [--worktree <path>]",
    loader: async () => {
      const m = await import("../commands/launch");
      return args => m.runLaunchCommand(args);
    },
  },
  {
    name: "setup",
    summary: "Configure LLM providers (API key / OAuth / local) + default model.",
    loader: async () => {
      const m = await import("../commands/setup");
      return async () => m.runSetupCommand();
    },
  },
  {
    name: "auth",
    summary: "Real OAuth (PKCE) login + token storage with auto-refresh.",
    usage: "auth [login|logout|refresh|status] [provider] [--token <bearer>]",
    loader: async () => {
      const m = await import("../commands/auth");
      return args => m.runAuthCommand(args);
    },
  },
  {
    name: "export",
    summary: "Export a saved session transcript to Markdown (or --json).",
    usage: "export [id] [--json] [--system]",
    loader: async () => {
      const m = await import("../commands/export");
      return args => m.runExportCommand(args);
    },
  },
  {
    name: "deep-interview",
    summary: "Execute Socratic requirements interview (locks tools while ambiguity > 20%).",
    usage: 'deep-interview "<initial idea>"',
    loader: async () => {
      const m = await import("../commands/deep-interview");
      return args => m.runDeepInterviewCommand(args);
    },
  },
  {
    name: "ralplan",
    summary: "Create planning blueprint (Planner/Architect/Critic).",
    loader: async () => {
      const m = await import("../commands/ralplan");
      return async () => m.runRalplanCommand();
    },
  },
  {
    name: "approve",
    summary: "Approve a planning blueprint.",
    usage: "approve <plan-path>",
    loader: async () => {
      const m = await import("../commands/approve");
      return args => m.runApproveCommand(args);
    },
  },
  {
    name: "team",
    summary: "Execute the planning blueprint (Executor subagent tools).",
    usage: "team [--strict-mutations]",
    loader: async () => {
      const m = await import("../commands/team");
      return args => m.runTeamCommand(args);
    },
  },
  {
    name: "ultragoal",
    summary: "Verify goals and run acceptance checks.",
    loader: async () => {
      const m = await import("../commands/ultragoal");
      return async () => m.runUltragoalCommand();
    },
  },
  {
    name: "doctor",
    summary: "Probe provider connectivity + credentials. Reports if default model is reachable.",
    loader: async () => {
      const m = await import("../commands/doctor");
      return args => m.runDoctorCommand(args);
    },
  },
  {
    name: "mcp",
    summary: "Run jeo as an MCP stdio server (subcommand: serve|tools).",
    usage: "mcp [serve|tools]",
    loader: async () => {
      const m = await import("../commands/mcp");
      return args => m.runMcpCommand(args);
    },
  },
  {
    name: "notify",
    summary: "Configure/inspect remote subagent notifications over Telegram (gjc notify parity).",
    usage: "notify [setup [--token <t> --chat-id <id>]|status]",
    loader: async () => {
      const m = await import("../commands/notify");
      return args => m.runNotifyCommand(args);
    },
  },
  {
    name: "daemon",
    summary: "Manage the background Telegram notification/subagent-control daemon.",
    usage: "daemon [status|start|stop|reload]",
    loader: async () => {
      const m = await import("../commands/daemon");
      return args => m.runDaemonCommand(args);
    },
  },
  {
    name: "routine",
    summary: "Generate a GitHub Actions workflow that runs jeo headlessly on a schedule or repo event.",
    usage: 'routine init --trigger <schedule|issues|pull_request> --prompt "<task>" [--cron <expr>] [--name <name>] [--out <path>] [--no-pr] [--force] [--dry-run] [--json]',
    loader: async () => {
      // Dynamic import: lazy-loaded command registry entry (CommandSpec.loader
      // contract), matching every other entry in this array — avoids eagerly
      // importing all ~25 command modules at CLI startup.
      const m = await import("../commands/routine");
      return args => m.runRoutineCommand(args);
    },
  },

  {
    name: "skills",
    summary: "List bundled workflow skills, or sync them into ~/.jeo/skills (jeo skills <name> for details).",
    usage: "skills [list|read <name>|sync [--check|--force] [dir]|--write [dir]|lesson <skill> <failure|anti-pattern> \"<title>\" \"<detail>\"|eval <skill>] [--json]",
    loader: async () => {
      const m = await import("../commands/skills");
      return args => m.runSkillsCommand(args);
    },
  },
  {
    name: "resume",
    summary: "Resume the latest interactive session (or 'jeo resume <id>').",
    usage: "resume [id]",
    loader: async () => {
      const m = await import("../commands/resume");
      return args => m.runResumeCommand(args);
    },
  },
  {
    name: "chat",
    summary: "Single-shot streaming chat (no tools) — renders the reply token-by-token.",
    usage: "chat \"<message>\"",
    loader: async () => {
      const m = await import("../commands/chat");
      return args => m.runChatCommand(args);
    },
  },
  {
    name: "evolve",
    summary: "Preview the evolution TUI identity (ASCII art + track + meter per stage).",
    usage: "evolve [--step N] [--max M] [--animate] [--no-color]",
    loader: async () => {
      const m = await import("../commands/evolve");
      return args => m.runEvolveCommand(args);
    },
  },
  {
    name: "memory-distill",
    summary: "(internal) Background session-memory distillation worker spawned on exit.",
    usage: "memory-distill <payload.json>",
    loader: async () => {
      const m = await import("../agent/memory");
      return args => m.runMemoryDistillCommand(args);
    },
  },
  {
    name: "memory-migrate",
    summary: "Migrate a legacy MEMORY.md into the OKF concept bundle (one-shot, idempotent).",
    usage: "memory-migrate",
    loader: async () => {
      const m = await import("../commands/memory-migrate");
      return args => m.runMemoryMigrateCommand(args);
    },
  },
  {
    name: "notify-daemon-run",
    summary: "(internal) Foreground worker for the Telegram notification daemon, spawned by 'jeo daemon start'.",
    usage: "notify-daemon-run",
    loader: async () => {
      const m = await import("../agent/notify/telegram-daemon");
      return async () => m.runNotifyDaemonForeground();
    },
  },

  {
    name: "state",
    summary: "Read or update workflow state receipts under .jeo/state (gjc-state parity).",
    usage: "state <deep-interview|ralplan|team|ultragoal> <read|write|clear|handoff> [--input '<json>'] [--to <skill>] [--json]",
    loader: async () => {
      const m = await import("../commands/state");
      return args => m.runStateCommand(args);
    },
  },
  {
    name: "session",
    summary: "List, attach, or remove jeo-managed tmux sessions.",
    usage: "session [list|attach <name>|rm <name>] [--json]",
    loader: async () => {
      const m = await import("../commands/session");
      return args => m.runSessionCommand(args);
    },
  },
  {
    name: "update",
    summary: "Update jeo-code to the latest npm release (bare = install; --check only checks).",
    usage: "update [--check|--install] [--json] [--strict]",
    loader: async () => {
      const m = await import("../commands/update");
      return args => m.runUpdateCommand(args);
    },
  },
  {
    name: "whats-new",
    summary: "Show the release notes bundled with the installed jeo-code version.",
    usage: "whats-new [--all] [--json]",
    loader: async () => {
      const m = await import("../commands/whats-new");
      return args => m.runWhatsNewCommand(args);
    },
  },
  {
    name: "ooo-seed",
    summary: "Generate an immutable ooo seed from a specification (spec-first automation).",
    usage: "ooo-seed [args]",
    loader: async () => {
      const m = await import("../commands/ooo-seed");
      return args => m.runOooSeedCommand(args);
    },
  },
  {
    name: "status",
    summary: "Show evolution status + engine performance metrics.",
    loader: async () => {
      const m = await import("../commands/status");
      return async () => m.runStatusCommand();
    },
  },
  {
    name: "evolve-core",
    summary: "Trigger a self-evolution turn using gjc as a guide (Dev Mode).",
    usage: "evolve-core [args]",
    loader: async () => {
      const m = await import("../commands/evolve-core");
      return args => m.runEvolveCoreCommand(args);
    },
  },
  {
    name: "autopilot",
    summary: "Autonomous build loop (autopilot × autoresearch ratchet).",
    usage: "autopilot <subcommand> [flags]",
    loader: async () => {
      const m = await import("../autopilot");
      return args => Promise.resolve(m.runAutopilot(args));
    },
  },
  {
    name: "ledger",
    summary: "Cross-plan append-only ledger (ledger / review / cleanup).",
    usage: "ledger <subcommand> [flags]",
    loader: async () => {
      const m = await import("../ledger");
      return args => Promise.resolve(m.runLedger(args));
    },
  },
  {
    name: "computer",
    summary: "Execute desktop automation actions (screenshot, click, type, keypress, scroll, drag, wait, batch).",
    usage: "computer <action> [args]",
    loader: async () => {
      const m = await import("../commands/computer");
      return args => m.runComputerCommand(args);
    },
  },
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find(c => c.name === name);
}

/** Levenshtein edit distance (small inputs; iterative two-row DP). */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/** Suggest near-miss command names for an unknown input (prefix match or ≤2 edits). */
export function suggestCommands(name: string): string[] {
  const q = name.toLowerCase();
  if (!q) return [];
  return COMMANDS.map(c => c.name).filter(n => n.startsWith(q) || editDistance(n, q) <= 2);
}

export interface DispatchContext {
  appName: string;
  version: string;
}

export function renderHelp(ctx: DispatchContext): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`=== @jeo-code CLI (${ctx.appName}) ===`);
  lines.push("Clean, highly optimized AI coding agent using a Socratic spec-first loop.");
  lines.push("");
  lines.push("Usage:");
  lines.push(`  ${ctx.appName} <command> [arguments]`);
  lines.push("");
  lines.push("Commands:");
  const width = Math.max(...COMMANDS.map(c => (c.usage ?? c.name).length));
  for (const c of COMMANDS) {
    const label = (c.usage ?? c.name).padEnd(width);
    lines.push(`  ${label}   ${c.summary}`);
  }
  lines.push("");
  lines.push("Options:");
  lines.push("  -v, --version    Show version.");
  lines.push("  -h, --help       Show help.");
  lines.push("      --model <id>             Use a session model for launch/one-shot.");
  lines.push("      --provider <name>        Start launch on a provider default (anthropic/openai/gemini/antigravity/ollama).");
  lines.push("      --smol|--slow|--plan     Start launch with the configured model role tier.");
  lines.push("      --thinking <level>       Set thinking budget (low/medium/high/xhigh).");
  lines.push("");
  return lines.join("\n");
}

export function renderCommandHelp(spec: CommandSpec, ctx: DispatchContext): string {
  return [
    "",
    `Usage: ${ctx.appName} ${spec.usage ?? spec.name}`,
    "",
    spec.summary,
    "",
  ].join("\n");
}

const VALUE_FLAGS = new Set(["--worktree", "--model", "--provider", "--thinking", "--max-steps", "--append-system-prompt", "--skills", "--tools", "--system-prompt"]);
const OPTIONAL_UUID_FLAGS = new Set(["--resume", "--continue", "-c"]);
const VALUE_PREFIXES = ["--worktree=", "--model=", "--provider=", "--thinking=", "--max-steps=", "--append-system-prompt=", "--skills=", "--tools=", "--system-prompt="];
const LAUNCH_ONLY_FLAGS = new Set(["--tmux", "--no-tui", "--no-session", "--list", "--smol", "--slow", "--plan", "-p", "--print", "--no-skills", "--no-tools"]);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function flagName(arg: string): string {
  const eq = arg.indexOf("=");
  return eq === -1 ? arg : arg.slice(0, eq);
}


function leadingGlobalFlag(argv: string[], targets: readonly string[]): boolean {
  const wanted = new Set(targets);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") break;
    const name = flagName(a);
    if (wanted.has(a) || wanted.has(name)) return true;
    if (LAUNCH_ONLY_FLAGS.has(name)) continue;
    if (VALUE_FLAGS.has(name) || VALUE_PREFIXES.some(prefix => a.startsWith(prefix))) {
      if (!a.includes("=") && argv[i + 1] && !argv[i + 1]!.startsWith("-")) i++;
      continue;
    }
    if (OPTIONAL_UUID_FLAGS.has(name)) {
      if (argv[i + 1] && UUID_REGEX.test(argv[i + 1]!)) i++;
      continue;
    }
    break;
  }
  return false;
}
export async function dispatch(argv: string[], ctx: DispatchContext): Promise<number> {
  const first = argv[0];

  if (first === "--version" || first === "-v") {
    console.log(`${ctx.appName} v${ctx.version}`);
    return 0;
  }
  if (first === "--help" || first === "-h") {
    console.log(renderHelp(ctx));
    return 0;
  }
  if (leadingGlobalFlag(argv, ["--version", "-v"])) {
    console.log(`${ctx.appName} v${ctx.version}`);
    return 0;
  }
  if (leadingGlobalFlag(argv, ["--help", "-h"])) {
    console.log(renderHelp(ctx));
    return 0;
  }
  // Bare invocation or a leading global flag (e.g. `jeo`, `jeo --tmux`,
  // `jeo --tmux --worktree <path>`) routes to the interactive agent — gjc parity.
  if (!first || first.startsWith("-")) {
    const run = await findCommand("launch")!.loader();
    await run(argv);
    return 0;
  }

  const spec = findCommand(first);
  if (!spec) {
    console.log(`Unknown command: ${first}`);
    const near = suggestCommands(first);
    if (near.length) console.log(`Did you mean: ${near.join(", ")}?`);
    console.log(renderHelp(ctx));
    return 1;
  }

  // Per-command help: `jeo <cmd> --help`.
  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(renderCommandHelp(spec, ctx));
    return 0;
  }

  const run = await spec.loader();
  await run(rest);
  return 0;
}
