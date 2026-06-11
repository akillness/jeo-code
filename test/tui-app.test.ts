import { test, expect } from "bun:test";
import { LaunchTui } from "../src/tui/app";
import { visibleWidth } from "../src/tui/components/width";
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
  const cleanOut = out.join("").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  expect(cleanOut).toContain("calling model (m1)");
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
  // Every frame row is painted with per-line EL — never an ED clear, which tmux
  // would copy into scrollback (one full frame per repaint = flooded history).
  expect(live).toContain("\x1b[2K");

  // A completed tool result is FLUSHED into normal scrollback while the turn runs:
  // overwrite the frame's first row with the static ledger line + "\n" inside a
  // synchronized update, then repaint the frame below it (the next reserve scrolls
  // the line into history). No \x1b[0J — tmux pushes ED-erased rows into history.
  out.length = 0;
  const ev = tui.events();
  ev.onStep!(1);
  ev.onAssistant!("", { tool: "read", arguments: { filePath: "src/cli.ts" } });
  ev.onToolResult!("read", true, "1|const ok = true;");
  const ledger = out.join("");
  const flushIdx = ledger.indexOf("\x1b[?2026h"); // BSU opens the atomic flush
  expect(flushIdx).toBeGreaterThanOrEqual(0);
  expect(ledger.slice(flushIdx)).toContain("Read src/cli.ts\n"); // static line, newline-terminated
  expect(ledger.slice(flushIdx)).toContain("\x1b[?2026l");       // ESU after the repaint
  expect(ledger).not.toContain("\x1b[0J");                       // never ED mid-turn (history flood)

  clearInterval((tui as unknown as { timer: ReturnType<typeof setInterval> }).timer);
  out.length = 0;
  tui.finish("ok");
  const tail = out.join("");
  expect(tail).not.toContain(leaveAltScreen()); // never entered, never left
  expect(tail).toContain(showCursor());
  // Final summary still printed with clear-to-EOL per line + clear-below hygiene…
  expect(tail).toContain("jeo> ok");
  expect(tail).toContain("\x1b[K");
  expect(tail).toContain("\x1b[0J");
  // …but WITHOUT re-printing the ledger lines already flushed into scrollback live.
  expect(tail).not.toContain("Read src/cli.ts\n\x1b[K");
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
    expect(afterLeave).toContain("jeo> ok");
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

test("LaunchTui (inline): flushed ledger lines are NOT duplicated inside the live frame", () => {
  const realRender = Renderer.prototype.render;
  let frame: string[] = [];
  (Renderer.prototype as unknown as { render: (f: string[]) => void }).render = function (f: string[]) { frame = f; };
  const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  try {
    const tui = new LaunchTui({ model: "m1", tty: true, write: () => {} });
    tui.start();
    const ev = tui.events();
    ev.onStep!(1);
    ev.onAssistant!("", { tool: "read", arguments: { filePath: "src/cli.ts" } });
    ev.onToolResult!("read", true, "ok");
    (tui as unknown as { draw: () => void }).draw();
    clearInterval((tui as unknown as { timer: ReturnType<typeof setInterval> }).timer);
    // The flushed stream line carries both badges; the frame must not repeat it
    // (tool list + forge boxes keep showing the activity in their own formats).
    const txt = frame.map(strip);
    expect(txt.some(l => l.includes("[FILE]") && l.includes("[DONE]"))).toBe(false);
    tui.finish("done");
  } finally {
    Renderer.prototype.render = realRender;
  }
});

test("LaunchTui: flushed tool-result ledger lines lead with a gjc-style ✔/✗ glyph", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
  tui.start();
  const ev = tui.events();
  ev.onStep!(1);
  out.length = 0;
  ev.onAssistant!("", { tool: "read", arguments: { filePath: "src/cli.ts" } });
  ev.onToolResult!("read", true, "ok");
  ev.onAssistant!("", { tool: "bash", arguments: { command: "false" } });
  ev.onToolResult!("bash", false, "boom");
  clearInterval((tui as unknown as { timer: ReturnType<typeof setInterval> }).timer);
  const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const ledger = strip(out.join(""));
  // Glyph leads the line (unicode terminals → ✓/✗, ASCII → v/x); no badge clutter.
  expect(ledger).toMatch(/[✓v] Read src\/cli\.ts/);
  expect(ledger).toMatch(/[✗x] Bash/);
  tui.finish("done");
});

