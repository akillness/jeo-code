import { runLaunchCommand } from "./launch";

/** `joc resume [id]` — resume the latest (or a specific) interactive session. */
export async function runResumeCommand(args: string[] = []): Promise<void> {
  return runLaunchCommand(["--resume", ...args]);
}
