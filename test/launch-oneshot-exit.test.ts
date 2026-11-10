import { test, expect } from "bun:test";
import { fileURLToPath } from "node:url";
import { createInFlightAbortHarness } from "../src/commands/launch/input";

// Field crashes (~/.jeo/crash.log, 2026-08 → 2026-10):
//   ReferenceError: Cannot access 'forceExitFromCtrlC' before initialization
//     at onHardExit (launch.ts) ← handleSigint (launch/input.ts)
//   ReferenceError: Cannot access 'expandSentinel' before initialization
//     at onBufferedInput (launch.ts) ← handleData (launch/input.ts)
//
// Root cause: `runTurnScoped` is invoked from the one-shot branch (`-p`, piped stdin,
// messenger worker, startup `$skill`), which `return`s BEFORE the interactive REPL
// section where `expandSentinel` and `forceExitFromCtrlC` used to be declared as
// `const`s. The in-flight abort harness closes over both; any keystroke or Ctrl+C during
// a one-shot turn landed in the temporal dead zone, hit the cli.ts crash net, and
// killed the session with exit 1 instead of the intended hard exit 130.
//
// TDZ ordering is a static property of the source, so these are structural guards in
// the style of compaction.test.ts: the declarations must precede `runTurnScoped`, and
// nothing may re-declare them as a block-scoped `const` afterwards. A behavioural
// repro (SIGINT at ~3s into `bun run src/cli.ts "prompt"` piped) was run by hand
// against HEAD → exit 1 + TDZ on stderr, and against this fix → exit 130, clean.

const src = await Bun.file(new URL("../src/commands/launch.ts", import.meta.url)).text();

const indexOfDecl = (re: RegExp): number => {
  const m = re.exec(src);
  return m ? m.index : -1;
};

test("launch.ts: expandSentinel / forceExitFromCtrlC / hardExitCore are declared BEFORE runTurnScoped (one-shot TDZ crash)", () => {
  const runTurnScopedAt = indexOfDecl(/^  const runTurnScoped = async \(/m);
  expect(runTurnScopedAt).toBeGreaterThan(0);

  const expandSentinelAt = indexOfDecl(/^  const expandSentinel = /m);
  const hardExitCoreAt = indexOfDecl(/^  const hardExitCore = /m);
  const forceExitAt = indexOfDecl(/^  let forceExitFromCtrlC: \(\) => void = hardExitCore;/m);
  const multilineInputAt = indexOfDecl(/^  const multilineInput = /m);

  for (const [name, at] of [["expandSentinel", expandSentinelAt], ["hardExitCore", hardExitCoreAt], ["forceExitFromCtrlC", forceExitAt], ["multilineInput", multilineInputAt]] as const) {
    expect(at, `${name} must be declared`).toBeGreaterThan(0);
    expect(at, `${name} must precede runTurnScoped (TDZ on one-shot path)`).toBeLessThan(runTurnScopedAt);
  }
});

test("launch.ts: no block-scoped re-declaration of expandSentinel / forceExitFromCtrlC after runTurnScoped", () => {
  // Exactly ONE `const expandSentinel` and ZERO `const forceExitFromCtrlC` in the file:
  // the interactive REPL must REASSIGN the hoisted `let` (so every harness that captured
  // the binding sees the terminal-restoring variant), never shadow it with a new const
  // that reintroduces the dead zone.
  expect(src.match(/^\s*const expandSentinel\b/gm)?.length ?? 0).toBe(1);
  expect(src.match(/^\s*const forceExitFromCtrlC\b/gm)?.length ?? 0).toBe(0);
  expect(src.match(/^\s*const multilineInput\b/gm)?.length ?? 0).toBe(1);
  // The interactive reassignment exists and wraps the shared core.
  const reassign = src.match(/^  forceExitFromCtrlC = \(\) => \{[\s\S]*?^  \};/m);
  expect(reassign).not.toBeNull();
  expect(reassign![0]).toMatch(/hardExitCore\(\);/);
  expect(reassign![0]).toMatch(/restorePromptRawMode\(\);/);
});

test("launch.ts: hardExitCore owns the process-exit contract (registries, endpoint, sandbox, exit 130)", () => {
  const core = src.match(/^  const hardExitCore = \(\): void => \{[\s\S]*?^  \};/m);
  expect(core).not.toBeNull();
  const body = core![0];
  for (const needle of ["subagentRegistry.cancelAll()", "jobRegistry.cancelAll()", "monitorRegistry.cancelAll()", "stopSessionNotifyEndpoint(subagentRegistry)", "turnSandboxScope.supervisor.close()", "process.exit(130)"]) {
    expect(body).toContain(needle);
  }
  // No terminal/prompt state in the core: that only exists after the REPL is set up.
  expect(body).not.toMatch(/disarmPreview|restorePromptRawMode|out\.write/);
});

test("launch.ts: one-shot exit pauses a TTY stdin so the event loop can drain (hang-after-answer)", () => {
  // Second field finding: the in-flight harness `resume()`s a TTY stdin and `dispose()`
  // only reverts raw mode, so `jeo "prompt"` run from a real terminal printed its answer
  // and never returned to the shell (cli.ts only force-exits on a NON-zero code).
  // Verified live in a pty: without the pause → 35s timeout; with → exit 0 in ~8s.
  const oneShotFinally = src.match(/^  if \(isOneShot\) \{[\s\S]*?^    \} finally \{[\s\S]*?^    \}\n  \}/m);
  expect(oneShotFinally).not.toBeNull();
  expect(oneShotFinally![0]).toMatch(/if \(process\.stdin\.isTTY\) process\.stdin\.pause\(\);/);
});

