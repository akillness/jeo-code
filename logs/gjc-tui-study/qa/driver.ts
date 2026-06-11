import { LaunchTui } from "../../../src/tui/app";
import * as fs from "fs";
import * as path from "path";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const caseName = process.argv[2] || "glyph";
  console.error(`Starting driver for case: ${caseName}`);

  const qaDir = "/Users/jangyoung/.superset/projects/jeo-code/logs/gjc-tui-study/qa";
  fs.mkdirSync(qaDir, { recursive: true });

  const rawFullLogPath = path.join(qaDir, "raw-output-full.txt");
  const rawMidturnLogPath = path.join(qaDir, "raw-output-midturn.txt");

  // Clean logs if they exist
  if (caseName === "glyph") {
    if (fs.existsSync(rawFullLogPath)) fs.unlinkSync(rawFullLogPath);
    if (fs.existsSync(rawMidturnLogPath)) fs.unlinkSync(rawMidturnLogPath);
  }

  let finished = false;

  const tui = new LaunchTui({
    model: "qa",
    tty: true,
    write: (s: string) => {
      if (caseName === "glyph") {
        fs.appendFileSync(rawFullLogPath, s);
        if (!finished) {
          fs.appendFileSync(rawMidturnLogPath, s);
        }
      }
      process.stdout.write(s);
    }
  });

  tui.start();
  const ev = tui.events();

  if (caseName === "glyph") {
    // Emit 5 successful and 2 failed tool results
    for (let i = 1; i <= 5; i++) {
      ev.onStep!(i);
      await delay(50);
      ev.onAssistant!("", { tool: `GLYPH-OK-${i}` });
      await delay(50);
      ev.onToolResult!(`GLYPH-OK-${i}`, true, `success output ${i}`);
      await delay(100);
    }

    for (let j = 1; j <= 2; j++) {
      ev.onStep!(5 + j);
      await delay(50);
      ev.onAssistant!("", { tool: `GLYPH-FAIL-${j}` });
      await delay(50);
      ev.onToolResult!(`GLYPH-FAIL-${j}`, false, `failed output ${j}`);
      await delay(100);
    }

    // Keep the turn alive for 4 seconds so the runner can capture the scrollback while live
    await delay(4000);

    finished = true;
    tui.finish("glyph done");

  } else if (caseName === "rate") {
    ev.onStep!(1);
    await delay(50);
    ev.onUsage!({ inputTokens: 1200, outputTokens: 387 });

    // Keep turn alive for 3.5 seconds
    await delay(3500);

    finished = true;
    tui.finish("rate done");

  } else if (caseName === "rate-zero") {
    ev.onStep!(1);
    await delay(50);
    ev.onUsage!({ inputTokens: 1200, outputTokens: 0 });

    // Keep turn alive for 3.5 seconds
    await delay(3500);

    finished = true;
    tui.finish("rate-zero done");

  } else {
    console.error(`Unknown case: ${caseName}`);
    process.exit(1);
  }

  // Clear interval from TUI to prevent hanging
  const timer = (tui as any).timer;
  if (timer) {
    clearInterval(timer);
  }
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
