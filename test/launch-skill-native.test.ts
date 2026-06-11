import { test, expect, mock, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import * as catalog from "../src/skills/catalog";

// Capture the REAL modules before mock.module replaces them — bun's mock.module
// is process-global and would otherwise leak into later test files (session.test.ts,
// review-fixes.test.ts) in the same `bun test` run.
const realReadline = { ...(await import("node:readline/promises")) };
const realDeepInterview = { ...(await import("../src/commands/deep-interview")) };
const realRalplan = { ...(await import("../src/commands/ralplan")) };
const realTeam = { ...(await import("../src/commands/team")) };
const realUltragoal = { ...(await import("../src/commands/ultragoal")) };
const realSession = { ...(await import("../src/agent/session")) };

let mockQuestions: string[] = [];
let mockQuestionIndex = 0;

mock.module("node:readline/promises", () => {
  return {
    createInterface: () => {
      return {
        question: mock(async (query: string) => {
          if (mockQuestionIndex < mockQuestions.length) {
            return mockQuestions[mockQuestionIndex++];
          }
          return "/exit";
        }),
        close: mock(() => {}),
        on: mock(() => {}),
        pause: mock(() => {}),
        resume: mock(() => {}),
      };
    }
  };
});

const mockDeepInterview = mock(() => Promise.resolve({ ok: true }));
const mockRalplan = mock(() => Promise.resolve({ ok: true }));
const mockTeam = mock(() => Promise.resolve({ ok: true }));
const mockUltragoal = mock(() => Promise.resolve({ ok: true }));

mock.module("../src/commands/deep-interview", () => ({
  runDeepInterviewEngine: mockDeepInterview,
  runDeepInterviewCommand: () => Promise.resolve()
}));
mock.module("../src/commands/ralplan", () => ({
  runRalplanEngine: mockRalplan,
  runRalplanCommand: () => Promise.resolve()
}));
mock.module("../src/commands/team", () => ({
  runTeamEngine: mockTeam,
  runTeamCommand: () => Promise.resolve()
}));
mock.module("../src/commands/ultragoal", () => ({
  runUltragoalEngine: mockUltragoal,
  runUltragoalCommand: () => Promise.resolve()
}));

// Mock other dependencies that launch.ts imports to avoid actual network/state writes in simple test
mock.module("../src/agent/session", () => ({
  createSession: mock(() => Promise.resolve({ id: "mock-session" })),
  appendMessage: mock(() => Promise.resolve()),
  loadSession: mock(() => Promise.resolve({ messages: [] })),
  listSessions: mock(() => Promise.resolve([])),
  latestSessionId: mock(() => Promise.resolve(null)),
  exportSession: mock(() => Promise.resolve("")),
  renameSession: mock(() => Promise.resolve()),
  deleteSession: mock(() => Promise.resolve(true)),
  sessionPath: mock(() => "/mock/path"),
}));

const mockBuildSkillTask = spyOn(catalog, "buildSkillTask").mockImplementation(() => {
  throw new Error("Should not be called! LLM one-shot path was hit.");
});
let originalIsTTY = process.stdin.isTTY;

beforeEach(() => {
  originalIsTTY = process.stdin.isTTY;
  process.stdin.isTTY = true;
  mockQuestions = [];
  mockQuestionIndex = 0;
  mockDeepInterview.mockClear();
  mockRalplan.mockClear();
  mockTeam.mockClear();
  mockUltragoal.mockClear();
  mockBuildSkillTask.mockClear();
});

afterEach(() => {
  process.stdin.isTTY = originalIsTTY;
});

afterAll(() => {
  // Undo the process-global module mocks so later test files see the real modules.
  mock.module("node:readline/promises", () => realReadline);
  mock.module("../src/commands/deep-interview", () => realDeepInterview);
  mock.module("../src/commands/ralplan", () => realRalplan);
  mock.module("../src/commands/team", () => realTeam);
  mock.module("../src/commands/ultragoal", () => realUltragoal);
  mock.module("../src/agent/session", () => realSession);
  mockBuildSkillTask.mockRestore();
});



test("launch workflow skill routing deep-interview", async () => {
  mockQuestions = ["/skill deep-interview design a compiler", "/exit"];
  
  const { runLaunchCommand } = await import("../src/commands/launch");
  await runLaunchCommand(["--no-tui", "--no-session"]);

  expect(mockDeepInterview).toHaveBeenCalled();
  expect(mockDeepInterview.mock.calls[0][0].args).toEqual(["design", "a", "compiler"]);
  expect(mockBuildSkillTask).not.toHaveBeenCalled();
});

test("launch workflow skill routing ralplan", async () => {
  mockQuestions = ["/skill ralplan", "/exit"];
  
  const { runLaunchCommand } = await import("../src/commands/launch");
  await runLaunchCommand(["--no-tui", "--no-session"]);

  expect(mockRalplan).toHaveBeenCalled();
  expect(mockBuildSkillTask).not.toHaveBeenCalled();
});

test("launch workflow skill routing team", async () => {
  mockQuestions = ["/skill team", "/exit"];
  
  const { runLaunchCommand } = await import("../src/commands/launch");
  await runLaunchCommand(["--no-tui", "--no-session"]);

  expect(mockTeam).toHaveBeenCalled();
  expect(mockBuildSkillTask).not.toHaveBeenCalled();
});

test("launch workflow skill routing ultragoal", async () => {
  mockQuestions = ["/skill ultragoal", "/exit"];
  
  const { runLaunchCommand } = await import("../src/commands/launch");
  await runLaunchCommand(["--no-tui", "--no-session"]);

  expect(mockUltragoal).toHaveBeenCalled();
  expect(mockBuildSkillTask).not.toHaveBeenCalled();
});
