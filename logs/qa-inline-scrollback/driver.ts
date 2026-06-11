import { LaunchTui } from "../../src/tui/app";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const caseName = process.argv[2] || "happy-path";
  console.error(`Starting driver for case: ${caseName}`);

  const tui = new LaunchTui({ model: "qa", tty: true });
  tui.start();

  const ev = tui.events();

  if (caseName === "happy-path" || caseName === "copy-mode") {
    // Emit 60 events
    for (let i = 1; i <= 60; i++) {
      const marker = `LEDGER-${String(i).padStart(3, "0")}`;
      if (i % 2 === 1) {
        ev.onToolResult!(marker, true, "");
      } else {
        tui.onSubagentEvent({ role: "executor", kind: "tool", detail: marker, success: true });
      }
      await delay(50);
    }
    // Keep alive for another 6 seconds to let the runner capture
    await delay(6000);
    tui.finish("happy done");
  } else if (caseName === "no-alt-screen") {
    // Just start, emit 5 events, wait 4 seconds, then finish
    for (let i = 1; i <= 5; i++) {
      const marker = `LEDGER-${String(i).padStart(3, "0")}`;
      ev.onToolResult!(marker, true, "");
      await delay(50);
    }
    await delay(4000);
    tui.finish("no alt done");
  } else if (caseName === "resize") {
    // Start, emit 10 events, wait 6 seconds
    for (let i = 1; i <= 10; i++) {
      const marker = `LEDGER-${String(i).padStart(3, "0")}`;
      ev.onToolResult!(marker, true, "");
      await delay(50);
    }
    await delay(6000);
    tui.finish("resize done");
  } else if (caseName === "burst") {
    // Emit 200 events as fast as possible
    for (let i = 1; i <= 200; i++) {
      const marker = `LEDGER-${String(i).padStart(3, "0")}`;
      if (i % 2 === 1) {
        ev.onToolResult!(marker, true, "");
      } else {
        tui.onSubagentEvent({ role: "executor", kind: "tool", detail: marker, success: true });
      }
    }
    await delay(5000);
    tui.finish("burst done");
  } else if (caseName === "dedupe") {
    // Emit 5 events, finish immediately, then exit
    for (let i = 1; i <= 5; i++) {
      const marker = `LEDGER-${String(i).padStart(3, "0")}`;
      ev.onToolResult!(marker, true, "");
      await delay(50);
    }
    tui.finish("qa done");
  } else {
    console.error(`Unknown case: ${caseName}`);
    process.exit(1);
  }

  // Clear interval from TUI if any to prevent hanging
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
