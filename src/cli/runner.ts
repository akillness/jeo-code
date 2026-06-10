export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly usage?: string;
  readonly loader: () => Promise<(args: string[]) => Promise<void>>;
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "launch",
    summary: "Interactive coding agent.",
    loader: async () => {
      const m = await import("../commands/launch");
      return args => m.runLaunchCommand(args);
    },
  },
  {
    name: "setup",
    summary: "Configure LLM providers.",
    loader: async () => {
      const m = await import("../commands/setup");
      return async () => m.runSetupCommand();
    },
  },
  {
    name: "auth",
    summary: "OAuth login.",
    loader: async () => {
      const m = await import("../commands/auth");
      return args => m.runAuthCommand(args);
    },
  },
  {
    name: "gjc",
    summary: "Execute primary code implementation workflow.",
    loader: async () => {
      const m = await import("../commands/gjc");
      return args => m.runGjcCommand(args);
    },
  },
  {
    name: "evolve-core",
    summary: "[DEV] Trigger joc-centric self-evolution.",
    loader: async () => {
      const m = await import("../agent/dev/evolution-bridge");
      return async () => m.consultGjcForEvolution(process.cwd());
    },
  },
  {
    name: "evolve-adv",
    summary: "[DEV] Trigger advanced architectural evolution.",
    loader: async () => {
      const m = await import("../agent/dev/evolution-bridge");
      return async () => m.consultGjcForAdvancedEvolution(process.cwd());
    },
  },
  {
    name: "status",
    summary: "View evolution tasks and metrics.",
    loader: async () => {
      const m = await import("../commands/status");
      return async () => m.runStatusCommand();
    },
  },
  {
    name: "doctor",
    summary: "Check connectivity.",
    loader: async () => {
      const m = await import("../commands/doctor");
      return args => m.runDoctorCommand(args);
    },
  },
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find(c => c.name === name);
}

export async function dispatch(argv: string[], ctx: { appName: string, version: string }): Promise<number> {
  const first = argv[0];
  if (!first || first.startsWith("-")) {
    const run = await findCommand("launch")!.loader();
    await run(argv);
    return 0;
  }
  const spec = findCommand(first);
  if (!spec) return 1;
  const run = await spec.loader();
  await run(argv.slice(1));
  return 0;
}
