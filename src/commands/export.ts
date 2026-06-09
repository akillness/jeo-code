import { exportSession, latestSessionId } from "../agent/session";

/**
 * `joc export [id] [--json] [--system]` — print a saved session transcript
 * (Markdown by default; `--json` for structured; `--system` to include system
 * messages). Defaults to the latest session when no id is given.
 */
export async function runExportCommand(args: string[] = []): Promise<void> {
  const format: "markdown" | "json" = args.includes("--json") ? "json" : "markdown";
  const includeSystem = args.includes("--system");
  const id = args.find(a => !a.startsWith("--")) ?? (await latestSessionId());
  if (!id) {
    console.log("No session to export. Pass a session id or run a session first.");
    return;
  }
  try {
    console.log(await exportSession(id, format, process.cwd(), { includeSystem }));
  } catch (err) {
    console.log(`Could not export session ${id}: ${(err as Error).message}`);
  }
}
