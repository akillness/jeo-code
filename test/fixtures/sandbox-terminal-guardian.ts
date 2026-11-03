import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const command = process.argv.slice(2);
const binary = process.env.JEO_TEST_CLI_BINARY;
if (binary !== undefined) {
  if (!path.isAbsolute(binary)) throw new Error("JEO_TEST_CLI_BINARY must be an absolute executable path");
  await fs.access(binary, constants.X_OK);
  command.splice(0, 2, binary);
}

// Keep the PTY leader alive until cleanup; SIGTERM lets launch revoke its real sandbox first.
const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null) child.kill("SIGTERM");
  await child.exited;
  process.exit(0);
};
process.on("message", message => { if (message === "stop") void stop(); });
process.on("disconnect", () => { void stop(); });
const exitCode = await child.exited;
process.send?.({ type: "exit", exitCode });
if (!stopping) await Promise.withResolvers<void>().promise;
