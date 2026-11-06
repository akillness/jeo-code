import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { loadHooks, runPrePromptHooks, runTurnEndHooks, runPreToolHooks, setHookSessionId } from "../src/agent/hooks";

// Each test gets its own config dir: the hook readers cache by path + mtime/size, so a
// shared path rewritten within one millisecond could serve a stale parse.
let root: string;
let cfgDir: string;
let proj: string;
const prevConfigDir = process.env.JEO_CONFIG_DIR;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-hooks-prompt-"));
  cfgDir = path.join(root, "cfg");
  proj = path.join(root, "proj");
  await fs.mkdir(cfgDir, { recursive: true });
  await fs.mkdir(path.join(proj, ".jeo"), { recursive: true });
  process.env.JEO_CONFIG_DIR = cfgDir;
  setHookSessionId(undefined);
});

afterEach(async () => {
  setHookSessionId(undefined); // module state is shared by every test file in the bun process
  if (prevConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = prevConfigDir;
  await fs.rm(root, { recursive: true, force: true });
});

const writeConfig = (hooks?: unknown) =>
  fs.writeFile(path.join(cfgDir, "config.json"), JSON.stringify({ defaultModel: "claude-sonnet-4-5", providers: {}, ...(hooks === undefined ? {} : { hooks }) }), "utf-8");
const writeUser = (value: unknown) => fs.writeFile(path.join(cfgDir, "hooks.json"), JSON.stringify(value), "utf-8");
const writeProject = (value: unknown) => fs.writeFile(path.join(proj, ".jeo", "hooks.json"), JSON.stringify(value), "utf-8");
const runs = (hooks: Array<{ run: string }>) => hooks.map(h => h.run);

test("user registry runs without hooks.enabled and ahead of configured hooks", async () => {
  await writeConfig();
  await writeUser({ hooks: [{ event: "pre-prompt", run: "echo user" }] });
  expect(runs(await loadHooks(proj))).toEqual(["echo user"]);

  await writeConfig({ enabled: true, hooks: [{ event: "pre-prompt", run: "echo configured" }] });
  expect(runs(await loadHooks(proj))).toEqual(["echo user", "echo configured"]);
});

test("explicit hooks.enabled=false is a global kill switch, user registry included", async () => {
  await writeConfig({ enabled: false });
  await writeUser({ hooks: [{ event: "pre-prompt", run: "echo user" }] });
  expect(await loadHooks(proj)).toEqual([]);
});

test("a project hooks file with enabled=false opts the project out of the user registry", async () => {
  await writeConfig();
  await writeUser({ hooks: [{ event: "pre-prompt", run: "echo user" }] });
  await writeProject({ enabled: false });
  expect(await loadHooks(proj)).toEqual([]);
});

test("the user registry can opt itself out", async () => {
  await writeConfig({ enabled: true, hooks: [{ event: "pre-prompt", run: "echo configured" }] });
  await writeUser({ enabled: false, hooks: [{ event: "pre-prompt", run: "echo user" }] });
  expect(runs(await loadHooks(proj))).toEqual(["echo configured"]);
});

test("a project hook list replaces the configured list but never the user registry", async () => {
  await writeConfig({ enabled: true, hooks: [{ event: "pre-tool", run: "echo configured" }] });
  await writeUser({ hooks: [{ event: "pre-prompt", run: "echo user" }] });
  await writeProject({ hooks: [{ event: "pre-tool", run: "echo project" }] });
  expect(runs(await loadHooks(proj))).toEqual(["echo user", "echo project"]);
});

test("project hooks cannot enable themselves: they need config.hooks.enabled", async () => {
  await writeConfig();
  await writeProject({ enabled: true, hooks: [{ event: "pre-prompt", run: "echo project" }] });
  expect(await loadHooks(proj)).toEqual([]);
});

test("malformed registry entries are dropped instead of poisoning the batch", async () => {
  await writeConfig();
  await writeUser({
    hooks: [
      { event: "pre-prompt", run: "echo ok" },
      { event: "pre-prompt" },
      { event: "pre-prompt", run: "   " },
      { event: "nonsense", run: "echo bad-event" },
      { event: "pre-prompt", run: "echo bad-timeout", timeoutMs: -5 },
      "not an object",
    ],
  });
  expect(runs(await loadHooks(proj))).toEqual(["echo ok"]);
});

test("pre-prompt: plain stdout becomes context", async () => {
  await writeConfig();
  await writeUser({ hooks: [{ event: "pre-prompt", run: "echo 'use skill X'" }] });
  const res = await runPrePromptHooks(proj, "do the thing");
  expect(res).toEqual({ context: "use skill X", ran: 1 });
});

test("pre-prompt: Claude-protocol JSON additionalContext and context are honored, in hook order", async () => {
  await writeConfig();
  await writeUser({
    hooks: [
      { event: "pre-prompt", run: `echo '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"first"}}'` },
      { event: "pre-prompt", run: `echo '{"context":"second"}'` },
      { event: "pre-prompt", run: `echo '{}'` },
    ],
  });
  const res = await runPrePromptHooks(proj, "hi");
  expect(res.context).toBe("first\n\nsecond");
  expect(res.ran).toBe(3);
});

test("pre-prompt: a failing hook yields a notice and no context, never a block", async () => {
  await writeConfig();
  await writeUser({
    hooks: [
      { event: "pre-prompt", run: "echo 'should not leak'; exit 3" },
      { event: "pre-prompt", run: "echo kept" },
    ],
  });
  const notices: string[] = [];
  const res = await runPrePromptHooks(proj, "hi", undefined, m => notices.push(m));
  expect(res.context).toBe("kept");
  expect(res.ran).toBe(1);
  expect(notices.join("\n")).toContain("non-zero code 3");
});

test("pre-prompt: a timed-out hook is advisory", async () => {
  await writeConfig();
  await writeUser({ hooks: [{ event: "pre-prompt", run: "sleep 5", timeoutMs: 150 }] });
  const notices: string[] = [];
  const started = Date.now();
  const res = await runPrePromptHooks(proj, "hi", undefined, m => notices.push(m));
  expect(res).toEqual({ context: "", ran: 0 });
  expect(notices.join("\n")).toContain("timed out");
  expect(Date.now() - started).toBeLessThan(4000);
});

test("pre-prompt: the payload speaks the Claude hook protocol", async () => {
  await writeConfig();
  // `cat` alone would print the payload as JSON, which is (correctly) read as a protocol
  // object without context; prefix it so the echo is plain text.
  await writeUser({ hooks: [{ event: "pre-prompt", run: `printf 'P:%s' "$(cat)"` }] });
  setHookSessionId("sess-42");
  const res = await runPrePromptHooks(proj, "route this prompt");
  const payload = JSON.parse(res.context.replace(/^P:/, ""));
  expect(payload).toMatchObject({
    event: "pre-prompt",
    hook_event_name: "UserPromptSubmit",
    session_id: "sess-42",
    cwd: proj,
    prompt: "route this prompt",
  });
});

test("pre-prompt: no registered hook means no work and no context", async () => {
  await writeConfig();
  expect(await runPrePromptHooks(proj, "hi")).toEqual({ context: "", ran: 0 });
});

test("turn-end: the payload carries the final reply and turn facts", async () => {
  await writeConfig();
  const out = path.join(root, "turn-end.json");
  await writeUser({ hooks: [{ event: "turn-end", run: `cat > '${out}'` }] });
  setHookSessionId("sess-7");
  const res = await runTurnEndHooks(proj, { prompt: "what changed?", response: "Added the hook.", done: true, steps: 4, model: "m-1" });
  expect(res.ran).toBe(1);
  expect(JSON.parse(await fs.readFile(out, "utf-8"))).toMatchObject({
    event: "turn-end",
    hook_event_name: "Stop",
    session_id: "sess-7",
    cwd: proj,
    prompt: "what changed?",
    response: "Added the hook.",
    last_assistant_message: "Added the hook.",
    assistant_output: "Added the hook.",
    done: true,
    steps: 4,
    model: "m-1",
    stop_hook_active: false,
  });
});

test("turn-end: a failing hook is advisory", async () => {
  await writeConfig();
  await writeUser({ hooks: [{ event: "turn-end", run: "exit 9" }] });
  const notices: string[] = [];
  const res = await runTurnEndHooks(proj, { prompt: "p", response: "r", done: true, steps: 1 }, undefined, m => notices.push(m));
  expect(res.ran).toBe(0);
  expect(notices.join("\n")).toContain("non-zero code 9");
});

test("pre-tool: a JSON deny with exit 0 vetoes with the hook's reason", async () => {
  await writeConfig();
  await writeUser({
    hooks: [{ event: "pre-tool", match: { tool: "edit" }, run: `echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"read the graph first"}}'` }],
  });
  const res = await runPreToolHooks(proj, "edit", { path: "a.ts" });
  expect(res.vetoed).toBe(true);
  expect(res.error).toContain("read the graph first");
  // A tool the hook does not match is untouched.
  expect((await runPreToolHooks(proj, "read", { path: "a.ts" })).vetoed).toBe(false);
});

test("pre-tool: ask is treated as deny because jeo has no hook approval prompt", async () => {
  await writeConfig();
  await writeUser({ hooks: [{ event: "pre-tool", run: `echo '{"hookSpecificOutput":{"permissionDecision":"ask"}}'` }] });
  expect((await runPreToolHooks(proj, "bash", { command: "ls" })).vetoed).toBe(true);
});

test("pre-tool: allow plus additionalContext returns context; plain stdout is ignored", async () => {
  await writeConfig();
  await writeUser({
    hooks: [
      { event: "pre-tool", run: "echo 'noisy logging that must not reach the model'" },
      { event: "pre-tool", run: `echo '{"hookSpecificOutput":{"permissionDecision":"allow","additionalContext":"graph is fresh"}}'` },
    ],
  });
  const res = await runPreToolHooks(proj, "edit", { path: "a.ts" });
  expect(res).toEqual({ vetoed: false, context: "graph is fresh" });
});

test("pre-tool: the payload carries Claude tool_name/tool_input beside jeo's tool/args", async () => {
  await writeConfig();
  const out = path.join(root, "pre-tool.json");
  await writeUser({ hooks: [{ event: "pre-tool", run: `cat > '${out}'` }] });
  setHookSessionId("sess-1");
  await runPreToolHooks(proj, "write", { path: "x.ts", content: "1" });
  expect(JSON.parse(await fs.readFile(out, "utf-8"))).toMatchObject({
    event: "pre-tool",
    hook_event_name: "PreToolUse",
    session_id: "sess-1",
    tool: "write",
    args: { path: "x.ts", content: "1" },
    tool_name: "write",
    tool_input: { path: "x.ts", content: "1" },
  });
});
