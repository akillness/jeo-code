export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly usage?: string;
  readonly loader: () => Promise<(args: string[]) => Promise<void>>;
}

export const COMMANDS: readonly CommandSpec[] = [
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
    summary: "Manage OAuth bearer tokens. sub ∈ {login, logout, status}.",
    usage: "auth [login|logout|status] [provider]",
    loader: async () => {
      const m = await import("../commands/auth");
      return args => m.runAuthCommand(args);
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
    name: "team",
    summary: "Execute the planning blueprint (Executor subagent tools).",
    loader: async () => {
      const m = await import("../commands/team");
      return async () => m.runTeamCommand();
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
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find(c => c.name === name);
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
  lines.push("");
  return lines.join("\n");
}

export async function dispatch(argv: string[], ctx: DispatchContext): Promise<number> {
  const first = argv[0];

  if (first === "--version" || first === "-v") {
    console.log(`${ctx.appName} v${ctx.version}`);
    return 0;
  }
  if (!first || first === "--help" || first === "-h") {
    console.log(renderHelp(ctx));
    return 0;
  }

  const spec = findCommand(first);
  if (!spec) {
    console.log(`Unknown command: ${first}`);
    console.log(renderHelp(ctx));
    return 1;
  }

  const run = await spec.loader();
  await run(argv.slice(1));
  return 0;
}
