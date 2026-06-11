import { LaunchTui } from "../../src/tui/app";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const tui = new LaunchTui({ model: "gemini-flash-latest", provider: "gemini", maxSteps: 25, tty: true, cwd: process.cwd(), branch: "main" });
  tui.start();
  const ev = tui.events();

  // Declare a plan (planning stage).
  tui.setTodos([
    { title: "Read package.json", status: "done" },
    { title: "Inspect TUI layout", status: "in_progress" },
    { title: "Apply redesign", status: "pending" },
  ]);
  await delay(300);

  // Step 1: a read tool → forge box + ledger flush (executing stage).
  ev.onStep!(1);
  await delay(200);
  ev.onAssistant!("", { tool: "read", arguments: { filePath: "package.json" } });
  await delay(200);
  ev.onToolResult!("read", true, '1|{\n2|  "name": "jeo-code",\n3|  "version": "0.1.0",\n4|  "type": "module"\n5|}');
  ev.onUsage!({ inputTokens: 8200, outputTokens: 120 });
  await delay(300);

  // Step 2: a bash tool → second forge box.
  ev.onStep!(2);
  await delay(200);
  ev.onAssistant!("", { tool: "bash", arguments: { command: "echo hello" } });
  await delay(200);
  ev.onToolResult!("bash", true, "hello");
  ev.onUsage!({ inputTokens: 12400, outputTokens: 340 });

  // Step 3: thinking on the next call (keeps the live frame painted).
  ev.onStep!(3);

  // Freeze the live frame so the runner can capture it; keep the timer alive.
  await delay(6000);
  const timer = (tui as unknown as { timer?: ReturnType<typeof setInterval> }).timer;
  if (timer) clearInterval(timer);
  tui.finish("name: jeo-code, version: 0.1.0");
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
