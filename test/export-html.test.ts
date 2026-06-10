import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { renderSessionHtml, runExportCommand } from "../src/commands/export";
import { createSession, appendMessage } from "../src/agent/session";

beforeEach(() => {
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = 0;
});

test("renderSessionHtml escapes HTML entities in content", () => {
  const meta = { id: "test-session-id", timestamp: "2026-06-10T12:00:00.000Z" };
  const messages = [
    { role: "user", content: "hello & < > \" ' world" }
  ];
  const html = renderSessionHtml(meta, messages);
  expect(html).toContain("hello &amp; &lt; &gt; &quot; &#039; world");
});

test("renderSessionHtml includes all roles", () => {
  const meta = { id: "test-session-id", timestamp: "2026-06-10T12:00:00.000Z" };
  const messages = [
    { role: "system", content: "system text" },
    { role: "user", content: "user text" },
    { role: "assistant", content: "assistant text" }
  ];
  const html = renderSessionHtml(meta, messages);
  expect(html).toContain("system text");
  expect(html).toContain("user text");
  expect(html).toContain("assistant text");
  expect(html).toContain("system");
  expect(html).toContain("user");
  expect(html).toContain("assistant");
});

test("runExportCommand validates args and sets exitCode 1 on --html and --json conflict", async () => {
  const originalExitCode = process.exitCode;
  const originalError = console.error;
  let errorMsg = "";
  console.error = (msg) => { errorMsg = msg; };
  process.exitCode = undefined;

  try {
    await runExportCommand(["--html", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(errorMsg).toContain("Error: --html and --json options are mutually exclusive.");
  } finally {
    console.error = originalError;
    process.exitCode = originalExitCode;
  }
});

test("runExportCommand with --html writes file to mkdtemp --out path", async () => {
  const savedCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-export-test-"));
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-export-out-"));
  
  const originalLog = console.log;
  let loggedOutput = "";
  console.log = (msg) => { loggedOutput += msg + "\n"; };

  try {
    // 1. Create a session inside tempDir
    const { id } = await createSession(tempDir);
    await appendMessage(id, { role: "system", content: "system instructions" }, tempDir);
    await appendMessage(id, { role: "user", content: "hello world" }, tempDir);
    await appendMessage(id, { role: "assistant", content: "hi there" }, tempDir);

    // 2. Change chdir to tempDir so that latestSessionId / loadSession picks it up
    process.chdir(tempDir);

    // 3. Export to a specific --out path
    const customOutPath = path.join(outDir, "custom-export.html");
    await runExportCommand([id, "--html", "--out", customOutPath]);

    // 4. Verify file was written
    const fileExists = await fs.stat(customOutPath).then(() => true).catch(() => false);
    expect(fileExists).toBe(true);

    const htmlContent = await fs.readFile(customOutPath, "utf8");
    expect(htmlContent).toContain("Session: " + id);
    expect(htmlContent).toContain("hello world");
    expect(htmlContent).toContain("hi there");
    // System message should NOT be included by default
    expect(htmlContent).not.toContain("system instructions");

    // Default output printed path
    const realLogged = await fs.realpath(loggedOutput.trim());
    const realExpected = await fs.realpath(customOutPath);
    expect(realLogged).toBe(realExpected);

  } finally {
    process.chdir(savedCwd);
    console.log = originalLog;
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("runExportCommand with --html uses default path if no --out is specified", async () => {
  const savedCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-export-test2-"));
  
  const originalLog = console.log;
  let loggedOutput = "";
  console.log = (msg) => { loggedOutput += msg + "\n"; };

  try {
    const { id } = await createSession(tempDir);
    await appendMessage(id, { role: "user", content: "default path test" }, tempDir);

    process.chdir(tempDir);

    await runExportCommand([id, "--html"]);

    const expectedDefaultPath = path.join(tempDir, `joc-session-${id}.html`);
    const fileExists = await fs.stat(expectedDefaultPath).then(() => true).catch(() => false);
    expect(fileExists).toBe(true);

    const htmlContent = await fs.readFile(expectedDefaultPath, "utf8");
    expect(htmlContent).toContain("default path test");
    const realLogged = await fs.realpath(loggedOutput.trim());
    const realExpected = await fs.realpath(expectedDefaultPath);
    expect(realLogged).toBe(realExpected);

  } finally {
    process.chdir(savedCwd);
    console.log = originalLog;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("runExportCommand markdown/json output still functions", async () => {
  const savedCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-export-test3-"));
  
  const originalLog = console.log;
  let loggedOutput = "";
  console.log = (msg) => { loggedOutput += msg + "\n"; };

  try {
    const { id } = await createSession(tempDir);
    await appendMessage(id, { role: "user", content: "markdown content" }, tempDir);

    process.chdir(tempDir);

    // Markdown (default)
    loggedOutput = "";
    await runExportCommand([id]);
    expect(loggedOutput).toContain("markdown content");
    expect(loggedOutput).toContain("## User");

    // JSON
    loggedOutput = "";
    await runExportCommand([id, "--json"]);
    const parsed = JSON.parse(loggedOutput);
    expect(parsed.messages[0].content).toBe("markdown content");

  } finally {
    process.chdir(savedCwd);
    console.log = originalLog;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