test("LaunchTui: ledger glyphs fall back to v/x on ASCII-only terminals", () => {
  // supportsUnicode() reads env; pin an ASCII terminal deterministically.
  const origTerm = process.env.TERM;
  process.env.TERM = "dumb";
  try {
    const out: string[] = [];
    const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
    tui.start();
    const ev = tui.events();
    ev.onStep!(1);
    out.length = 0;
    ev.onAssistant!("", { tool: "read", arguments: { filePath: "src/cli.ts" } });
    ev.onToolResult!("read", true, "ok");
    ev.onAssistant!("", { tool: "bash", arguments: { command: "false" } });
    ev.onToolResult!("bash", false, "boom");
    clearInterval((tui as unknown as { timer: ReturnType<typeof setInterval> }).timer);
    const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    const ledger = strip(out.join(""));
    expect(ledger).toMatch(/v Read src\/cli\.ts/);
    expect(ledger).toMatch(/x Bash/);
    // Ledger lines specifically must not use the unicode marks (other frame
    // components own their own glyph fallbacks).
    expect(ledger).not.toMatch(/✓ Read/);
    expect(ledger).not.toMatch(/✗ Bash/);
    tui.finish("done");
  } finally {
    if (origTerm === undefined) delete process.env.TERM;
    else process.env.TERM = origTerm;
  }
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

test("LaunchTui: footer defaults to 100 steps when maxSteps is omitted", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", write: s => out.push(s) });
  tui.start();
  tui.events().onStep!(3);
  expect(out.join("")).toContain("step 3/100");
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
  expect(live).toContain("Todos");
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
  expect(finalText).toContain("jeo> all done"); // reply printed statically
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

  const lines = simulateTerminal(out);
  const footerLines = lines.filter(l => l.includes("m1") && l.includes("step"));
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
          const parts = text.split("\n");
          for (let p = 0; p < parts.length; p++) {
            if (p > 0) {
              cursorRow++;
            }
            const part = parts[p];
            if (part) {
              lines[cursorRow] = part;
            }
          }
        }
      }
    }
  }
  return lines.filter(l => l !== undefined);
}

import { Renderer } from "../src/tui/renderer";

