import { runMcpServer } from "../mcp";

export async function runMcpCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "serve" || !sub) {
    await runMcpServer();
    return;
  }
  if (sub === "tools") {
    const { TOOLS } = await import("../mcp");
    console.log(`Available jeo-mcp tools (${TOOLS.length}):`);
    for (const t of TOOLS) console.log(`  ${t.name.padEnd(28)} ${t.description}`);
    return;
  }
  console.log(`unknown 'jeo mcp' subcommand: ${sub}`);
  console.log("Usage: jeo mcp [serve|tools]");
  process.exit(1);
}
