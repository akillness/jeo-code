import { test, expect, afterEach, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "../src/agent/loop";

let mockCallLlm = async (_messages: Message[], _opts?: any): Promise<string> => {
  return JSON.stringify({
    ambiguityScore: 0.9,
    assessment: "default",
    nextQuestion: "next?",
  });
};

await mock.module("../src/agent/loop", () => ({
  callLlm: (messages: Message[], opts?: any) => mockCallLlm(messages, opts),
}));

const { runDeepInterviewCommand } = await import("../src/commands/deep-interview");

const savedCwd = process.cwd();

afterEach(async () => {
  process.chdir(savedCwd);
  mockCallLlm = async () => JSON.stringify({ ambiguityScore: 0.9, assessment: "default", nextQuestion: "next?" });
});

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "joc-deep-"));
}

async function readState(cwd: string): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(cwd, ".joc", "state", "deep-interview-state.json"), "utf-8"));
}

test("deep-interview --auto: does not freeze a seed while ambiguity stays above the threshold", async () => {
  const cwd = await tempDir();
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  let callCount = 0;
  mockCallLlm = async () => {
    callCount++;
    return JSON.stringify({
      ambiguityScore: 0.8,
      assessment: "Still vague",
      nextQuestion: "What exactly should it do?",
    });
  };
  try {
    process.chdir(cwd);
    await runDeepInterviewCommand(["--auto", "build something vague"]);
  } finally {
    console.log = origLog;
  }

  expect(callCount).toBe(10);
  await expect(fs.access(path.join(cwd, ".joc", "seeds"))).rejects.toThrow();
  const state = await readState(cwd);
  expect(state.current_phase).toBe("interviewing");
  expect(state.seed_path).toBeUndefined();
  expect(lines.join("\n")).toContain("No seed was frozen");

  await fs.rm(cwd, { recursive: true, force: true });
});

test("deep-interview --auto: does not fabricate acceptance criteria when the score is low but criteria are missing", async () => {
  const cwd = await tempDir();
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  let callCount = 0;
  mockCallLlm = async () => {
    callCount++;
    return JSON.stringify({
      ambiguityScore: 0.1,
      assessment: "Goal is clear but success criteria are missing",
      nextQuestion: "irrelevant",
      goal: "Build a terminal notes app",
      constraints: [],
      acceptance_criteria: [],
    });
  };
  try {
    process.chdir(cwd);
    await runDeepInterviewCommand(["--auto", "build a terminal notes app"]);
  } finally {
    console.log = origLog;
  }

  expect(callCount).toBe(10);
  await expect(fs.access(path.join(cwd, ".joc", "seeds"))).rejects.toThrow();
  const state = await readState(cwd);
  expect(state.current_phase).toBe("interviewing");
  expect(lines.join("\n")).toContain("acceptance criteria are still missing");

  await fs.rm(cwd, { recursive: true, force: true });
});

test("deep-interview --auto: freezes only concrete criteria and keeps empty constraints empty", async () => {
  const cwd = await tempDir();
  mockCallLlm = async () => JSON.stringify({
    ambiguityScore: 0.1,
    assessment: "Clear enough",
    nextQuestion: "none",
    goal: "Build a terminal notes app",
    constraints: [],
    acceptance_criteria: ["Users can create, list, and delete notes from the CLI"],
  });

  process.chdir(cwd);
  await runDeepInterviewCommand(["--auto", "build a terminal notes app"]);

  const state = await readState(cwd);
  expect(state.current_phase).toBe("complete");
  expect(state.seed_path).toContain("seed-build-a-terminal-notes-app.yaml");
  const seed = await fs.readFile(state.seed_path, "utf-8");
  expect(seed).toContain("constraints: []");
  expect(seed).toContain("Users can create, list, and delete notes from the CLI");
  expect(seed).not.toContain("TypeScript / Bun runtime");
  expect(seed).not.toContain("Runs successfully in the terminal");

  await fs.rm(cwd, { recursive: true, force: true });
});
