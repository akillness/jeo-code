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

test("deep-interview preserves non-English interview language and uses a safe slug fallback", async () => {
  const cwd = await tempDir();
  let systemPrompt = "";
  mockCallLlm = async (messages: Message[]) => {
    systemPrompt = messages.find(m => m.role === "system")?.content ?? "";
    return JSON.stringify({
      ambiguityScore: 0.1,
      assessment: "명확합니다",
      nextQuestion: "없습니다",
      goal: "터미널 메모 앱 만들기",
      constraints: [],
      acceptance_criteria: ["사용자는 CLI에서 메모를 생성하고 조회할 수 있다"],
    });
  };

  process.chdir(cwd);
  await runDeepInterviewCommand(["--auto", "터미널 메모 앱 만들기"]);

  const state = await readState(cwd);
  expect(state.language).toBe("ko");
  expect(state.slug.startsWith("interview-")).toBe(true);
  expect(systemPrompt).toContain("Korean (한국어)");
  expect(systemPrompt).toContain("Preserve the user's language");
  const seed = await fs.readFile(state.seed_path, "utf-8");
  expect(seed).toContain("터미널 메모 앱 만들기");
  expect(seed).toContain("사용자는 CLI에서 메모를 생성하고 조회할 수 있다");

  await fs.rm(cwd, { recursive: true, force: true });
});

test("deep-interview --auto: stores confirmed topology for multi-component ideas", async () => {
  const cwd = await tempDir();
  mockCallLlm = async () => JSON.stringify({
    ambiguityScore: 0.1,
    assessment: "Clear enough",
    nextQuestion: "none",
    goal: "Build an intake pipeline",
    constraints: [],
    acceptance_criteria: ["Each component has a working end-to-end path"],
  });

  process.chdir(cwd);
  await runDeepInterviewCommand([
    "--auto",
    "ingest CSVs, normalize records, provide reviewer UI, and export audit-ready reports",
  ]);

  const state = await readState(cwd);
  expect(state.topology.status).toBe("confirmed");
  expect(state.topology.components.length).toBe(4);
  expect(state.topology.components.map((c: any) => c.description)).toEqual([
    "ingest CSVs",
    "normalize records",
    "provide reviewer UI",
    "export audit-ready reports",
  ]);

  await fs.rm(cwd, { recursive: true, force: true });
});

test("deep-interview captures brownfield repo evidence for modification ideas", async () => {
  const cwd = await tempDir();
  await fs.mkdir(path.join(cwd, "src", "auth"), { recursive: true });
  await fs.writeFile(path.join(cwd, "package.json"), "{\"name\":\"demo\"}", "utf-8");
  await fs.writeFile(path.join(cwd, "src", "auth", "login.ts"), "export function loginFlow() {}", "utf-8");
  mockCallLlm = async () => JSON.stringify({
    ambiguityScore: 0.1,
    assessment: "Clear enough",
    nextQuestion: "none",
    goal: "Fix the existing login flow",
    constraints: [],
    acceptance_criteria: ["Login works again end-to-end"],
  });

  process.chdir(cwd);
  await runDeepInterviewCommand(["--auto", "fix the existing login flow"]);

  const state = await readState(cwd);
  expect(state.type).toBe("brownfield");
  expect(state.codebase_context).toContain("Repo markers:");
  expect(state.codebase_context).toContain("src/auth/login.ts");
  expect(state.codebase_context).toContain("matched: login");

  await fs.rm(cwd, { recursive: true, force: true });
});

test("deep-interview: empty directory stays greenfield even for modification-style ideas", async () => {
  const cwd = await tempDir();
  mockCallLlm = async () => JSON.stringify({
    ambiguityScore: 0.1,
    assessment: "Clear enough",
    nextQuestion: "none",
    goal: "Fix the login flow",
    constraints: [],
    acceptance_criteria: ["Login works"],
  });

  process.chdir(cwd);
  await runDeepInterviewCommand(["--auto", "fix the existing login flow"]);

  const state = await readState(cwd);
  expect(state.type).toBe("greenfield");
  expect(state.codebase_context).toBeUndefined();

  await fs.rm(cwd, { recursive: true, force: true });
});

test("deep-interview: brownfield with no keyword hits asks for the target surface instead of citing paths", async () => {
  const cwd = await tempDir();
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.writeFile(path.join(cwd, "package.json"), "{\"name\":\"demo\"}", "utf-8");
  await fs.writeFile(path.join(cwd, "src", "billing.ts"), "export function bill() {}", "utf-8");
  mockCallLlm = async () => JSON.stringify({
    ambiguityScore: 0.1,
    assessment: "Clear enough",
    nextQuestion: "none",
    goal: "Fix the login flow",
    constraints: [],
    acceptance_criteria: ["Login works"],
  });

  process.chdir(cwd);
  await runDeepInterviewCommand(["--auto", "fix the existing zzzz-flow"]);

  const state = await readState(cwd);
  expect(state.type).toBe("brownfield");
  expect(state.codebase_context).toContain("no keyword-matching files found yet");
  expect(state.codebase_context).not.toContain("billing.ts");

  await fs.rm(cwd, { recursive: true, force: true });
});

test("deep-interview: brownfield scanner sanitizes file names and skips symlinked dirs", async () => {
  const cwd = await tempDir();
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.writeFile(path.join(cwd, "package.json"), "{\"name\":\"demo\"}", "utf-8");
  // File whose name contains a backtick — buildBrownfieldContext must strip it before
  // surfacing the path to the LLM, otherwise the fence around evidence can be broken.
  await fs.writeFile(path.join(cwd, "src", "login`evil.ts"), "// adversarial filename", "utf-8");

  // Symlinked directory inside src/ — the scanner must not follow it.
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "joc-deep-outside-"));
  await fs.writeFile(path.join(outside, "secret-login.ts"), "// should not be surfaced", "utf-8");
  try {
    await fs.symlink(outside, path.join(cwd, "src", "linked"), "dir");
  } catch {
    // Skip symlink coverage on platforms that disallow it.
  }

  mockCallLlm = async () => JSON.stringify({
    ambiguityScore: 0.1,
    assessment: "Clear enough",
    nextQuestion: "none",
    goal: "Fix the existing login flow",
    constraints: [],
    acceptance_criteria: ["Login works again end-to-end"],
  });

  process.chdir(cwd);
  await runDeepInterviewCommand(["--auto", "fix the existing login flow"]);

  const state = await readState(cwd);
  expect(state.codebase_context).not.toContain("`");
  expect(state.codebase_context).not.toContain("secret-login.ts");
  expect(state.codebase_context).not.toContain("linked/");

  await fs.rm(cwd, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});
