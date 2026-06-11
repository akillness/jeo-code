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
  expect(out).toMatch(/\[step 1\/4\] [Rr]ead\s*:?\s*src\/agent\/engine\.ts/);
  expect(out).toContain("[step 2/4] bash command");
  // results, with the failing output tail surfaced
  expect(out).toMatch(/\u2713 [Rr]ead\s*:?\s*src\/agent\/engine\.ts/);
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
import { createStreamEvents, formatTaskSubEvent } from "../src/commands/launch";
function createStreamEventsSync(maxSteps: number, log: (s: string) => void) {
  return createStreamEvents(maxSteps, log);
}

test("formatTaskSubEvent treats only explicit false as incomplete", () => {
  const out = formatTaskSubEvent({ kind: "done", role: "executor", detail: "ok" }).replace(/\x1b\[[0-9;]*m/g, "");
  expect(out).toContain("[AGENT]");
  expect(out).toContain("done: ok");
  expect(out).not.toContain("(incomplete)");
});

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
  expect(out).toMatch(/\[step 1\/3\] [Rr]ead\s*:?\s*note\.txt/);
  expect(out).toMatch(/\u2713 [Rr]ead\s*:?\s*note\.txt/);
  expect(out).toContain("read complete"); // final reply still printed
});

test("end-to-end: cmd-mode task subagent prints nested steps and result summaries", async () => {
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      if (turn === 1) return JSON.stringify({ tool: "task", arguments: { role: "executor", task: "inspect note.txt" } });
      if (turn === 2) return JSON.stringify({ tool: "read", arguments: { filePath: "note.txt" } });
      if (turn === 3) return JSON.stringify({ tool: "done", arguments: { reason: "subagent read it\nSummary:\nChanged Files:\nVerification:" } });
      return JSON.stringify({ tool: "done", arguments: { reason: "parent integrated" } });
    },
  }));

  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-se-sub-cfg-"));
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-se-sub-work-"));
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
    await runLaunchCommand(["delegate to a subagent", "--model", "ollama/qwen2.5:0.5b", "--max-steps", "4", "--no-session", "--no-tui"]);
  } finally {
    console.log = origLog;
    process.chdir(savedCwd);
    if (savedCfg === undefined) delete process.env.JOC_CONFIG_DIR; else process.env.JOC_CONFIG_DIR = savedCfg;
    await fs.rm(cfgDir, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
  }

  const out = logged.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  expect(out).toMatch(/\[step 1\/4\] [Tt]ask\s*:?\s*executor/);
  expect(out).toContain("▸ [executor] inspect note.txt");
  expect(out).toContain("[executor step 1/15] read note.txt");
  expect(out).toContain("[executor] ✓ read note.txt — 1|hello from note");
  expect(out).toContain("◂ [executor] done: subagent read it");
  expect(out).toMatch(/\u2713 [Tt]ask\s*:?\s*executor \u2014 \[Executor subagent\] completed/);
  expect(out).toContain("[AGENT]"); // nested subagent lines carry the category badge
  expect(out).toContain("[STEP]"); // parent step lines carry the progress badge
  expect(out).toContain("[DONE]"); // successful tool results carry the completed badge
  expect(out).toContain("parent integrated");
});

test("end-to-end: a disk-persisted subagent model override is the model the in-loop task tool uses", async () => {
  let turn = 0;
  const subagentModels: (string | undefined)[] = [];
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (_msgs: unknown, options: { model?: string } = {}) => {
      turn++;
      // turn 1: parent delegates. turns 2-3: subagent works + done. turn 4: parent done.
      if (turn === 1) return JSON.stringify({ tool: "task", arguments: { role: "executor", task: "inspect note.txt" } });
      if (turn === 2) { subagentModels.push(options.model); return JSON.stringify({ tool: "read", arguments: { filePath: "note.txt" } }); }
      if (turn === 3) { subagentModels.push(options.model); return JSON.stringify({ tool: "done", arguments: { reason: "ok\nSummary:\nChanged Files:\nVerification:" } }); }
      return JSON.stringify({ tool: "done", arguments: { reason: "parent done" } });
    },
  }));

  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-se-ovr-cfg-"));
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-se-ovr-work-"));
  await fs.writeFile(path.join(workDir, "note.txt"), "hello\n");
  // Persist a per-role override so a DIFFERENT provider/model is pinned for executor.
  await fs.writeFile(
    path.join(cfgDir, "config.json"),
    JSON.stringify({ defaultModel: "ollama/qwen2.5:0.5b", subagents: { executor: { model: "anthropic/claude-haiku-4-5" } } }),
  );
  const savedCfg = process.env.JOC_CONFIG_DIR;
  const savedCwd = process.cwd();
  const origLog = console.log;
  console.log = () => {};
  try {
    process.env.JOC_CONFIG_DIR = cfgDir;
    process.chdir(workDir);
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["delegate", "--model", "ollama/qwen2.5:0.5b", "--max-steps", "4", "--no-session", "--no-tui"]);
  } finally {
    console.log = origLog;
    process.chdir(savedCwd);
    if (savedCfg === undefined) delete process.env.JOC_CONFIG_DIR; else process.env.JOC_CONFIG_DIR = savedCfg;
    await fs.rm(cfgDir, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
  }

  // The delegated subagent must run on the pinned override, NOT the parent default.
  expect(subagentModels.length).toBeGreaterThan(0);
  expect(subagentModels.every(m => m === "anthropic/claude-haiku-4-5")).toBe(true);
});


test("end-to-end: one-shot skill alias executes configured skill instead of chatting about it", async () => {
  let seenUser = "";
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (messages: Array<{ role: string; content: string }>) => {
      seenUser = messages.at(-1)?.content ?? "";
      return JSON.stringify({ tool: "done", arguments: { reason: "skill executed" } });
    },
  }));

  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-se-skill-cfg-"));
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-se-skill-work-"));
  await fs.mkdir(path.join(cfgDir, "skills", "spec-kit"), { recursive: true });
  await fs.writeFile(
    path.join(cfgDir, "skills", "spec-kit", "SKILL.md"),
    "summary: SDD wrapper\naliases: /speckit.plan\n\nPlan with spec-kit.",
  );
  const savedCfg = process.env.JOC_CONFIG_DIR;
  const savedCwd = process.cwd();
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logged.push(a.join(" "));
  try {
    process.env.JOC_CONFIG_DIR = cfgDir;
    process.chdir(workDir);
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["/speckit.plan improve joc", "--model", "ollama/qwen2.5:0.5b", "--no-session", "--no-tui"]);
  } finally {
    console.log = origLog;
    process.chdir(savedCwd);
    if (savedCfg === undefined) delete process.env.JOC_CONFIG_DIR; else process.env.JOC_CONFIG_DIR = savedCfg;
    await fs.rm(cfgDir, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
  }

  const out = logged.join("\n");
  expect(seenUser).toContain('You are now executing the "spec-kit"');
  expect(seenUser).toContain("Invoked as: /speckit.plan");
  expect(seenUser).toContain("User intent: improve joc");
  expect(out).toContain("▶ Running skill: spec-kit — improve joc");
  expect(out).toContain("skill executed");
});
