import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const AUTOPILOT = resolve(import.meta.dir, "../src/autopilot.ts");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jeo-ratchet-failure-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(file: string, args: string[] = []) {
  const result = Bun.spawnSync([process.execPath, file, ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, SHELL: "/bin/sh", JEO_CONFIG_DIR: join(dir, ".config") },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

function autopilot(...args: string[]) {
  return run(AUTOPILOT, args);
}

function script(name: string, source: string): string {
  const file = join(dir, `${name}.ts`);
  writeFileSync(file, source);
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(file)}`;
}

function log(): Record<string, unknown>[] {
  return readFileSync(join(dir, ".jeo/autopilot/log.jsonl"), "utf8")
    .trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

function status() {
  const result = autopilot("status", "--json");
  expect(result.code).toBe(0);
  return JSON.parse(result.out);
}

function init(goal: string, evaluate: string) {
  expect(autopilot("init", "--task", "reject unsafe candidates", "--goal", goal,
    "--eval", evaluate, "--timeout", "5", "--patience", "3").code).toBe(0);
}

describe("autopilot failure evidence", () => {
  test.each([
    { goal: "min", improved: 1 },
    { goal: "max", improved: 20 },
  ])("$goal rejects an improved score when the evaluator exits unsuccessfully", ({ goal, improved }) => {
    writeFileSync(join(dir, "candidate.txt"), "baseline");
    const evaluate = script("evaluate", `
      import { readFileSync } from "node:fs";
      const changed = readFileSync("candidate.txt", "utf8") !== "baseline";
      console.log("score: " + (changed ? ${improved} : 10));
      process.exit(changed ? 1 : 0);
    `);
    const runner = script("runner", `import { writeFileSync } from "node:fs"; writeFileSync("candidate.txt", "unsafe");`);
    const rollback = script("rollback", `import { writeFileSync } from "node:fs"; writeFileSync("candidate.txt", "baseline");`);
    init(goal, evaluate);

    const result = autopilot("loop", "--runner", runner, "--on-revert", rollback, "--max", "1");

    expect(result.code).toBe(0);
    expect(log().find(event => event.type === "step")).toMatchObject({
      passed: false, score: improved, decision: "revert", prevBest: 10,
    });
    expect(readFileSync(join(dir, "candidate.txt"), "utf8")).toBe("baseline");
    expect(status()).toMatchObject({ best: 10, kept: 0, reverted: 1 });
  });

  test.each(["step", "loop"])("%s stops on rollback failure without reporting the workspace reverted", command => {
    const evaluate = script("evaluate", `console.log("rejected candidate"); process.exit(1);`);
    const runner = script("runner", String.raw`import { appendFileSync } from "node:fs"; appendFileSync("changes.txt", "unsafe\n");`);
    const rollback = script("rollback", `console.error("restore denied"); process.exit(7);`);
    init("gate", evaluate);
    const args = command === "loop"
      ? ["--runner", runner, "--max", "4"]
      : ["--change", "unsafe candidate"];
    if (command === "step") writeFileSync(join(dir, "changes.txt"), "unsafe\n");

    const result = autopilot(command, ...args, "--on-revert", rollback);

    expect(result.code).toBe(1);
    expect(log().at(-1)).toMatchObject({ type: "stop", reason: "rollback_failed", passed: false });
    expect(log().filter(event => event.type === "step" && event.decision === "revert")).toEqual([]);
    expect(readFileSync(join(dir, "changes.txt"), "utf8")).toBe("unsafe\n");
    expect(status()).toMatchObject({ kept: 0, reverted: 0, recommendation: "stopped: rollback_failed" });
  });

  test("a failed runner returns a failing exit status and does not evaluate or run another iteration", () => {
    const evaluate = script("evaluate", String.raw`import { appendFileSync } from "node:fs"; appendFileSync("actions.txt", "evaluate\n");`);
    const runner = script("runner", String.raw`import { appendFileSync } from "node:fs"; appendFileSync("actions.txt", "runner\n"); process.exit(9);`);
    init("gate", evaluate);

    const result = autopilot("loop", "--runner", runner, "--max", "4");

    expect(result.code).toBe(1);
    expect(log()).toEqual([expect.objectContaining({ type: "stop", reason: "runner_failed", iteration: 1 })]);
    expect(readFileSync(join(dir, "actions.txt"), "utf8")).toBe("runner\n");
  });
});

describe("workflow CLI failure propagation", () => {
  test.each(["ralplan", "ultragoal"])("%s reports prerequisite rejection to the shell", command => {
    // Missing interview state fails before either a model call or the verification suite.
    const result = run(resolve(import.meta.dir, "../src/cli.ts"), [command]);

    expect(result.out).toContain("[ERROR] No crystallized requirements found");
    expect(result.code).toBe(1);
  }, 30_000);
});
