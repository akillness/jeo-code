import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractJsonObject } from "../src/agent/json";
import { editTool } from "../src/agent/tools";
import { createSession, appendMessage, loadSession, sessionPath } from "../src/agent/session";
import { LaunchTui } from "../src/tui/app";
import { renderAsciiArt, getStageByIndex } from "../src/tui/components/ascii-art";
import { resolveTheme } from "../src/tui/components/themes";
import { renderJocStatus } from "../src/tui/components/status";
import { ToolList } from "../src/tui/components/tool-list";
import { boxBlock, BOX_ASCII } from "../src/tui/components/layout";
import { visibleWidth } from "../src/tui/components/color";
import { formatForgeBox } from "../src/tui/components/forge";
import { EVOLUTION_SPINNER_FRAMES_ASCII } from "../src/tui/components/evolution";

// --- json.ts: scan past non-JSON braces (review LOW finding) ---

test("extractJsonObject: skips an earlier non-JSON brace group and finds the later valid object", () => {
  const text = 'I considered { not: json } then decided. {"tool":"done","arguments":{"reason":"ok"}} trailing.';
  expect(extractJsonObject(text)).toEqual({ tool: "done", arguments: { reason: "ok" } });
});

test("extractJsonObject: still throws when no balanced group is valid JSON", () => {
  expect(() => extractJsonObject("{ not json } and { also no }")).toThrow();
});

// --- tools.ts editTool: range validation + whitespace preservation (review MEDIUM finding) ---

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "joc-edit-"));
}

test("editTool: rejects an out-of-bounds line range without writing", async () => {
  const dir = await tmp();
  try {
    await fs.writeFile(path.join(dir, "a.txt"), "l1\nl2\nl3\n", "utf8");
    const res = await editTool("a.txt", "\u22545..6\nX", dir);
    expect(res.success).toBe(false);
    expect(res.error).toContain("out of bounds");
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("l1\nl2\nl3\n");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("editTool: search/replace preserves indentation (no trim)", async () => {
  const dir = await tmp();
  try {
    await fs.writeFile(path.join(dir, "a.ts"), "function f() {\n    return 1;\n}\n", "utf8");
    const editBlock = "<<<<<<< SEARCH\n    return 1;\n=======\n    return 2;\n>>>>>>>";
    const res = await editTool("a.ts", editBlock, dir);
    expect(res.success).toBe(true);
    const out = await fs.readFile(path.join(dir, "a.ts"), "utf8");
    expect(out).toBe("function f() {\n    return 2;\n}\n");
    expect(out).toContain("    return 2;"); // 4-space indent preserved
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("editTool: empty search block is rejected", async () => {
  const dir = await tmp();
  try {
    await fs.writeFile(path.join(dir, "a.txt"), "hello\n", "utf8");
    const res = await editTool("a.txt", "<<<<<<< SEARCH\n\n=======\nX\n>>>>>>>", dir);
    expect(res.success).toBe(false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- session.ts: tolerate a malformed (truncated) tail line (review MEDIUM finding) ---

test("loadSession: tolerates a malformed non-header line and keeps valid messages", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-sess-fix-"));
  try {
    const { id } = await createSession(dir);
    await appendMessage(id, { role: "user", content: "hi" }, dir);
    // Simulate a partial/corrupt append (e.g. crash mid-write).
    await fs.appendFile(sessionPath(id, dir), "{ this is not valid json\n", "utf8");
    await appendMessage(id, { role: "assistant", content: "yo" }, dir);

    const { messages } = await loadSession(id, dir);
    expect(messages.map(m => m.content)).toEqual(["hi", "yo"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
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

// --- TUI Review Fixes ---

test("FIX 1: clamp composed frame to terminal rows", () => {
  const originalColumns = process.stdout.columns;
  const originalRows = process.stdout.rows;
  const originalIsTTY = process.stdout.isTTY;

  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
  Object.defineProperty(process.stdout, "rows", { value: 15, configurable: true });

  try {
    const out: string[] = [];
    const tui = new LaunchTui({
      model: "m1",
      write: (s) => out.push(s),
    });

    tui.start();
    const ev = tui.events();
    ev.onStep!(1);
    
    // Add many tool runs to exceed the height
    for (let i = 0; i < 20; i++) {
      const idx = tui.tools.start("tool_" + i);
      tui.tools.finish(idx, true);
    }
    
    ev.onAssistant!("", { tool: "dummy" });

    const lines = simulateTerminal(out);
    console.log("LINES LENGTH:", lines.length);
    console.log("LINES:", JSON.stringify(lines, null, 2));
    expect(lines.length).toBeLessThanOrEqual(15);
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });
    Object.defineProperty(process.stdout, "columns", { value: originalColumns, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: originalRows, configurable: true });
  }
});

test("FIX 2: render art with theme.color=false -> output has no \\x1b[", () => {
  const stage = getStageByIndex(0);
  const theme = resolveTheme({ JOC_TUI_THEME: "mono" });
  expect(theme.color).toBe(false);
  const art = renderAsciiArt(stage, {
    color: theme.color,
  });
  const text = art.join("\n");
  expect(text).not.toContain("\x1b[");
});

test("FIX 3: renderJocStatus with color=false -> no \\x1b[", () => {
  const status = renderJocStatus({
    step: 1,
    maxSteps: 25,
    message: "thinking",
    color: false,
  });
  const text = status.join("\n");
  expect(text).not.toContain("\x1b[");
});

test("FIX 4: ToolList render with color=false -> no \\x1b[", () => {
  const tools = new ToolList();
  tools.start("test-tool");
  const rendered = tools.render(undefined, { color: false });
  const text = rendered.join("\n");
  expect(text).not.toContain("\x1b[");
});

test("FIX 5: boxBlock truncates content to inner width", () => {
  const content = ["this is a very long line that exceeds the box width"];
  const width = 20;
  const boxed = boxBlock(content, width, { glyphs: BOX_ASCII });
  
  for (const line of boxed) {
    expect(visibleWidth(line)).toBe(20);
    expect(line.endsWith("+") || line.endsWith("|")).toBe(true);
  }
});

test("FIX 6: render forge at innerWidth=20 -> every line visibleWidth <= innerWidth", () => {
  const summary = {
    title: "Forge Task",
    lines: ["short line", "another somewhat longer line"],
  };
  const boxed = formatForgeBox(summary, { width: 20 });
  for (const line of boxed) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(20);
  }
});

test("FIX 7: all ascii stage-0 frames have equal string length", () => {
  const frames = EVOLUTION_SPINNER_FRAMES_ASCII[0];
  const len = frames[0].length;
  for (const frame of frames) {
    expect(frame.length).toBe(len);
  }
});

test("FIX 8: non-TTY status fallback honors mono theme (no color)", () => {
  const out: string[] = [];
  const originalEnv = process.env.JOC_TUI_THEME;
  process.env.JOC_TUI_THEME = "mono";
  try {
    const tui = new LaunchTui({
      model: "m1",
      write: (s) => out.push(s),
    });
    tui.start();
    const ev = tui.events();
    ev.onStep!(1);
    
    const text = out.join("");
    // mono = no SGR color/style codes (…m). Cursor-control ANSI (\x1b[1G, \x1b[2K,
    // \x1b[?25l) is the renderer doing its job and is allowed.
    expect(text).not.toMatch(/\x1b\[[0-9;]*m/);
  } finally {
    process.env.JOC_TUI_THEME = originalEnv;
  }
});
