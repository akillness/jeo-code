/**
 * `/orch` slash command handler for the interactive `jeo` TUI.
 * Delegates all state/config/launchd operations to `executeOrchAction`.
 */

import { executeOrchAction } from "../orch";

export interface OrchSlashResult {
  lines: string[];
}

function splitSlashArgs(rest: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

export async function runOrchSlash(
  input: string,
  opts: { orchHome?: string; cwd?: string } = {},
): Promise<OrchSlashResult> {
  const rest = input.slice("/orch".length).trim();
  const args = splitSlashArgs(rest);

  // Never block the interactive TUI with an infinite foreground daemon loop
  if (args[0]?.toLowerCase() === "daemon" && (!args[1] || args[1].startsWith("--"))) {
    return {
      lines: [
        "Foreground daemon cannot run inside the interactive TUI.",
        "Use `/orch daemon install` to start the background launchd service, or run `jeo orch daemon` in a dedicated terminal.",
      ],
    };
  }

  try {
    const res = await executeOrchAction(args, {
      orchHome: opts.orchHome,
      cwd: opts.cwd,
      prefix: "/orch",
      dashboardOnEmpty: true,
    });
    return { lines: res.lines };
  } catch (err) {
    return { lines: [`Error: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

