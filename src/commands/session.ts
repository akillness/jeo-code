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
  /** Carries the `@jeo-profile` ownership marker set by `jeo --tmux` (gjc `@gjc-profile` parity). */
  owned: boolean;
  /** `@jeo-branch` identity recorded at session creation, when present. */
  branch?: string;
  /** `@jeo-project` (cwd) identity recorded at session creation, when present. */
  project?: string;
}

function printUsage(): void {
  console.log("Usage: jeo session [list] [--json]");
  console.log("       jeo session attach <name>");
  console.log("       jeo session rm/kill <name>");
}

/** Exact-name tmux session target: `=name` is exact-matched (never prefix-matched)
 *  and accepted by attach-session/kill-session on every supported tmux. (Option
 *  commands need the `=name:` form instead — see launch.ts `tmuxProfileCommands`.) */
function exactTarget(name: string): string {
  return `=${name}`;
}

const LIST_FORMAT =
  "#{session_name}\t#{session_created}\t#{session_attached}\t#{@jeo-profile}\t#{@jeo-branch}\t#{@jeo-project}";

async function getJeoSessions(runTmux: RunTmuxFn): Promise<SessionInfo[] | null> {
  try {
    const res = await runTmux(["list-sessions", "-F", LIST_FORMAT]);
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
      const [name, created, attached, marker, branch, project] = parts;
      const owned = marker === "1";
      // Ownership: the `@jeo-profile` marker is authoritative (set by `jeo --tmux`
      // regardless of how the session is named); the `jeo-` name prefix is accepted
      // for directly named sessions.
      if (!owned && !name.startsWith("jeo-")) continue;

      const createdSeconds = parseInt(created, 10);
      const createdIso = isNaN(createdSeconds) ? "" : new Date(createdSeconds * 1000).toISOString();
      sessions.push({
        name,
        created: createdIso,
        attached: attached === "1",
        owned,
        ...(branch ? { branch } : {}),
        ...(project ? { project } : {}),
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
    const sessions = await getJeoSessions(runTmux);
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
      const branchOf = (s: SessionInfo): string => s.branch ?? "";
      const nameWidth = Math.max("Name".length, ...sessions.map(s => s.name.length));
      const createdWidth = Math.max("Created".length, ...sessions.map(s => s.created.length));
      const branchWidth = Math.max("Branch".length, ...sessions.map(s => branchOf(s).length));

      console.log(`${"Name".padEnd(nameWidth)}  ${"Created".padEnd(createdWidth)}  ${"Branch".padEnd(branchWidth)}  Attached`);
      for (const s of sessions) {
        const attachedStr = s.attached ? "yes" : "no";
        console.log(`${s.name.padEnd(nameWidth)}  ${s.created.padEnd(createdWidth)}  ${branchOf(s).padEnd(branchWidth)}  ${attachedStr}`);
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

    const sessions = await getJeoSessions(runTmux);
    const exists = sessions ? sessions.some(s => s.name === name) : false;
    if (!exists) {
      console.log(`Error: Session '${name}' not found.`);
      process.exitCode = 1;
      return;
    }

    const res = await runTmux(["attach", "-t", exactTarget(name)]);
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

    // Ownership gate (gjc parity): the `jeo-` name prefix allows directly,
    // and any session carrying the `@jeo-profile` marker (set by `jeo --tmux`)
    // is jeo-owned regardless of its name. Everything else is refused.
    if (!name.startsWith("jeo-")) {
      const sessions = await getJeoSessions(runTmux);
      const owned = sessions?.some(s => s.name === name && s.owned) ?? false;
      if (!owned) {
        console.log(`Error: Refusing to kill non-jeo session '${name}'.`);
        process.exitCode = 1;
        return;
      }
    }

    const res = await runTmux(["kill-session", "-t", exactTarget(name)]);
    process.exitCode = res.exitCode;
    return;
  }

  // Unknown verb
  console.log(`Unknown subcommand: ${verb}`);
  printUsage();
  process.exitCode = 1;
}
