import { test, expect } from "bun:test";
import { LaunchTui } from "../src/tui/app";
import { hideCursor, showCursor, clearToEnd, enterAltScreen, leaveAltScreen } from "../src/tui/terminal";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

test("LaunchTui: shows a 'calling model' status while waiting on the model, then the tool", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", write: s => out.push(s) });
  tui.start();
  const ev = tui.events();
  ev.onStep!(1); // step begins → waiting on the model
  expect(out.join("")).toContain("calling model (m1)");
  out.length = 0;
  ev.onAssistant!("", { tool: "bash", arguments: { command: "echo hi" } }); // model replied → tool runs
  const afterAssistant = out.join("");
  expect(afterAssistant).not.toContain("calling model");
});
test("LaunchTui: on a TTY the live turn stays in the MAIN buffer so wheel-scroll reaches earlier progress", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
  tui.start();
  const live = out.join("");
  // gjc-style inline rendering: NO alt screen — tmux/terminal scrollback keeps working mid-turn.
  expect(live).not.toContain(enterAltScreen());
  expect(live).toContain(hideCursor());
  expect(live).toContain(clearToEnd()); // anchor cleared once so stale rows can't bleed in

  // A completed tool result is FLUSHED into normal scrollback while the turn runs:
  // clear the live frame from its anchor, write the static ledger line + "\n", then
  // repaint the frame below it (the next reserve scrolls the line into history).
  out.length = 0;
  const ev = tui.events();
  ev.onStep!(1);
  ev.onAssistant!("", { tool: "read", arguments: { filePath: "src/cli.ts" } });
  ev.onToolResult!("read", true, "1|const ok = true;");
  const ledger = out.join("");
  const flushIdx = ledger.indexOf("\x1b[0J");
  expect(flushIdx).toBeGreaterThanOrEqual(0);
  expect(ledger.slice(flushIdx)).toContain("read src/cli.ts\n"); // static line, newline-terminated

  clearInterval((tui as unknown as { timer: ReturnType<typeof setInterval> }).timer);
  out.length = 0;
  tui.finish("ok");
  const tail = out.join("");
  expect(tail).not.toContain(leaveAltScreen()); // never entered, never left
  expect(tail).toContain(showCursor());
  // Final summary still printed with clear-to-EOL per line + clear-below hygiene…
  expect(tail).toContain("joc> ok");
  expect(tail).toContain("\x1b[K");
  expect(tail).toContain("\x1b[0J");
  // …but WITHOUT re-printing the ledger lines already flushed into scrollback live.
  expect(tail).not.toContain("read src/cli.ts\n\x1b[K");
});

test("LaunchTui: JOC_TUI_ALT_SCREEN=1 opts back into the legacy alternate-screen turn", () => {
  const orig = process.env.JOC_TUI_ALT_SCREEN;
  process.env.JOC_TUI_ALT_SCREEN = "1";
  try {
    const out: string[] = [];
    const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
    tui.start();
    const live = out.join("");
    // Enters the alt screen before hiding the cursor → scroll can't fight the repaint.
    expect(live).toContain(enterAltScreen());
    expect(live.indexOf(enterAltScreen())).toBeLessThan(live.indexOf(hideCursor()));
    expect(live).not.toContain(leaveAltScreen()); // not left yet
    // Mouse-wheel guard: alternate scroll is disabled inside the alt screen so a wheel
    // scroll (tmux or plain terminal) cannot inject Up/Down arrows into the input buffer.
    expect(enterAltScreen()).toContain("\x1b[?1007l");
    expect(leaveAltScreen()).toContain("\x1b[?1007h");

    tui.finish("ok");
    const tail = out.join("");
    expect(tail).toContain(leaveAltScreen()); // restored main buffer on finish
    expect(tail).toContain(showCursor());
    // Final summary is WRITTEN to the main buffer (scrollback) AFTER leaving the alt
    // screen, with clear-to-EOL per line + clear-below so stale pre-turn rows (old
    // footer box, context lines) never merge into the summary or leave a torn box.
    const afterLeave = tail.slice(tail.indexOf(leaveAltScreen()));
    expect(afterLeave).toContain("joc> ok");
    expect(afterLeave).toContain("\x1b[K");
    expect(afterLeave).toContain("\x1b[0J");
  } finally {
    if (orig === undefined) delete process.env.JOC_TUI_ALT_SCREEN;
    else process.env.JOC_TUI_ALT_SCREEN = orig;
  }
});

test("LaunchTui: subagent progress lines are flushed into scrollback mid-turn on a TTY", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
  tui.start();
  out.length = 0;
  tui.onSubagentEvent({ role: "executor", kind: "start", detail: "Add a retry guard" });
  tui.onSubagentEvent({ role: "executor", kind: "tool", detail: "read src/agent/engine.ts", success: true });
  clearInterval((tui as unknown as { timer: ReturnType<typeof setInterval> }).timer);
  const ledger = out.join("");
  // Both nested events became static scrollback lines (clear-frame + text + "\n").
  expect(ledger).toContain("start: Add a retry guard\n");
  expect(ledger).toContain("read src/agent/engine.ts\n");
  tui.finish("done");
});

