import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type * as AiModule from "../src/ai";
import type * as ReadlinePromises from "node:readline/promises";
import type { ProviderModelsResult, ProviderName } from "../src/ai";

// Dynamic imports are required in this test file: Bun module mocks must be installed
// before launch.ts captures readline and the ai barrel imports in module scope.
const realReadline: typeof ReadlinePromises = { ...(await import("node:readline/promises")) };
const realAI: typeof AiModule = { ...(await import("../src/ai")) };

let mockQuestions: string[] = [];
let mockIndex = 0;
let liveModels: ProviderModelsResult[] = [];

mock.module("node:readline/promises", () => ({
  createInterface: () => ({
    question: mock(async () => mockQuestions[mockIndex++] ?? "/exit"),
    close: mock(() => {}),
    on: mock(() => {}),
    pause: mock(() => {}),
    resume: mock(() => {}),
  }),
}));

mock.module("../src/ai", () => ({
  ...realAI,
  discoverModels: mock(async () => liveModels),
  describeAllProviders: mock(async () => [
    { name: "openai", kind: "oauth", label: "OAuth", ready: true, loggedIn: true },
    { name: "anthropic", kind: "none", label: "none", ready: false },
    { name: "gemini", kind: "none", label: "none", ready: false },
    { name: "antigravity", kind: "none", label: "none", ready: false },
    { name: "ollama", kind: "keyless", label: "keyless", ready: true },
    { name: "lmstudio", kind: "keyless", label: "keyless", ready: true },
  ]),
}));

type Keypress = [string, { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean } | undefined];

const enter: Keypress = ["\r", { name: "return" }];
const down: Keypress = ["", { name: "down" }];

let cfgDir: string;
let savedCfgDir: string | undefined;
let savedStdinIsTTY: boolean | undefined;
let savedStdoutIsTTY: boolean | undefined;
let savedStdoutWrite: typeof process.stdout.write;
let savedStdinOn: typeof process.stdin.on;
let savedStdinOff: typeof process.stdin.off;
let savedSetRawMode: typeof process.stdin.setRawMode;
let pickerScripts: Keypress[][] = [];

beforeEach(async () => {
  cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-routing-target-"));
  savedCfgDir = process.env.JEO_CONFIG_DIR;
  process.env.JEO_CONFIG_DIR = cfgDir;
  mockQuestions = ["/model", "/exit"];
  mockIndex = 0;
  liveModels = [];
  savedStdinIsTTY = process.stdin.isTTY;
  savedStdoutIsTTY = process.stdout.isTTY;
  savedStdoutWrite = process.stdout.write;
  savedStdinOn = process.stdin.on;
  savedStdinOff = process.stdin.off;
  savedSetRawMode = process.stdin.setRawMode;
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
  process.stdin.setRawMode = mock(() => process.stdin);
  process.stdout.write = mock(() => true) as typeof process.stdout.write;
});

afterEach(async () => {
  process.stdin.isTTY = savedStdinIsTTY as boolean;
  process.stdout.isTTY = savedStdoutIsTTY as boolean;
  process.stdout.write = savedStdoutWrite;
  process.stdin.on = savedStdinOn;
  process.stdin.off = savedStdinOff;
  process.stdin.setRawMode = savedSetRawMode;
  if (savedCfgDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = savedCfgDir;
  await fs.rm(cfgDir, { recursive: true, force: true });
});

afterAll(() => {
  mock.module("node:readline/promises", () => realReadline);
  mock.module("../src/ai", () => realAI);
});

function installPickerScripts(scripts: Keypress[][]): void {
  pickerScripts = scripts.map(script => [...script]);
  process.stdin.on = function patchedOn(event: string | symbol, listener: (...args: unknown[]) => void) {
    const result = savedStdinOn.call(this, event, listener);
    if (event === "keypress" && listener.name === "handler") {
      const script = pickerScripts.shift() ?? [];
      queueMicrotask(() => {
        for (const [ch, key] of script) listener(ch, key);
      });
    }
    return result;
  } as typeof process.stdin.on;
  process.stdin.off = function patchedOff(event: string | symbol, listener: (...args: unknown[]) => void) {
    return savedStdinOff.call(this, event, listener);
  } as typeof process.stdin.off;
}

async function runInteractiveModelPick(model: string, provider: ProviderName, pickerScriptsForRun: Keypress[][]): Promise<Record<string, unknown>> {
  liveModels = [{ provider, models: [model], ok: true, source: "oauth" }];
  await fs.writeFile(path.join(cfgDir, "config.json"), JSON.stringify({
    providers: { openai: "sk-test" },
    defaultModel: "claude-sonnet-4-6",
    routing: { enabled: false, tiers: { complex: { model: "claude-opus-4-8", thinking: "xhigh" } } },
  }));
  installPickerScripts(pickerScriptsForRun);

  const savedLog = console.log;
  console.log = () => {};
  try {
    // Dynamic import is intentional: the launch module must observe the mocks above.
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["--no-tui", "--no-session"]);

    return JSON.parse(await fs.readFile(path.join(cfgDir, "config.json"), "utf-8"));
  } finally {
    console.log = savedLog;
  }
}

test("interactive /model can apply a picked catalog model to a PromptRouter tier and enables routing", async () => {
  const saved = await runInteractiveModelPick("gpt-5.5", "openai", [
    [enter],
    [down, down, down, enter],
    [enter],
  ]);

  expect(saved.routing).toMatchObject({
    enabled: true,
    tiers: {
      high: { model: "gpt-5.5", thinking: "low" },
      complex: { model: "claude-opus-4-8", thinking: "xhigh" },
    },
  });
  expect(saved.defaultModel).toBe("claude-sonnet-4-6");
  expect(saved.recentModels).toBeUndefined();
});

test("interactive /model does not write unsupported route thinking for no-thinking catalog models", async () => {
  const saved = await runInteractiveModelPick("gpt-4o", "openai", [
    [enter],
    [down, enter],
  ]);

  expect(saved.routing).toMatchObject({
    enabled: true,
    tiers: {
      trivial: { model: "gpt-4o" },
      complex: { model: "claude-opus-4-8", thinking: "xhigh" },
    },
  });
  expect((saved.routing as { tiers: { trivial: { thinking?: string } } }).tiers.trivial.thinking).toBeUndefined();
  expect(saved.defaultModel).toBe("claude-sonnet-4-6");
  expect(saved.recentModels).toBeUndefined();
});