test("in-flight terminal input restores only the raw mode it enabled and removes its listeners", () => {
  const rawModes: boolean[] = [];
  let data: ((chunk: string | Uint8Array) => void) | undefined;
  let resumes = 0;
  const before = process.listenerCount("SIGINT");
  const stdin = {
    isTTY: true, isRaw: false,
    on(_event: string, handler: (chunk: string | Uint8Array) => void) { data = handler; },
    off(_event: string, handler: (chunk: string | Uint8Array) => void) { if (data === handler) data = undefined; },
    setRawMode(value: boolean) { rawModes.push(value); },
    resume() { resumes++; },
  };
  const buffered: string[] = [];
  const harness = createInFlightAbortHarness({ stdin, captureEsc: true, onBufferedInput: chunk => buffered.push(chunk) });
  try {
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    expect(resumes).toBe(1);
    data?.("typing");
    expect(buffered).toEqual(["typing"]);
  } finally {
    harness.dispose();
  }
  expect(data).toBeUndefined();
  expect(rawModes).toEqual([true, false]);
  expect(process.listenerCount("SIGINT")).toBe(before);
});

test("in-flight input leaves an already-raw terminal unchanged", () => {
  const rawModes: boolean[] = [];
  const stdin = { isTTY: true, isRaw: true, on() {}, off() {}, setRawMode(value: boolean) { rawModes.push(value); }, resume() {} };
  const harness = createInFlightAbortHarness({ stdin, captureEsc: true });
  harness.dispose();
  expect(rawModes).toEqual([]);
});

test("hard SIGINT restores harness-owned raw mode before the exit callback", () => {
  for (const initiallyRaw of [false, true]) {
    const events: string[] = [];
    const stdin = {
      isTTY: true, isRaw: initiallyRaw, on() {}, off() {}, resume() {},
      setRawMode(value: boolean) { events.push(`raw:${value}`); },
    };
    const harness = createInFlightAbortHarness({
      stdin, captureEsc: true, onHardExit: () => events.push("exit"),
    });
    try {
      harness.handleSigint();
      expect(harness.controller.signal.aborted).toBe(true);
      expect(events).toEqual(initiallyRaw ? ["exit"] : ["raw:true", "raw:false", "exit"]);
    } finally { harness.dispose(); }
  }
});


// The engine mock is installed only in a child process, so it cannot leak into
// task-tool or any other test importing the real engine in this Bun test run.
async function runIsolatedScenario(scenario: string): Promise<void> {
  const worker = fileURLToPath(new URL("./fixtures/launch-oneshot-lifecycle.ts", import.meta.url));
  const proc = Bun.spawn([process.execPath, worker, scenario], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  const code = await proc.exited;
  expect(code, `isolated ${scenario} failed:\n${await stdout}\n${await stderr}`).toBe(0);
}

test("one-shot completion pauses terminal stdin, but does not pause piped input", async () => {
  await runIsolatedScenario("completion");
});

test("one-shot failure still pauses terminal stdin and removes the SIGINT handler", async () => {
  await runIsolatedScenario("failure");
});

test("one-shot SIGINT aborts the active turn and requests exit 130", async () => {
  await runIsolatedScenario("sigint");
});
