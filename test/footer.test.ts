import { test, expect } from "bun:test";
import { renderFooter } from "../src/tui/components/footer";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("footer appends a compact evolution-stage tag when step+maxSteps known", () => {
  const out = stripAnsi(renderFooter({ model: "m1", step: 1, maxSteps: 50 }));
  expect(out).toContain("step 1/50");
  expect(out).toContain("\u25cf\u25cf\u25cb\u25cb\u25cb Double Helix (DNA) [2/5]"); // 1/50 → ratio 0.02 → stage 1
});

test("footer stage tag tracks the evolution stage", () => {
  expect(stripAnsi(renderFooter({ model: "m", step: 0, maxSteps: 100 }))).toContain("\u25cf\u25cb\u25cb\u25cb\u25cb Primordial Cell [1/5]");
  expect(stripAnsi(renderFooter({ model: "m", step: 50, maxSteps: 100 }))).toContain("\u25cf\u25cf\u25cf\u25cb\u25cb Tool User (Homo Habilis) [3/5]");
  expect(stripAnsi(renderFooter({ model: "m", step: 100, maxSteps: 100 }))).toContain("\u25cf\u25cf\u25cf\u25cf\u25cf Super intelligence (Singularity) [5/5]");
});

test("footer omits the stage tag when showStage:false or step/maxSteps missing", () => {
  expect(stripAnsi(renderFooter({ model: "m", step: 1, maxSteps: 50, showStage: false }))).not.toContain("[2/5]");
  expect(stripAnsi(renderFooter({ model: "m" }))).not.toContain("[");
  expect(stripAnsi(renderFooter({ model: "m", step: 3 }))).not.toContain("["); // no maxSteps
});

test("footer joins segments with ' · ' and leads with the model", () => {
  const out = stripAnsi(renderFooter({ model: "m1", step: 2, maxSteps: 10, sessionId: "abcd1234efgh" }));
  expect(out.startsWith("m1 · ")).toBe(true);
  expect(out).toContain("abcd1234");
});

test("footer renders estimated context usage", () => {
  const out = stripAnsi(renderFooter({ model: "m1", contextUsedTokens: 5000, contextMaxTokens: 20000, showStage: false }));
  expect(out).toContain("ctx 25%/20k");
  expect(stripAnsi(renderFooter({ model: "m1", contextUsedTokens: 1234, showStage: false }))).toContain("ctx ~1k");
  expect(stripAnsi(renderFooter({ model: "m1", contextUsedTokens: 512, showStage: false }))).toContain("ctx ~512");
});

test("footer handles context coloring and autoCompact", () => {
  const chalk = require("chalk").default ?? require("chalk");
  const prev = chalk.level;
  chalk.level = 3;
  try {
    // used 180k / max 200000 -> ctx 90%/200k, red
    const redOut = renderFooter({ model: "m1", contextUsedTokens: 180000, contextMaxTokens: 200000, showStage: false });
    expect(stripAnsi(redOut)).toContain("ctx 90%/200k");
    expect(redOut).toContain(chalk.red("ctx 90%/200k"));

    // used 130k / max 200000 -> ctx 65%/200k, yellow
    const yellowOut = renderFooter({ model: "m1", contextUsedTokens: 130000, contextMaxTokens: 200000, showStage: false });
    expect(stripAnsi(yellowOut)).toContain("ctx 65%/200k");
    expect(yellowOut).toContain(chalk.yellow("ctx 65%/200k"));

    // pct < 60 -> no ANSI on the ctx part when other coloring is off
    const normalOut = renderFooter({ model: "m1", contextUsedTokens: 50000, contextMaxTokens: 100000, showStage: false, color: false });
    expect(normalOut).toContain("ctx 50%/100k");
    expect(/\x1b\[/.test(normalOut)).toBe(false);

    // autoCompact: true -> (auto) suffix
    const autoOut = stripAnsi(renderFooter({ model: "m1", contextUsedTokens: 180000, contextMaxTokens: 200000, autoCompact: true, showStage: false }));
    expect(autoOut).toContain("ctx 90%/200k(auto)");
  } finally {
    chalk.level = prev;
  }
});

test("footer renders cwd and branch with middle truncation", () => {
  const os = require("node:os");
  const home = os.homedir();

  // cwd + branch render ~/path and (main)
  const path1 = `${home}/projects/jeo-code`;
  const out1 = stripAnsi(renderFooter({ model: "m1", cwd: path1, branch: "main", showStage: false }));
  expect(out1).toContain("~/projects/jeo-code (main)");

  // middle truncation for a >32-char path
  const path2 = `${home}/a/very/long/path/structure/that/exceeds/thirty/two/characters`;
  const out2 = stripAnsi(renderFooter({ model: "m1", cwd: path2, showStage: false }));
  // Should be exactly 32 chars for the truncated path
  const parts = out2.split(" · ");
  const cwdSegment = parts[1];
  expect(cwdSegment.length).toBe(32);
  expect(cwdSegment).toContain("…");

  // middle truncation for a >32-char path, unicode false
  const out3 = stripAnsi(renderFooter({ model: "m1", cwd: path2, unicode: false, showStage: false }));
  const parts3 = out3.split(" · ");
  const cwdSegment3 = parts3[1];
  expect(cwdSegment3.length).toBe(32);
  expect(cwdSegment3).toContain("...");
});

test("footer stage track honors the mono theme (color:false emits no ANSI)", () => {
  const chalk = require("chalk").default ?? require("chalk");
  const prev = chalk.level;
  chalk.level = 3; // force color so the assertion is meaningful off a TTY
  try {
    const colored = renderFooter({ model: "m", step: 3, maxSteps: 5 });
    expect(/\x1b\[/.test(colored)).toBe(true); // default → colored
    const mono = renderFooter({ model: "m", step: 3, maxSteps: 5, color: false });
    expect(/\x1b\[/.test(mono)).toBe(false); // mono → no ANSI even with color forced on
    expect(mono).toContain("step 3/5");
  } finally {
    chalk.level = prev;
  }
});