test("LaunchTui: without a TTY the alt screen is NOT used (plain in-place render)", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: false, write: s => out.push(s) });
  tui.start();
  tui.finish("done");
  const all = out.join("");
  expect(all).not.toContain(enterAltScreen());
  expect(all).not.toContain(leaveAltScreen());
  expect(all).toContain(clearToEnd()); // legacy path clears in place instead
});

test("LaunchTui auto-repair: repaint() rewrites the FULL frame after external corruption", () => {
  const realRender = Renderer.prototype.render;
  let lastFrame: string[] = [];
  (Renderer.prototype as unknown as { render: (f: string[]) => void }).render = function (f: string[]) { lastFrame = f; };
  try {
    const tui = new LaunchTui({ model: "m1", maxSteps: 25, tty: true, write: () => {} });
    tui.start();
    clearInterval((tui as unknown as { timer: ReturnType<typeof setInterval> }).timer);
    lastFrame = [];
    // Auto-heal entry point used by resize + mid-turn input noise: must redraw everything.
    tui.repaint();
    expect(lastFrame.length).toBeGreaterThan(0);
    tui.finish("done");
  } finally {
    Renderer.prototype.render = realRender;
  }
});

test("LaunchTui auto-repair: resize listener is registered on start and removed on finish", () => {
  const realRender = Renderer.prototype.render;
  (Renderer.prototype as unknown as { render: (f: string[]) => void }).render = function () {};
  const before = process.stdout.listenerCount("resize");
  try {
    const tui = new LaunchTui({ model: "m1", maxSteps: 25, tty: true, write: () => {} });
    tui.start();
    clearInterval((tui as unknown as { timer: ReturnType<typeof setInterval> }).timer);
    expect(process.stdout.listenerCount("resize")).toBe(before + 1);
    tui.finish("done");
    expect(process.stdout.listenerCount("resize")).toBe(before);
  } finally {
    Renderer.prototype.render = realRender;
  }
});
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

test("LaunchTui: setTodos renders a plan checklist in live and final output", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", write: s => out.push(s) });
  tui.start();
  tui.setTodos([
    { title: "Scaffold module", status: "done" },
    { title: "Write tests", status: "in_progress" },
    { title: "Run suite", status: "pending" },
  ]);
  const live = out.join("");
  expect(live).toContain("Plan");
  expect(live).toContain("Scaffold module");
  expect(live).toContain("Write tests");

  const logged: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logged.push(a.join(" "));
  try {
    tui.finish("done");
  } finally {
    console.log = origLog;
  }
  const finalText = logged.join("\n");
  expect(finalText).toContain("Run suite"); // plan retained in static output
});

