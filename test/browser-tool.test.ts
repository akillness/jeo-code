import { test, expect, mock, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
  mock.restore();
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

// --- 'verify' act-step (visionVerify integration) ---------------------------
// visionVerify's OWN unit contract (verdict/detail JSON parsing, empty-goal
// short-circuit, malformed/throwing LLM handling) is covered in
// vision-verify.test.ts. Here we cover the browser-tool WIRING contract: does
// runActStep's "verify" case correctly gate on 'goal', build the
// ImageAttachment(s) from real screenshot bytes, forward design_tokens/prior
// image through, and surface the verdict through the tool's JSON result.
//
// Deliberately mocks `callLlm` (../src/agent/loop) — NEVER `../src/agent/
// vision-verify` itself — so the REAL visionVerify runs as a genuine
// integration path. Every static import binding to a `mock.module()`'d
// specifier is a LIVE binding in Bun (verified empirically: an `import *
// as X`, a destructured named import, and an aliased import ALL resolve to
// whatever the module CURRENTLY exports, even if captured before any mock —
// there is no way to "capture and restore" a mocked module via any import
// form). Mocking vision-verify.ts from here would permanently corrupt every
// OTHER file's un-mocked import of it for the rest of the `bun test` process
// (this is exactly the failure this rewrite fixes — see CHANGELOG's
// documented `mock.module` cross-file leak class, commit 57a8bc5, for the
// general pattern: mock at the lowest dependency boundary, never re-mock a
// module more than one file already owns).

test.skipIf(!hasChromium)("browser: verify with no goal fails without calling callLlm", async () => {
  let called = false;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => { called = true; return JSON.stringify({ verdict: "PASS", detail: "should not be reached" }); },
  }));
  const tool = createBrowserTool();
  await tool({ action: "open", name: "v1", url: "data:text/html,<h1>hi</h1>" }, process.cwd());
  const res = await tool({ action: "act", name: "v1", actions: [{ verb: "verify" }] }, process.cwd());

  expect(res.success).toBe(false);
  const [step] = JSON.parse(res.output);
  expect(step.ok).toBe(false);
  expect(step.error).toContain("requires a non-empty 'goal'");
  expect(called).toBe(false);
});

test.skipIf(!hasChromium)("browser: verify surfaces a PASS verdict through the act result, forwarding goal/design_tokens as a real screenshot", async () => {
  let seenMessages: Array<{ role: string; content: string; images?: Array<{ mediaType: string; data: string }> }> = [];
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (messages: typeof seenMessages) => {
      seenMessages = messages;
      return JSON.stringify({ verdict: "PASS", detail: "matches the goal" });
    },
  }));
  const tool = createBrowserTool();
  await tool({ action: "open", name: "v2", url: "data:text/html,<h1>Shot</h1>" }, process.cwd());
  const res = await tool({
    action: "act",
    name: "v2",
    actions: [{ verb: "verify", goal: "a heading reading Shot", design_tokens: "font: sans-serif" }],
  }, process.cwd());

  expect(res.success).toBe(true);
  const [step] = JSON.parse(res.output);
  expect(step.ok).toBe(true);
  expect(step.verdict).toBe("PASS");
  expect(step.detail).toBe("matches the goal");
  // Wiring contract: the tool built a real PNG screenshot and forwarded the
  // exact goal/design_tokens text through the REAL visionVerify -> callLlm —
  // not placeholders, and not a mock standing in for visionVerify itself.
  const systemMsg = seenMessages.find(m => m.role === "system");
  const userMsg = seenMessages.find(m => m.role === "user");
  expect(systemMsg?.content).toContain("a heading reading Shot");
  expect(systemMsg?.content).toContain("font: sans-serif");
  expect(userMsg?.images?.length).toBe(1);
  const seenImage = userMsg!.images![0]!;
  expect(seenImage.mediaType).toBe("image/png");
  expect(typeof seenImage.data).toBe("string");
  expect(seenImage.data.length).toBeGreaterThan(0);
  // Decodes to a real PNG (magic bytes), not an empty/garbage buffer.
  const decoded = Buffer.from(seenImage.data, "base64");
  expect(decoded.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
});

test.skipIf(!hasChromium)("browser: verify surfaces a MISMATCH verdict as a failed act step", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ verdict: "MISMATCH", detail: "the heading says something else entirely" }),
  }));
  const tool = createBrowserTool();
  await tool({ action: "open", name: "v3", url: "data:text/html,<h1>Shot</h1>" }, process.cwd());
  const res = await tool({ action: "act", name: "v3", actions: [{ verb: "verify", goal: "a heading reading Nope" }] }, process.cwd());

  expect(res.success).toBe(false);
  const [step] = JSON.parse(res.output);
  expect(step.ok).toBe(false);
  expect(step.verdict).toBe("MISMATCH");
  expect(step.detail).toBe("the heading says something else entirely");
});

test.skipIf(!hasChromium)("browser: verify with a nonexistent prior_screenshot path fails clearly without calling callLlm", async () => {
  let called = false;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => { called = true; return JSON.stringify({ verdict: "PASS", detail: "should not be reached" }); },
  }));
  const tool = createBrowserTool();
  await tool({ action: "open", name: "v4", url: "data:text/html,<h1>Shot</h1>" }, process.cwd());
  const ghostPath = path.join(os.tmpdir(), `jeo-verify-ghost-${Date.now()}.png`);
  const res = await tool({
    action: "act",
    name: "v4",
    actions: [{ verb: "verify", goal: "anything", prior_screenshot: ghostPath }],
  }, process.cwd());

  expect(res.success).toBe(false);
  const [step] = JSON.parse(res.output);
  expect(step.ok).toBe(false);
  expect(step.error).toContain(ghostPath);
  expect(called).toBe(false);
});

test.skipIf(!hasChromium)("browser: verify with a real prior_screenshot forwards BOTH images to visionVerify (dual-image compare wiring)", async () => {
  let seenMessages: Array<{ role: string; images?: Array<{ mediaType: string; data: string }> }> = [];
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (messages: typeof seenMessages) => {
      seenMessages = messages;
      return JSON.stringify({ verdict: "PASS", detail: "changed as expected" });
    },
  }));
  const tool = createBrowserTool();
  await tool({ action: "open", name: "v5", url: "data:text/html,<h1>Shot</h1>" }, process.cwd());

  // A real (tiny, valid) prior PNG on disk — the well-known 1x1 transparent PNG.
  const priorPath = path.join(os.tmpdir(), `jeo-verify-prior-${Date.now()}.png`);
  const onePixelPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await fs.writeFile(priorPath, onePixelPng);
  try {
    const res = await tool({
      action: "act",
      name: "v5",
      actions: [{ verb: "verify", goal: "the page changed", prior_screenshot: priorPath }],
    }, process.cwd());

    expect(res.success).toBe(true);
    const [step] = JSON.parse(res.output);
    expect(step.ok).toBe(true);
    const userMsg = seenMessages.find(m => m.role === "user");
    expect(userMsg?.images?.length).toBe(2);
    const [seenPriorImage, seenImage] = userMsg!.images!;
    expect(seenPriorImage!.mediaType).toBe("image/png");
    expect(seenPriorImage!.data).toBe(onePixelPng.toString("base64"));
    expect(seenImage!.data).not.toBe(seenPriorImage!.data); // distinct current-state screenshot
  } finally {
    await fs.unlink(priorPath).catch(() => {});
  }
});
