import { runCli } from "../../packages/jeo-mem/src/cli";

export async function runJeoxCommand(args: string[]): Promise<void> {
  const code = await runCli(args);
  if (code !== 0) process.exit(code);
}
