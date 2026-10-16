#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Fixture = {
  models?: string[];
  stdout?: string[];
  stderr?: string[];
  exitCode?: number;
  delayMs?: number;
  splitAt?: number;
  hang?: boolean;
  hangAfterOutput?: boolean;
  readyThenHang?: boolean;
  spawnDescendantMs?: number;
  exitBeforeStdin?: boolean;
};

const cwd = process.cwd();
const scenario = JSON.parse(await readFile(join(cwd, "agy-fixture.json"), "utf8")) as Fixture;
const args = process.argv.slice(2);
const pid = process.pid;
await writeFile(join(cwd, "agy-pid"), String(pid));

const pause = async (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
};
const writeChunks = async (chunks: string[] | undefined): Promise<void> => {
  for (const chunk of chunks ?? []) {
    const bytes = Buffer.from(chunk, "utf8");
    if (scenario.splitAt !== undefined && scenario.splitAt > 0 && scenario.splitAt < bytes.length) {
      process.stdout.write(bytes.subarray(0, scenario.splitAt));
      if (scenario.delayMs) await pause(scenario.delayMs);
      process.stdout.write(bytes.subarray(scenario.splitAt));
    } else {
      process.stdout.write(bytes);
    }
    if (scenario.delayMs) await pause(scenario.delayMs);
  }
};

const writeStderr = async (chunks: string[] | undefined): Promise<void> => {
  for (const chunk of chunks ?? []) {
    process.stderr.write(chunk);
    if (scenario.delayMs) await pause(scenario.delayMs);
  }
};

const keepAlive = async (): Promise<void> => {
  const interval = setInterval(() => {}, 1000);
  const { promise } = Promise.withResolvers<void>();
  process.once("exit", () => clearInterval(interval));
  await promise;
  clearInterval(interval);
};
process.on("SIGTERM", () => {
  void writeFile(join(cwd, "agy-sigterm"), "1");
});

if (args[0] === "models") {
  await writeFile(join(cwd, "agy-observed.json"), JSON.stringify({ args, stdin: "" }));
  await writeChunks(scenario.models?.map(line => `${line}\n`));
  await writeStderr(scenario.stderr);
  process.exit(scenario.exitCode ?? 0);
}

if (scenario.exitBeforeStdin) process.exit(scenario.exitCode ?? 7);

const stdinChunks: Uint8Array[] = [];
for await (const chunk of Bun.stdin.stream()) stdinChunks.push(chunk);
await writeFile(
  join(cwd, "agy-observed.json"),
  JSON.stringify({ args, stdin: Buffer.concat(stdinChunks.map(chunk => Buffer.from(chunk))).toString("utf8") }),
);
await writeFile(join(cwd, "agy-ready"), "1");
if (scenario.spawnDescendantMs !== undefined) {
  Bun.spawn(["sleep", String(scenario.spawnDescendantMs / 1000)], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
}
if (scenario.readyThenHang) await keepAlive();

await writeStderr(scenario.stderr);
await writeChunks(scenario.stdout);
if (scenario.hangAfterOutput || scenario.hang) await keepAlive();
process.exit(scenario.exitCode ?? 0);
