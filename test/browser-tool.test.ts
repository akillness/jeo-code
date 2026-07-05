import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import { browserSession } from "../src/agent/browser-session";
import { createBrowserTool } from "../src/agent/browser-tool";

let hasChromium = true;
try {
  // Cheap availability probe: launch+close once up front so every test below can
  // skip cleanly (instead of timing out) in an environment without the Chromium
  // binary downloaded (`playwright install chromium`).
  const { chromium } = await import("playwright");
  const b = await chromium.launch({ headless: true });
  await b.close();
} catch {
  hasChromium = false;
}

afterEach(async () => {
  await browserSession.terminate();
});

test.skipIf(!hasChromium)("browser: open navigates a named tab and reports its url", async () => {
  const tool = createBrowserTool();
  const res = await tool({ action: "open", name: "main", url: "data:text/html,<h1>hi</h1>" }, process.cwd());
  expect(res.success).toBe(true);
  expect(res.output).toContain("main");
});

test.skipIf(!hasChromium)("browser: act observe/click/type/extract round-trip on a local page", async () => {
  const tool = createBrowserTool();
  const html = encodeURIComponent(`<html><body>
    <button id="b1">Click me</button>
    <input type="text" placeholder="Your name" />
    <p id="out">idle</p>
    <script>
      document.getElementById("b1").addEventListener("click", () => {
        document.getElementById("out").textContent = "clicked: " + document.querySelector("input").value;
      });
    </script>
  </body></html>`);
  await tool({ action: "open", name: "t1", url: `data:text/html,${html}` }, process.cwd());

  const observeRes = await tool({ action: "act", name: "t1", actions: [{ verb: "observe" }] }, process.cwd());
  expect(observeRes.success).toBe(true);
  const [observeStep] = JSON.parse(observeRes.output);
  expect(observeStep.ok).toBe(true);
  const button = observeStep.elements.find((e: any) => e.role === "button");
  const input = observeStep.elements.find((e: any) => e.tag === "input");
  expect(button).toBeDefined();
  expect(input).toBeDefined();

  const actRes = await tool({
    action: "act",
    name: "t1",
    actions: [
      { verb: "type", id: input.id, text: "world" },
      { verb: "click", id: button.id },
      { verb: "extract", format: "text" },
    ],
  }, process.cwd());
  expect(actRes.success).toBe(true);
  const steps = JSON.parse(actRes.output);
  expect(steps.every((s: any) => s.ok)).toBe(true);
  const extractStep = steps[steps.length - 1];
  expect(extractStep.content).toContain("clicked: world");
});

test.skipIf(!hasChromium)("browser: run executes JS with page/tab/display/assert in scope", async () => {
  const tool = createBrowserTool();
  await tool({ action: "open", name: "t2", url: "data:text/html,<h1>Hello</h1>" }, process.cwd());
  const res = await tool({
    action: "run",
    name: "t2",
    code: `
      const title = await page.evaluate(() => document.querySelector("h1").textContent);
      display("title: " + title);
      assert(title === "Hello", "expected Hello");
      return { title };
    `,
  }, process.cwd());
  expect(res.success).toBe(true);
  expect(res.output).toContain("title: Hello");
  expect(res.output).toContain('"title": "Hello"');
});

test.skipIf(!hasChromium)("browser: run surfaces a thrown assertion as a tool error", async () => {
  const tool = createBrowserTool();
  await tool({ action: "open", name: "t3", url: "data:text/html,<h1>Hello</h1>" }, process.cwd());
  const res = await tool({ action: "run", name: "t3", code: `assert(false, "nope");` }, process.cwd());
  expect(res.success).toBe(false);
  expect(res.error).toContain("nope");
});

test.skipIf(!hasChromium)("browser: screenshot act step saves a real PNG file", async () => {
  const tool = createBrowserTool();
  await tool({ action: "open", name: "t4", url: "data:text/html,<h1>Shot</h1>" }, process.cwd());
  const res = await tool({ action: "act", name: "t4", actions: [{ verb: "screenshot" }] }, process.cwd());
  expect(res.success).toBe(true);
  const [step] = JSON.parse(res.output);
  expect(step.ok).toBe(true);
  const stat = await fs.stat(step.saved);
  expect(stat.size).toBeGreaterThan(0);
  await fs.unlink(step.saved).catch(() => {});
});

test.skipIf(!hasChromium)("browser: close closes a specific tab, and close all tears down the browser", async () => {
  const tool = createBrowserTool();
  await tool({ action: "open", name: "a" }, process.cwd());
  await tool({ action: "open", name: "b" }, process.cwd());
  expect(browserSession.openTabNames.sort()).toEqual(["a", "b"]);

  const closeOne = await tool({ action: "close", name: "a" }, process.cwd());
  expect(closeOne.success).toBe(true);
  expect(browserSession.openTabNames).toEqual(["b"]);

  const closeAll = await tool({ action: "close", all: true }, process.cwd());
  expect(closeAll.success).toBe(true);
  expect(browserSession.openTabNames).toEqual([]);
});

test("browser: act on an unopened tab auto-opens it (about:blank) rather than erroring", async () => {
  if (!hasChromium) return;
  const tool = createBrowserTool();
  const res = await tool({ action: "act", name: "auto", actions: [{ verb: "navigate", url: "data:text/html,<p>ok</p>" }] }, process.cwd());
  expect(res.success).toBe(true);
});

test("browser: run against an unopened tab fails clearly", async () => {
  const tool = createBrowserTool();
  const res = await tool({ action: "run", name: "ghost", code: "return 1;" }, process.cwd());
  expect(res.success).toBe(false);
  expect(res.error).toContain("No open tab");
});

test("browser: close requires name or all", async () => {
  const tool = createBrowserTool();
  const res = await tool({ action: "close" }, process.cwd());
  expect(res.success).toBe(false);
});

test("browser: rejects an unknown action", async () => {
  const tool = createBrowserTool();
  const res = await tool({ action: "bogus" }, process.cwd());
  expect(res.success).toBe(false);
  expect(res.error).toContain("Unknown browser action");
});
