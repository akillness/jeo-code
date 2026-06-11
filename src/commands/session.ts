import { spawnSync } from "bun";

export type RunTmuxFn = (
  argv: string[]
) => { exitCode: number; stdout: string; stderr: string } | Promise<{ exitCode: number; stdout: string; stderr: string }>;

export const defaultRunTmux: RunTmuxFn = (argv: string[]) => {
  const isAttach = argv[0] === "attach" || argv[0] === "attach-session";
  const proc = Bun.spawnSync(["tmux", ...argv], {
    stdout: isAttach ? "inherit" : "pipe",
    stderr: isAttach ? "inherit" : "pipe",
    stdin: isAttach ? "inherit" : "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout ? proc.stdout.toString() : "",
    stderr: proc.stderr ? proc.stderr.toString() : "",
  };
};

interface SessionInfo {
  name: string;
  created: string;
  attached: boolean;
}

function printUsage(): void {
  console.log("Usage: jeo session [list] [--json]");
  console.log("       jeo session attach <name>");
  console.log("       jeo session rm/kill <name>");
}

async function getJocSessions(runTmux: RunTmuxFn): Promise<SessionInfo[] | null> {
  try {
    const res = await runTmux(["list-sessions", "-F", "#{session_name}\t#{session_created}\t#{session_attached}"]);
    if (res.exitCode !== 0) {
      return null;
    }
    const sessions: SessionInfo[] = [];
    const lines = res.stdout.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split("\t");
      if (parts.length < 3) continue;
      const [name, created, attached] = parts;
      // `jeo-` is the current prefix; `joc-` sessions from pre-rename builds stay manageable.
      if (!name.startsWith("jeo-") && !name.startsWith("joc-")) continue;

      const createdSeconds = parseInt(created, 10);
      const createdIso = isNaN(createdSeconds) ? "" : new Date(createdSeconds * 1000).toISOString();
      sessions.push({
        name,
        created: createdIso,
        attached: attached === "1",
      });
    }
    return sessions;
  } catch {
    return null;
  }
}

export async function runSessionCommand(args: string[]): Promise<void> {
  await runSessionCommandWith(args, defaultRunTmux);
}

export async function runSessionCommandWith(args: string[], runTmux: RunTmuxFn): Promise<void> {
  const isHelp = args.includes("--help") || args.includes("-h");
  if (isHelp) {
    printUsage();
    process.exitCode = 0;
    return;
  }

  const isJson = args.includes("--json");
  const cleanArgs = args.filter(a => a !== "--json");
  const verb = cleanArgs[0];

  if (!verb || verb === "list") {
    const sessions = await getJocSessions(runTmux);
    if (!sessions || sessions.length === 0) {
      if (isJson) {
        console.log("[]");
      } else {
        console.log("No active jeo sessions found.");
      }
      process.exitCode = 0;
      return;
    }

    if (isJson) {
      console.log(JSON.stringify(sessions, null, 2));
    } else {
      const nameWidth = Math.max("Name".length, ...sessions.map(s => s.name.length));
      const createdWidth = Math.max("Created".length, ...sessions.map(s => s.created.length));
      const attachedWidth = "Attached".length;

      console.log(`${"Name".padEnd(nameWidth)}  ${"Created".padEnd(createdWidth)}  Attached`);
      for (const s of sessions) {
        const attachedStr = s.attached ? "yes" : "no";
        console.log(`${s.name.padEnd(nameWidth)}  ${s.created.padEnd(createdWidth)}  ${attachedStr}`);
      }
    }
    process.exitCode = 0;
    return;
  }

  if (verb === "attach") {
    const name = cleanArgs[1];
    if (!name) {
      console.log("Error: Session name required.");
      process.exitCode = 1;
      return;
    }

    const sessions = await getJocSessions(runTmux);
    const exists = sessions ? sessions.some(s => s.name === name) : false;
    if (!exists) {
      console.log(`Error: Session '${name}' not found.`);
      process.exitCode = 1;
      return;
    }

    const res = await runTmux(["attach", "-t", name]);
    process.exitCode = res.exitCode;
    return;
  }

  if (verb === "rm" || verb === "kill") {
    const name = cleanArgs[1];
    if (!name) {
      console.log("Error: Session name required.");
      process.exitCode = 1;
      return;
    }

    if (!name.startsWith("jeo-") && !name.startsWith("joc-")) {
      console.log(`Error: Refusing to kill non-jeo session '${name}'.`);
      process.exitCode = 1;
      return;
    }

    const res = await runTmux(["kill-session", "-t", name]);
    process.exitCode = res.exitCode;
    return;
  }

  // Unknown verb
  console.log(`Unknown subcommand: ${verb}`);
  printUsage();
  process.exitCode = 1;
}
