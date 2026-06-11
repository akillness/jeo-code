import { test, expect } from "bun:test";
import {
  bashCommandAllowed,
  subagentToolset,
  getSubagentRole,
  type SubagentRole,
} from "../src/agent/subagents";
import { DEFAULT_TOOLS } from "../src/agent/engine";

// B5 redesign (plan/gjc-inheritance.md cycle 10): a mutating role MAY declare a
// bash allowlist in the registry; subagentToolset() then wraps bash so every
// shell segment must start with an allowed prefix. The registry definition is
// the runtime constraint — no config plumbing.

test("bashCommandAllowed: allows matching heads, blocks everything else", () => {
  const ok = ["bun test", "git status"];
  expect(bashCommandAllowed("bun test", ok)).toBe(true);
  expect(bashCommandAllowed("bun test ./a.test.ts", ok)).toBe(true);
  expect(bashCommandAllowed("git status --short", ok)).toBe(true);
  expect(bashCommandAllowed("rm -rf /", ok)).toBe(false);
  expect(bashCommandAllowed("bunx eslint", ok)).toBe(false); // not "bun "
  // empty allowlist = unconstrained (back-compat for roles that opt out)
  expect(bashCommandAllowed("rm -rf /", [])).toBe(true);
});

test("bashCommandAllowed: vets EVERY chained segment, strips env/sudo", () => {
  const ok = ["echo"];
  expect(bashCommandAllowed("echo hi && echo bye", ok)).toBe(true);
  expect(bashCommandAllowed("echo hi && rm -rf x", ok)).toBe(false); // second segment blocked
  expect(bashCommandAllowed("echo a | grep b", ok)).toBe(false); // grep not allowed
  expect(bashCommandAllowed("FOO=1 BAR=2 echo hi", ok)).toBe(true); // env prefix stripped
  expect(bashCommandAllowed("sudo echo hi", ok)).toBe(true); // sudo stripped
  expect(bashCommandAllowed("echo $(rm -rf /)", ok)).toBe(false); // substitution rejected
  expect(bashCommandAllowed("echo `whoami`", ok)).toBe(false); // backtick rejected
});

test("subagentToolset: a role's bash allowlist actually gates the bash tool", async () => {
  const sandboxed: SubagentRole = {
    id: "sandboxed",
    title: "Sandboxed",
    description: "test-only role",
    readOnly: false,
    defaultMaxSteps: 5,
    prompt: "",
    bashAllowedPrefixes: ["echo"],
  };
  const tools = subagentToolset(sandboxed);
  const allowed = await tools.bash({ command: "echo hello" }, process.cwd());
  expect(allowed.success).toBe(true);
  expect(allowed.output).toContain("hello");

  const blocked = await tools.bash({ command: "rm -rf /tmp/should-not-run" }, process.cwd());
  expect(blocked.success).toBe(false);
  expect(blocked.error).toContain("bash rejected for role 'sandboxed'");
});

test("executor (no allowlist) keeps the unconstrained default bash handler", () => {
  const executor = getSubagentRole("executor")!;
  const tools = subagentToolset(executor);
  expect(tools.bash).toBe(DEFAULT_TOOLS.bash);
});

test("read-only roles drop bash entirely regardless of any allowlist", () => {
  for (const id of ["planner", "architect", "critic"]) {
    const tools = subagentToolset(getSubagentRole(id)!);
    expect(tools.bash).toBeUndefined();
    expect(tools.write).toBeUndefined();
    expect(tools.edit).toBeUndefined();
    expect(typeof tools.read).toBe("function");
  }
});
