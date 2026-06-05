import { test, expect } from "bun:test";
import { LaunchTui } from "../src/tui/app";
import { hideCursor, showCursor, clearToEnd } from "../src/tui/terminal";

test("LaunchTui.usable is false under a non-TTY test process", () => {
  expect(LaunchTui.usable(false)).toBe(false); // bun test stdout is not a TTY
  expect(LaunchTui.usable(true)).toBe(false); // --no-tui always false
});

test("LaunchTui: footer step denominator reflects the configured maxSteps", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", maxSteps: 50, write: s => out.push(s) });
  tui.start();
  tui.events().onStep!(1);
  expect(out.join("")).toContain("step 1/50");
});

test("LaunchTui: footer defaults to 25 steps when maxSteps is omitted", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", write: s => out.push(s) });
  tui.start();
  tui.events().onStep!(3);
  expect(out.join("")).toContain("step 3/25");
});

test("LaunchTui: live region renders tool list + footer, finish collapses to static output", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", sessionId: "abcd1234efgh", write: s => out.push(s) });

  tui.start();
  const live = out.join("");
  expect(live).toContain(hideCursor()); // cursor hidden on start
  expect(live).toContain("m1"); // footer shows the model

  const ev = tui.events();
  ev.onStep!(1);
  ev.onAssistant!("", { tool: "write" });
  ev.onToolResult!("write", true);
  const afterTool = out.join("");
  expect(afterTool).toContain("write"); // tool row rendered
  expect(afterTool).toContain("ok"); // finished ok

  // Capture the static final output printed by finish().
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logged.push(a.join(" "));
  try {
    tui.finish("all done");
  } finally {
    console.log = origLog;
  }

  const finalText = logged.join("\n");
  expect(finalText).toContain("joc> all done"); // reply printed statically
  expect(finalText).toContain("write"); // tool summary retained
  const tail = out.join("");
  expect(tail).toContain(showCursor()); // cursor restored
  expect(tail).toContain(clearToEnd()); // live region cleared before static print
});
