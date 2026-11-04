
import { logEvolution } from "../src/agent/dev/evolution-logger";

async function main() {
  const entry = {
    timestamp: new Date().toISOString(),
    target: "jeo-claw: Discord command error messages",
    request: "Improve Discord command validation error messages for autonomy, scaleout, and provider",
    status: "success" as const,
    verificationOutput: "bun test discord/commands.test.ts passed. scripts/smoke-discord.ts verified."
  };

  await logEvolution(entry);
  console.log("Logged evolution entry to .joc/state/evolution-log.json");
}

main().catch(console.error);
