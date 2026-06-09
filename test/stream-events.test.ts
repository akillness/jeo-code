import { test, expect, mock, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

afterEach(() => mock.restore());

test("createStreamEvents: step header + tool target are logged on each step, not just results", () => {
  const lines: string[] = [];
  const ev = createStreamEventsSync(4, s => lines.push(s));

  // engine sequence: onStep then onAssistant (with the invocation) then onToolResult
  ev.onStep!(1);
  ev.onAssistant!("", { tool: "read", arguments: { filePath: "src/agent/engine.ts" } });
  ev.onToolResult!("read", true, "1| ...");
  ev.onStep!(2);
  ev.onAssistant!("", { tool: "bash", arguments: { command: "bun test\nignored" } });
  ev.onToolResult!("bash", false, "exit 1\nSegfault");

  const out = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  // STEP headers with the real tool target — the whole point of the gjc-parity fix
  expect(out).toContain("[step 1/4] read src/agent/engine.ts");
  expect(out).toContain("[step 2/4] bash command");
  // results, with the failing output tail surfaced
  expect(out).toContain("\u2713 read src/agent/engine.ts");
  expect(out).toContain("\u2717 bash command \u2014 exit 1");
});

test("createStreamEvents: 'done' and invalid responses do not emit a step line", () => {
  const lines: string[] = [];
  const ev = createStreamEventsSync(25, s => lines.push(s));
  ev.onStep!(1);
  ev.onAssistant!("", { tool: "done", arguments: { reason: "finished" } });
  ev.onAssistant!("not json", null);
  expect(lines).toEqual([]); // nothing printed for done / non-tool responses
});

// Imported lazily so mock.restore() between suites stays clean.
import { createStreamEvents } from "../src/commands/launch";
function createStreamEventsSync(maxSteps: number, log: (s: string) => void) {
  return createStreamEvents(maxSteps, log);
}

test("end-to-end: a piped one-shot turn prints the per-step flow (not just the final reply)", async () => {
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      if (turn === 1) return JSON.stringify({ tool: "read", arguments: { filePath: "note.txt" } });
      return JSON.stringify({ tool: "done", arguments: { reason: "read complete" } });
    },
  }));

  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-se-cfg-"));
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-se-work-"));
  await fs.writeFile(path.join(workDir, "note.txt"), "hello from note\n");
  const savedCfg = process.env.JOC_CONFIG_DIR;
  const savedCwd = process.cwd();
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logged.push(a.join(" "));
  try {
    process.env.JOC_CONFIG_DIR = cfgDir;
    process.chdir(workDir);
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["read note.txt then done", "--model", "ollama/qwen2.5:0.5b", "--max-steps", "3", "--no-session", "--no-tui"]);
  } finally {
    console.log = origLog;
    process.chdir(savedCwd);
    if (savedCfg === undefined) delete process.env.JOC_CONFIG_DIR; else process.env.JOC_CONFIG_DIR = savedCfg;
    await fs.rm(cfgDir, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
  }

  const out = logged.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  // The whole flow is visible: a step header naming the tool target, then its result.
  expect(out).toContain("[step 1/3] read note.txt");
  expect(out).toMatch(/\u2713 read note\.txt/);
  expect(out).toContain("read complete"); // final reply still printed
});