test("LaunchTui (inline): status line and model bar are never cut off when content overflows the terminal", () => {
  const realRender = Renderer.prototype.render;
  let frame: string[] = [];
  (Renderer.prototype as unknown as { render: (f: string[]) => void }).render = function (f: string[]) { frame = f; };
  const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  try {
    // tty:true uses the gjc-style inline layout; size() defaults to 80x24.
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
    // The status line (step counter) and the model bar must both survive at the bottom.
    expect(txt.some(l => l.includes("step"))).toBe(true);
    // The very last row of the inline frame is the gjc-style model bar.
    const lastContent = txt[txt.length - 1] ?? "";
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

test("LaunchTui: onToolResult flushes a gjc-style glyph-led ledger line for the target", () => {
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
  expect(txt).toMatch(/[✓v] Read src\/cli\.ts/); // glyph-led, badge-free ledger line
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
  expect(txt).toContain("Bash");        // merged gjc-style card title
  expect(txt).toContain("$ bun test");  // command echo inside the card
});

test("LaunchTui (alt-screen boxed): status box shows the in-flight file; steps in the title; stage in the track", () => {
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
  const savedAlt = process.env.JOC_TUI_ALT_SCREEN;
  process.env.JOC_TUI_ALT_SCREEN = "1";
  try {
    const tui = new LaunchTui({ model: "m1", maxSteps: 25, tty: true, write: () => {} });
    tui.start();
    const ev = tui.events();
    ev.onStep!(8); // 8/25 = 32% → evolution stage 2 (Double Helix) is reached
    ev.onAssistant!("", { tool: "read", arguments: { filePath: "src/agent/engine.ts" } }); // tool now in-flight
    (tui as unknown as { draw: () => void }).draw();
    clearInterval((tui as unknown as { timer: ReturnType<typeof setInterval> }).timer);

    const txt = frame.map(strip);
    // gjc status-box contract: steps live in the TITLE border row…
    const titleLine = txt.find(l => /step 8\/25/.test(l)) ?? "";
    expect(titleLine).toMatch(/executing|thinking/);
    expect(titleLine).not.toContain("src/agent/engine.ts");
    // …and the activity row inside the box names the real in-flight file.
    const activityLine = txt.find(l => /[Rr]ead.*src\/agent\/engine\.ts.*(⟦esc⟧|\[esc\])/.test(l)) ?? "";
    expect(activityLine).not.toBe("");
    expect(activityLine).not.toContain("Transcribing instructions");
    // The evolution stage is rendered in the centered track/footer, not in the status box.
    expect(titleLine).not.toContain("Double Helix");
    expect(txt.some(l => /Primordial Cell|Double Helix|Tool User|Super intelligence/.test(l))).toBe(true);
  } finally {
    if (savedAlt === undefined) delete process.env.JOC_TUI_ALT_SCREEN;
    else process.env.JOC_TUI_ALT_SCREEN = savedAlt;
    Renderer.prototype.render = realRender;
    if (savedColsDesc) Object.defineProperty(process.stdout, "columns", savedColsDesc);
    if (savedRowsDesc) Object.defineProperty(process.stdout, "rows", savedRowsDesc);
  }
});

test("LaunchTui: find/search results flush a gjc-style count suffix + dim tree children into the ledger", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
  tui.start();
  clearInterval((tui as unknown as { timer: ReturnType<typeof setInterval> }).timer);
  const ev = tui.events();
  ev.onStep!(1);
  ev.onAssistant!("", { tool: "find", arguments: { globPattern: "src/**/*.ts" } });
  out.length = 0;
  const files = Array.from({ length: 8 }, (_, i) => `./src/file-${i}.ts`).join("\n");
  ev.onToolResult!("find", true, files);
  const flushed = out.join("").replace(/\x1b\[[0-9;]*m/g, "");
  expect(flushed).toContain("· 8 files");          // count suffix on the summary line
  // sampled child rows + overflow tail — unicode (├─/└─) or ASCII (|-/`-) per terminal capability
  expect(flushed).toMatch(/(?:├─|\|-) \.\/src\/file-0\.ts/);
  expect(flushed).toMatch(/(?:└─|`-) (?:…|\.\.\.) 2 more files/);
  // read results stay single-line — no tree decoration
  ev.onAssistant!("", { tool: "read", arguments: { filePath: "a.ts" } });
  out.length = 0;
  ev.onToolResult!("read", true, "1|x\n2|y\n3|z");
  const readFlushed = out.join("").replace(/\x1b\[[0-9;]*m/g, "");
  expect(readFlushed).not.toMatch(/(?:├─|\|-) /);
  expect(readFlushed).not.toContain("· 3 files");
  tui.finish("done");
});

test("LaunchTui: ledger lines longer than the terminal are width-wrapped before flush (no row-accounting tear)", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
  tui.start();
  const ev = tui.events();
  ev.onStep!(1);
  const colsNow = Math.max(20, process.stdout.columns || 80);
  const longPath = "src/" + "deeply/nested/".repeat(Math.ceil((colsNow * 2) / 14)) + "file.ts"; // ≥ 2× terminal width
  ev.onAssistant!("", { tool: "read", arguments: { filePath: longPath } });
  out.length = 0;
  ev.onToolResult!("read", true, "ok");
  clearInterval((tui as unknown as { timer: ReturnType<typeof setInterval> }).timer);
  const cols = Math.max(20, process.stdout.columns || 80);
  // The ledger lines carrying the over-long target must be width-wrapped to the
  // terminal: an over-wide flushed line hard-wraps into 2+ physical rows and breaks
  // the renderer's 1-line=1-row reservation (the screen-tear bug).
  const flushed = out.join("");
  expect(flushed.indexOf("\x1b[?2026h")).toBeGreaterThanOrEqual(0);
  const stripA = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\]2;[^\x07]*\x07/g, "");
  const ledgerLines = stripA(flushed).split("\n").filter(l => l.includes("deeply/nested"));
  expect(ledgerLines.length).toBeGreaterThanOrEqual(2); // long target wrapped across rows
  for (const line of ledgerLines) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
  }
  tui.finish("done");
});

test("LaunchTui.finish: a long reply is width-wrapped — no physical line exceeds the terminal (result-screen 화면깨짐 fix)", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
  tui.start();
  tui.events().onStep!(1);
  const cols = Math.max(20, process.stdout.columns || 80);
  // A consolidation-style wrap-up: one long logical line far wider than the terminal.
  const longReply = "Consolidated: " + "scanned and refactored the parser and wired tests ".repeat(8);
  out.length = 0;
  clearInterval((tui as unknown as { timer: ReturnType<typeof setInterval> }).timer);
  tui.finish(longReply);
  // Strip ANSI/OSC, then a leading carriage-return (cursor-to-col-0, zero display width).
  const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
  const physical = strip(out.join("")).split("\n").map(l => l.replace(/^\r/, ""));
  const over = physical.filter(l => visibleWidth(l) > cols);
  expect(over).toEqual([]); // every result-screen row fits the terminal width
  // And the reply content actually survived the wrap (not truncated away).
  expect(strip(out.join("")).replace(/\r/g, "")).toContain("Consolidated:");
});