test("LaunchTui: corrupt deep-interview state shows fail-closed mutation lock", async () => {
  const originalCwd = process.cwd();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-tui-lock-"));
  try {
    await fs.mkdir(path.join(dir, ".joc", "state"), { recursive: true });
    await fs.writeFile(path.join(dir, ".joc", "state", "deep-interview-state.json"), "{ nope", "utf8");
    process.chdir(dir);

    const out: string[] = [];
    const tui = new LaunchTui({ model: "m1", write: s => out.push(s) });
    tui.start();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(out.join("")).toContain("MUTATION LOCKED");
    const origLog = console.log;
    console.log = () => {};
    try {
      tui.finish("done");
    } finally {
      console.log = origLog;
    }
  } finally {
    process.chdir(originalCwd);
    await fs.rm(dir, { recursive: true, force: true });
  }
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

test("LaunchTui: multiple onStep renders do not produce duplicate footers in output array and do not exceed block height", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", write: s => out.push(s) });
  tui.start();
  
  const ev = tui.events();
  ev.onAssistant!("", { tool: "write" });
  ev.onStep!(1);
  ev.onStep!(2);
  ev.onStep!(3);
  
  // 1. Verify that ANSI cursor-up codes do not exceed the rendered block height.
  // The live frame now includes evolution art, tool rows, forge boxes, two status rows, and footer.
  const blockHeight = 24;
  for (const chunk of out) {
    const cursorUpRegex = /\x1b\[(\d+)A/g;
    let match;
    while ((match = cursorUpRegex.exec(chunk)) !== null) {
      const n = parseInt(match[1], 10);
      expect(n).toBeLessThanOrEqual(blockHeight);
    }
  }

  // 2. Verify each chunk in the output array contains at most one footer
  for (const chunk of out) {
    const footerCount = (chunk.match(/m1 ·/g) || []).length;
    expect(footerCount).toBeLessThanOrEqual(1);
  }

  // 3. Verify that there are no duplicate footers in the simulated terminal screen lines.
  const lines = simulateTerminal(out);
  const footerLines = lines.filter(l => l.includes("m1"));
  expect(footerLines.length).toBeLessThanOrEqual(1);
});

function simulateTerminal(writes: string[]): string[] {
  const lines: string[] = [];
  let cursorRow = 0;

  for (const write of writes) {
    let i = 0;
    while (i < write.length) {
      if (write.startsWith("\x1b[", i)) {
        const endIdx = write.indexOf("A", i);
        const endB = write.indexOf("B", i);
        const endG = write.indexOf("G", i);
        const endK = write.indexOf("K", i);
        const endJ = write.indexOf("J", i);
        const endH = write.indexOf("h", i);
        const endL = write.indexOf("l", i);
        
        const ends = [
          { char: 'A', idx: endIdx },
          { char: 'B', idx: endB },
          { char: 'G', idx: endG },
          { char: 'K', idx: endK },
          { char: 'J', idx: endJ },
          { char: 'h', idx: endH },
          { char: 'l', idx: endL }
        ].filter(e => e.idx !== -1).sort((a, b) => a.idx - b.idx);
        
        if (ends.length > 0) {
          const first = ends[0];
          const seq = write.substring(i, first.idx + 1);
          i = first.idx + 1;
          
          if (first.char === 'A') {
            const match = seq.match(/\d+/);
            const n = parseInt(match ? match[0] : "1", 10);
            cursorRow = Math.max(0, cursorRow - n);
          } else if (first.char === 'B') {
            const match = seq.match(/\d+/);
            const n = parseInt(match ? match[0] : "1", 10);
            cursorRow = cursorRow + n;
          } else if (first.char === 'K') {
            if (lines[cursorRow] !== undefined) {
              lines[cursorRow] = "";
            }
          } else if (first.char === 'J') {
            lines.length = cursorRow;
          }
        } else {
          i += 2;
        }
      } else {
        let nextEsc = write.indexOf("\x1b[", i);
        if (nextEsc === -1) nextEsc = write.length;
        const text = write.substring(i, nextEsc);
        i = nextEsc;
        
        if (text) {
          lines[cursorRow] = text;
        }
      }
    }
  }
  return lines;
}

import { Renderer } from "../src/tui/renderer";

test("LaunchTui (boxed): bottom status/footer is never cut off when content overflows the terminal", () => {
  const realRender = Renderer.prototype.render;
  let frame: string[] = [];
  (Renderer.prototype as unknown as { render: (f: string[]) => void }).render = function (f: string[]) { frame = f; };
  const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  try {
    // tty:true forces the boxed full-screen layout; size() defaults to 80x24.
    const tui = new LaunchTui({ model: "m1", provider: "ollama", sessionId: "sess1234", maxSteps: 25, tty: true, write: () => {} });
    tui.start();
    const ev = tui.events();
    tui.setTodos([
      { title: "alpha", status: "done" },
      { title: "bravo", status: "in_progress" },
      { title: "charlie", status: "pending" },
    ]);
    // Drive enough tool activity to overflow a 24-row terminal (art + plan + tools + stream + forge).
    for (let s = 1; s <= 6; s++) {
      ev.onStep!(s);
      ev.onAssistant!("", { tool: "bash", arguments: { command: "bun test" } });
      ev.onToolResult!("bash", true, "543 pass");
    }
    (tui as unknown as { draw: () => void }).draw();
    clearInterval((tui as unknown as { timer: ReturnType<typeof setInterval> }).timer);

    const txt = frame.map(strip);
    expect(frame.length).toBeLessThanOrEqual(24);          // fits inside the terminal height
    // The live footer (model + step counter) and the key-hint bar must both survive at the bottom.
    expect(txt.some(l => l.includes("m1") && l.includes("step"))).toBe(true);
    expect(txt.some(l => /\/exit|\/help/i.test(l))).toBe(true);
    // The very last content row (above the bottom border) is the footer, not a forge box / blank.
    const lastContent = txt[txt.length - 2] ?? "";
    expect(lastContent).toContain("m1");
  } finally {
    Renderer.prototype.render = realRender;
  }
});

test("LaunchTui: onSubagentEvent surfaces delegated subagent progress + result in the stream", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", write: s => out.push(s) });
  tui.start();
  tui.onSubagentEvent({ role: "executor", kind: "start", detail: "Add a retry guard to engine.ts" });
  tui.onSubagentEvent({ role: "executor", kind: "step", detail: "read src/agent/engine.ts", step: 1, maxSteps: 15 });
  tui.onSubagentEvent({ role: "executor", kind: "tool", detail: "read src/agent/engine.ts", success: true, summary: "1|const ok = true;" });
  tui.onSubagentEvent({ role: "executor", kind: "tool", detail: "edit src/agent/engine.ts", success: false });
  tui.onSubagentEvent({ role: "executor", kind: "done", detail: "completed in 4 steps: guard added", success: true });
  clearInterval((tui as unknown as { timer: ReturnType<typeof setInterval> }).timer);

  const logged: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logged.push(a.join(" "));
  try { tui.finish("done"); } finally { console.log = origLog; }
  const txt = logged.join("\n");
  expect(txt).toContain("[AGENT]"); // every nested line carries the subagent category badge
  // Glyph is "▸" on unicode-capable terminals, ">" otherwise — accept both.
  expect(txt).toMatch(/executor [>▸] start: Add a retry guard to engine\.ts/); // assignment
  expect(txt).toContain("[AGENT] executor step 1/15:"); // step header
  expect(txt).toContain("read src/agent/engine.ts");
  expect(txt).toContain("1|const ok = true;");
  expect(txt).toContain("done: completed in 4 steps: guard added"); // result summary
});

test("LaunchTui: onToolResult categorizes the result in the stream with both category and status badges", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", write: s => out.push(s) });
  tui.start();
  const ev = tui.events();
  ev.onStep!(1);
  ev.onAssistant!("", { tool: "read", arguments: { filePath: "src/cli.ts" } });
  ev.onToolResult!("read", true, "1|const ok = true;");

  const logged: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logged.push(a.join(" "));
  try { tui.finish("done"); } finally { console.log = origLog; }
  const txt = logged.join("\n");
  expect(txt).toContain("[FILE]"); // category of read
  expect(txt).toContain("[DONE]"); // success status
  expect(txt).toContain("read src/cli.ts");
});

