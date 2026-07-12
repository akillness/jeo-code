import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runRoutineCommand } from "../src/commands/routine";

// Mirrors test/deep-interview.test.ts / test/state-command.test.ts's established
// convention for command tests: isolate cwd via fs.mkdtemp + process.chdir (the
// command resolves --out relative to process.cwd()), and capture console.log +
// process.exitCode around each invocation.

let tempCwd: string;
let savedCwd: string;
let origLog: typeof console.log;

beforeEach(async () => {
  tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-routine-cmd-test-"));
  savedCwd = process.cwd();
  process.chdir(tempCwd);
  process.exitCode = 0;
  origLog = console.log;
});

afterEach(async () => {
  console.log = origLog;
  process.chdir(savedCwd);
  process.exitCode = 0;
  await fs.rm(tempCwd, { recursive: true, force: true });
});

function captureLog(): { logs: string[] } {
  const logs: string[] = [];
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  return { logs };
}

// --- required-flag validation ---

test("routine init: missing --trigger exits 1 with a clear error", async () => {
  const { logs } = captureLog();
  await runRoutineCommand(["init", "--prompt", "triage issues"]);
  expect(process.exitCode).toBe(1);
  expect(logs.some(l => l.includes("--trigger is required"))).toBe(true);
});

test("routine init: missing --prompt exits 1 with a clear error", async () => {
  const { logs } = captureLog();
  await runRoutineCommand(["init", "--trigger", "issues"]);
  expect(process.exitCode).toBe(1);
  expect(logs.some(l => l.includes("--prompt is required"))).toBe(true);
});

test("routine init: --trigger schedule with no --cron exits 1 with a clear error", async () => {
  const { logs } = captureLog();
  await runRoutineCommand(["init", "--trigger", "schedule", "--prompt", "nightly triage"]);
  expect(process.exitCode).toBe(1);
  expect(logs.some(l => l.includes("--cron is required"))).toBe(true);
});

test("routine init: --trigger schedule with a malformed --cron exits 1", async () => {
  const { logs } = captureLog();
  await runRoutineCommand(["init", "--trigger", "schedule", "--prompt", "nightly triage", "--cron", "not a cron"]);
  expect(process.exitCode).toBe(1);
  expect(logs.some(l => l.includes("does not look like a valid 5-field cron expression"))).toBe(true);
});

// --- --dry-run: no file written ---

test("routine init --dry-run: prints YAML and writes NO file to disk", async () => {
  const { logs } = captureLog();
  await runRoutineCommand(["init", "--trigger", "issues", "--prompt", "label new issues", "--dry-run"]);
  expect(process.exitCode).not.toBe(1);
  const output = logs.join("\n");
  expect(output).toContain("name:");
  expect(output).toContain("on:");
  expect(output).toContain("issues:");

  const workflowsDir = path.join(tempCwd, ".github", "workflows");
  const exists = await fs.access(workflowsDir).then(() => true, () => false);
  expect(exists).toBe(false);
});

test("routine init --dry-run --json: prints parseable JSON with dryRun:true and the rendered yaml, writes NO file", async () => {
  const { logs } = captureLog();
  await runRoutineCommand(["init", "--trigger", "issues", "--prompt", "label new issues", "--dry-run", "--json"]);
  const parsed = JSON.parse(logs.join("\n"));
  expect(parsed.dryRun).toBe(true);
  expect(typeof parsed.yaml).toBe("string");
  expect(parsed.yaml).toContain("issues:");

  const workflowsDir = path.join(tempCwd, ".github", "workflows");
  const exists = await fs.access(workflowsDir).then(() => true, () => false);
  expect(exists).toBe(false);
});

// --- real write: default --out derivation from --name, and explicit --out ---

test("routine init: real write creates the file at the DEFAULT --out path derived from --name (slugified)", async () => {
  captureLog();
  await runRoutineCommand(["init", "--trigger", "issues", "--prompt", "label new issues", "--name", "Nightly Triage"]);
  expect(process.exitCode).not.toBe(1);

  const expectedPath = path.join(tempCwd, ".github", "workflows", "jeo-routine-nightly-triage.yml");
  const content = await fs.readFile(expectedPath, "utf-8");
  expect(content).toContain("name: 'Nightly Triage'");
  expect(content).toContain("issues:");
});

test("routine init: real write creates the file at an EXPLICIT --out path", async () => {
  captureLog();
  const outPath = "custom/workflows/my-routine.yml";
  await runRoutineCommand(["init", "--trigger", "issues", "--prompt", "label new issues", "--out", outPath]);
  expect(process.exitCode).not.toBe(1);

  const content = await fs.readFile(path.join(tempCwd, outPath), "utf-8");
  expect(content).toContain("issues:");
});

// --- overwrite protection ---

test("routine init: re-running without --force refuses (exitCode 1), file unchanged", async () => {
  const outPath = "custom/routine.yml";
  captureLog();
  await runRoutineCommand(["init", "--trigger", "issues", "--prompt", "first prompt", "--out", outPath]);
  const originalContent = await fs.readFile(path.join(tempCwd, outPath), "utf-8");

  const { logs } = captureLog();
  await runRoutineCommand(["init", "--trigger", "issues", "--prompt", "second prompt (should be refused)", "--out", outPath]);
  expect(process.exitCode).toBe(1);
  expect(logs.some(l => l.includes("already exists"))).toBe(true);

  const unchangedContent = await fs.readFile(path.join(tempCwd, outPath), "utf-8");
  expect(unchangedContent).toBe(originalContent);
  expect(unchangedContent).not.toContain("second prompt");
});

test("routine init: re-running WITH --force overwrites the existing file", async () => {
  const outPath = "custom/routine.yml";
  captureLog();
  await runRoutineCommand(["init", "--trigger", "issues", "--prompt", "first prompt", "--out", outPath]);

  captureLog();
  await runRoutineCommand(["init", "--trigger", "issues", "--prompt", "second prompt AFTER force", "--out", outPath, "--force"]);
  expect(process.exitCode).not.toBe(1);

  const content = await fs.readFile(path.join(tempCwd, outPath), "utf-8");
  expect(content).toContain("second prompt AFTER force");
});

// --- --json mode on the success write path ---

test("routine init --json: real write produces valid parseable JSON describing what was written", async () => {
  const { logs } = captureLog();
  const outPath = "custom/json-routine.yml";
  await runRoutineCommand(["init", "--trigger", "pull_request", "--prompt", "review new PRs", "--out", outPath, "--json"]);
  expect(process.exitCode).not.toBe(1);

  const parsed = JSON.parse(logs.join("\n"));
  expect(parsed.wrote).toBe(path.resolve(process.cwd(), outPath));
  expect(parsed.trigger).toBe("pull_request");
  expect(parsed.apiKeyEnvVar).toBe("ANTHROPIC_API_KEY");
  expect(parsed.openPr).toBe(true);
});
