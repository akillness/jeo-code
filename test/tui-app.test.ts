import { test, expect } from "bun:test";
import { LaunchTui } from "../src/tui/app";
import { hideCursor, showCursor, clearToEnd } from "../src/tui/terminal";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

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