test("LaunchTui: onToolResult stream line includes the invocation target using write-sink pattern", () => {
  const buf: string[] = [];
  const tui = new LaunchTui({ model: "m", tty: false, write: s => buf.push(s) });
  tui.start();
  const ev = tui.events();
  ev.onStep!(1);
  ev.onAssistant!("", { tool: "bash", arguments: { command: "bun test" } });
  ev.onToolResult!("bash", false, "1 fail");

  const logged: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logged.push(a.join(" "));
  try {
    tui.finish("done");
  } finally {
    console.log = origLog;
  }
  const txt = logged.join("\n");
  expect(txt).toContain("bash command");
});

test("LaunchTui (boxed): [STATUS] shows the real in-flight file; stage lives in the track, not the forge row", () => {
  const realRender = Renderer.prototype.render;
  let frame: string[] = [];
  (Renderer.prototype as unknown as { render: (f: string[]) => void }).render = function (f: string[]) { frame = f; };
  const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  // Pin the viewport: on a narrow/short runner terminal the centered art/track is
  // dropped and the footer stage tag can be width-truncated, making the stage
  // assertion flaky. 200x40 keeps both deterministic. (columns/rows are accessor
  // properties in Bun — override via defineProperty, restore the descriptors after.)
  const savedColsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  const savedRowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  Object.defineProperty(process.stdout, "columns", { value: 200, configurable: true });
  Object.defineProperty(process.stdout, "rows", { value: 40, configurable: true });
  try {
    const tui = new LaunchTui({ model: "m1", maxSteps: 25, tty: true, write: () => {} });
    tui.start();
    const ev = tui.events();
    ev.onStep!(8); // 8/25 = 32% → evolution stage 2 (Double Helix) is reached
    ev.onAssistant!("", { tool: "read", arguments: { filePath: "src/agent/engine.ts" } }); // tool now in-flight
    (tui as unknown as { draw: () => void }).draw();
    clearInterval((tui as unknown as { timer: ReturnType<typeof setInterval> }).timer);

    const txt = frame.map(strip);
    const statusLine = txt.find(l => l.includes("[STATUS]")) ?? "";
    const stepLine = txt.find(l => l.includes("[STEP]")) ?? "";
    const toolLine = txt.find(l => l.includes("joc forge")) ?? "";
    // [STATUS] reflects the actual file, while [STEP] stays metric-only.
    expect(statusLine).toContain("src/agent/engine.ts");
    expect(stepLine).not.toContain("src/agent/engine.ts");
    expect(statusLine).not.toContain("Transcribing instructions");
    // The evolution stage is rendered in the centered track/footer, not duplicated in the forge row.
    expect(toolLine).not.toContain("Double Helix");
    expect(txt.some(l => /Primordial Cell|Double Helix|Tool User|Super intelligence/.test(l))).toBe(true);
  } finally {
    Renderer.prototype.render = realRender;
    if (savedColsDesc) Object.defineProperty(process.stdout, "columns", savedColsDesc);
    if (savedRowsDesc) Object.defineProperty(process.stdout, "rows", savedRowsDesc);
  }
});
