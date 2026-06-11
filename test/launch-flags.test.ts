import { test, expect } from "bun:test";
import { parseFlags, gatedStdout, shouldUseOneShotTui } from "../src/commands/launch";
import { createInterface } from "node:readline/promises";
import { Readable, Writable } from "node:stream";

test("parseFlags captures GJC-style model/provider/thinking launch flags", () => {
  const flags = parseFlags(["--model", "gpt-4o-mini", "--provider=OPENAI", "--thinking", "high", "fix", "it"]);
  expect(flags.model).toBe("gpt-4o-mini");
  expect(flags.provider).toBe("openai");
  expect(flags.thinking).toBe("high");
  expect(flags.message).toBe("fix it");
});

test("parseFlags captures model role tiers without consuming the prompt", () => {
  const slow = parseFlags(["--slow", "investigate", "this"]);
  expect(slow.modelRole).toBe("slow");
  expect(slow.message).toBe("investigate this");
  const plan = parseFlags(["--plan", "--max-steps=7", "draft"]);
  expect(plan.modelRole).toBe("plan");
  expect(plan.maxSteps).toBe(7);
  expect(plan.message).toBe("draft");
});

test("parseFlags records invalid provider/thinking values as launch errors", () => {
  const flags = parseFlags(["--provider", "bogus", "--thinking", "extreme", "hello"]);
  expect(flags.provider).toBeUndefined();
  expect(flags.thinking).toBeUndefined();
  expect(flags.errors).toEqual([
    "--provider must be one of: anthropic, openai, gemini, ollama",
    "--thinking must be one of: minimal, low, medium, high, xhigh",
  ]);
  expect(flags.message).toBe("hello");
});

test("parseFlags treats -- as end-of-options and omits the sentinel", () => {
  const flags = parseFlags(["--tmux", "--", "--models", "routing"]);
  expect(flags.tmux).toBe(true);
  expect(flags.message).toBe("--models routing");
  expect(flags.errors).toEqual([]);
});

test("shouldUseOneShotTui enables the live TUI for command-argument input on a TTY", () => {
  const desc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  try {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    expect(shouldUseOneShotTui(false)).toBe(true);
    expect(shouldUseOneShotTui(true)).toBe(false);

    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    expect(shouldUseOneShotTui(false)).toBe(false);
  } finally {
    if (desc) Object.defineProperty(process.stdout, "isTTY", desc);
  }
});

test("gatedStdout: write is a no-op while gated, forwarded when open", () => {
  const seen: string[] = [];
  const fake = new Writable({ write(c, _e, cb) { seen.push(c.toString()); cb(); } }) as any;
  fake.columns = 80; fake.rows = 24; fake.isTTY = true;
  let gated = true;
  const out = gatedStdout(fake, () => gated);

  let cbCalled = false;
  expect(out.write("hidden", () => { cbCalled = true; })).toBe(true);
  expect(seen).toEqual([]);          // swallowed while gated
  expect(cbCalled).toBe(true);       // callback still fired so readline never stalls

  gated = false;
  out.write("shown");
  expect(seen).toEqual(["shown"]);   // forwarded when open

  // geometry/props are forwarded unchanged
  expect((out as any).columns).toBe(80);
  expect((out as any).isTTY).toBe(true);
});

test("gatedStdout: readline's own prompt/echo is suppressed while gated (single-box)", async () => {
  const seen: string[] = [];
  const out = new Writable({ write(c, _e, cb) { seen.push(c.toString()); cb(); } }) as any;
  out.columns = 80; out.rows = 24; out.isTTY = true;
  const input = new Readable({ read() {} }) as any;
  input.isTTY = true; input.setRawMode = () => {};

  let armed = true; // box mode: readline output must be suppressed
  const rl = createInterface({ input, output: gatedStdout(out, () => armed) });
  const answer = rl.question("joc> ");
  input.push("hi");
  await new Promise(r => setTimeout(r, 30));
  input.push("\n");
  expect((await answer)).toBe("hi");
  rl.close();

  const joined = seen.join("");
  expect(joined).not.toContain("joc>"); // no duplicated raw CLI prompt line
  expect(joined).not.toContain("hi");   // no raw echo either — only our box would show it
});

// gjc-parity (logs/gjc-tui-study analysis Gap C): the /exit path prints a resume
// pointer using the same convention as the --list handler.
import { formatResumeHint } from "../src/commands/launch";

test("formatResumeHint matches the --list handler convention", () => {
  expect(formatResumeHint("019eb4b5-17fe-7000-a9d5-d6c9d7923f45"))
    .toBe("Resume with: joc launch --resume 019eb4b5-17fe-7000-a9d5-d6c9d7923f45");
});
