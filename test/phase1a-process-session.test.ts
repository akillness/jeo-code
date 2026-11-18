import { afterEach, expect, mock, spyOn, test, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { BrowserSession } from "../src/agent/browser-session";
import { DebugSession } from "../src/agent/debug-session";
import { bashTool, bisectTool } from "../src/agent/tools";

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

interface FakeDebugServer {
  sockets: FakeWebSocket[];
  received: CdpMessage[];
  holdMethods: Set<string>;
  waitForMethod(method: string): Promise<CdpMessage>;
}

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  readonly url: string;
  private onClientSend: (ws: FakeWebSocket, msg: CdpMessage) => void;

  constructor(url: string | URL, onClientSend: (ws: FakeWebSocket, msg: CdpMessage) => void) {
    super();
    this.url = String(url);
    this.onClientSend = onClientSend;
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) return;
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(data: string): void {
    const parsed: CdpMessage = JSON.parse(data);
    this.onClientSend(this, parsed);
  }

  receive(payload: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  triggerError(): void {
    this.dispatchEvent(new Event("error"));
  }
}

interface FakePageRecord {
  page: Page;
  gotoUrls: string[];
  closed: boolean;
  viewportUpdates: Array<{ width: number; height: number }>;
}

interface FakeBrowserRecord {
  browser: Browser;
  connected: boolean;
  pages: FakePageRecord[];
  closed: boolean;
}

const tempDirs: string[] = [];
const debugSessions: DebugSession[] = [];
const browserSessions: BrowserSession[] = [];
const watchers: fsSync.FSWatcher[] = [];
const childPids: number[] = [];
const originalWebSocket = globalThis.WebSocket;

afterEach(async () => {
  vi.useRealTimers();
  globalThis.WebSocket = originalWebSocket;
  for (const w of watchers.splice(0)) {
    try { w.close(); } catch {}
  }
  for (const pid of childPids.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  for (const session of debugSessions.splice(0)) {
    await session.terminate();
  }
  for (const session of browserSessions.splice(0)) {
    await session.terminate();
  }
  mock.restore();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createMockDebugHarness(holdMethods: string[] = []): FakeDebugServer {
  const sockets: FakeWebSocket[] = [];
  const received: CdpMessage[] = [];
  const held = new Set<string>(holdMethods);
  const methodWaiters = new Map<string, Array<(msg: CdpMessage) => void>>();

  const notifyWaiters = (msg: CdpMessage): void => {
    if (!msg.method) return;
    const waiters = methodWaiters.get(msg.method);
    if (!waiters || waiters.length === 0) return;
    methodWaiters.delete(msg.method);
    for (const resolve of waiters) resolve(msg);
  };

  const handleClientMessage = (ws: FakeWebSocket, msg: CdpMessage): void => {
    received.push(msg);
    notifyWaiters(msg);
    if (msg.method && held.has(msg.method)) return;
    if (msg.id === undefined) return;

    if (msg.method === "Debugger.enable" || msg.method === "Runtime.enable") {
      queueMicrotask(() => ws.receive({ id: msg.id, result: {} }));
    } else if (msg.method === "Runtime.runIfWaitingForDebugger") {
      queueMicrotask(() => {
        ws.receive({ id: msg.id, result: {} });
        queueMicrotask(() => {
          ws.receive({ method: "Debugger.scriptParsed", params: { scriptId: "s1", url: "file:///app.js" } });
          ws.receive({
            method: "Debugger.paused",
            params: {
              reason: "Break on start",
              callFrames: [
                {
                  callFrameId: "cf1",
                  functionName: "main",
                  location: { scriptId: "s1", lineNumber: 0 },
                  scopeChain: [{ type: "local", object: { objectId: "scope-1" } }],
                },
              ],
            },
          });
        });
      });
    } else if (msg.method === "Debugger.setBreakpointByUrl") {
      const lineNumber = typeof msg.params?.lineNumber === "number" ? msg.params.lineNumber : 0;
      queueMicrotask(() => {
        ws.receive({
          id: msg.id,
          result: {
            breakpointId: "bp-1",
            locations: [{ scriptId: "s1", lineNumber }],
          },
        });
      });
    } else {
      queueMicrotask(() => ws.receive({ id: msg.id, result: {} }));
    }
  };

  const exited = Promise.withResolvers<number>();
  let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      stderrController = controller;
      controller.enqueue(new TextEncoder().encode("Debugger listening on ws://127.0.0.1:9229/mock\n"));
    },
  });
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

  const fakeProcBase = {
    pid: 999_991,
    stdout,
    stderr,
    exited: exited.promise,
    kill() {
      try { stderrController?.close(); } catch {}
      exited.resolve(0);
    },
  };
  const fakeProc = new Proxy(fakeProcBase, {}) as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;

  spyOn(Bun, "spawn").mockImplementation((() => fakeProc) as unknown as typeof Bun.spawn);

  class BoundFakeWebSocket extends FakeWebSocket {
    constructor(url: string | URL) {
      super(url, handleClientMessage);
      sockets.push(this);
    }
  }
  globalThis.WebSocket = BoundFakeWebSocket as unknown as typeof WebSocket;

  return {
    sockets,
    received,
    holdMethods: held,
    waitForMethod(method: string): Promise<CdpMessage> {
      const existing = received.find((m) => m.method === method);
      if (existing) return Promise.resolve(existing);
      const { promise, resolve } = Promise.withResolvers<CdpMessage>();
      const list = methodWaiters.get(method) ?? [];
      list.push(resolve);
      methodWaiters.set(method, list);
      return promise;
    },
  };
}

function makeFakeBrowser(): FakeBrowserRecord {
  const record: FakeBrowserRecord = {
    connected: true,
    pages: [],
    closed: false,
    browser: undefined as unknown as Browser,
  };
  const browserObj = {
    isConnected: () => record.connected,
    newPage: async (opts?: { viewport?: { width: number; height: number } }): Promise<Page> => {
      const pageRec: FakePageRecord = {
        gotoUrls: [],
        closed: false,
        viewportUpdates: opts?.viewport ? [opts.viewport] : [],
        page: undefined as unknown as Page,
      };
      const pageObj = {
        goto: async (url: string) => {
          pageRec.gotoUrls.push(url);
          return null;
        },
        close: async () => {
          pageRec.closed = true;
        },
        setViewportSize: async (vp: { width: number; height: number }) => {
          pageRec.viewportUpdates.push(vp);
        },
      };
      pageRec.page = new Proxy(pageObj, {}) as unknown as Page;
      record.pages.push(pageRec);
      return pageRec.page;
    },
    close: async () => {
      record.closed = true;
      record.connected = false;
    },
  };
  record.browser = new Proxy(browserObj, {}) as unknown as Browser;
  return record;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ESRCH") return false;
    throw err;
  }
  if (process.platform === "linux") {
    try {
      const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
      return state !== "Z" && state !== "X";
    } catch {
      return false;
    }
  }
  return true;
}

function gitSync(cwd: string, args: string[]): string {
  const res = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(res.stderr)}`);
  }
  return new TextDecoder().decode(res.stdout).trim();
}

// ---------------------------------------------------------------------------
// 1. DebugSession lifecycle, in-flight promise rejection, and pause timeout
// ---------------------------------------------------------------------------

test("DebugSession: send() rejects all in-flight promises when the WebSocket closes", async () => {
  const server = createMockDebugHarness(["Debugger.evaluateOnCallFrame", "Runtime.getProperties"]);
  const session = new DebugSession();
  debugSessions.push(session);

  const launch = await session.launch("app.js", [], "/tmp");
  expect(launch.success).toBe(true);

  const evalPromise = session.evaluate("1 + 1");
  const varsPromise = session.variables("scope-1");
  await Promise.all([
    server.waitForMethod("Debugger.evaluateOnCallFrame"),
    server.waitForMethod("Runtime.getProperties"),
  ]);

  server.sockets[0]!.close();

  const [evalRes, varsRes] = await Promise.all([evalPromise, varsPromise]);
  expect(evalRes).toEqual({ success: false, output: "", error: "Inspector WebSocket closed." });
  expect(varsRes).toEqual({ success: false, output: "", error: "Inspector WebSocket closed." });
});

test("DebugSession: send() rejects all in-flight promises when the WebSocket errors", async () => {
  const server = createMockDebugHarness(["Debugger.evaluateOnCallFrame", "Runtime.getProperties"]);
  const session = new DebugSession();
  debugSessions.push(session);

  const launch = await session.launch("app.js", [], "/tmp");
  expect(launch.success).toBe(true);

  const evalPromise = session.evaluate("x");
  const varsPromise = session.variables("scope-1");
  await Promise.all([
    server.waitForMethod("Debugger.evaluateOnCallFrame"),
    server.waitForMethod("Runtime.getProperties"),
  ]);

  server.sockets[0]!.triggerError();

  const [evalRes, varsRes] = await Promise.all([evalPromise, varsPromise]);
  expect(evalRes).toEqual({ success: false, output: "", error: "Inspector WebSocket error." });
  expect(varsRes).toEqual({ success: false, output: "", error: "Inspector WebSocket error." });
});

test("DebugSession: terminate() rejects all in-flight promises and clears scriptUrls and breakpoints", async () => {
  const server = createMockDebugHarness(["Debugger.evaluateOnCallFrame", "Runtime.getProperties"]);
  const session = new DebugSession();
  debugSessions.push(session);

  const launch = await session.launch("app.js", [], "/tmp");
  expect(launch.success).toBe(true);
  expect(session.stackTrace().output).toContain("file:///app.js:1");

  const bp = await session.setBreakpoint("app.js", 5, "/tmp");
  expect(bp.success).toBe(true);

  const scriptUrlsBefore = Reflect.get(session, "scriptUrls");
  const breakpointsBefore = Reflect.get(session, "breakpoints");
  expect(scriptUrlsBefore instanceof Map && scriptUrlsBefore.size).toBeGreaterThan(0);
  expect(breakpointsBefore instanceof Map && breakpointsBefore.size).toBe(1);

  const evalPromise = session.evaluate("y");
  const varsPromise = session.variables("scope-1");
  await Promise.all([
    server.waitForMethod("Debugger.evaluateOnCallFrame"),
    server.waitForMethod("Runtime.getProperties"),
  ]);

  const term = await session.terminate();
  expect(term).toEqual({ success: true, output: "Debug session terminated." });

  const [evalRes, varsRes] = await Promise.all([evalPromise, varsPromise]);
  expect(evalRes).toEqual({ success: false, output: "", error: "Debug session terminated." });
  expect(varsRes).toEqual({ success: false, output: "", error: "Debug session terminated." });
  expect(session.isActive).toBe(false);
  expect(session.isPaused).toBe(false);

  const scriptUrlsAfter = Reflect.get(session, "scriptUrls");
  const breakpointsAfter = Reflect.get(session, "breakpoints");
  expect(scriptUrlsAfter instanceof Map && scriptUrlsAfter.size).toBe(0);
  expect(breakpointsAfter instanceof Map && breakpointsAfter.size).toBe(0);
});

test("DebugSession: waitForPausedOrExit returns { exited: false, timedOut: true } rather than { exited: true } on timeout", async () => {
  const server = createMockDebugHarness(["Debugger.resume"]);
  const session = new DebugSession();
  debugSessions.push(session);

  const launch = await session.launch("app.js", [], "/tmp");
  expect(launch.success).toBe(true);

  vi.useFakeTimers();
  try {
    // Verify the direct WaitResult contract as well as continue()'s observable mapping.
    const waitFn = Reflect.get(session, "waitForPausedOrExit");
    expect(typeof waitFn).toBe("function");
    const directWait = (waitFn as () => Promise<unknown>).call(session);

    vi.advanceTimersByTime(14_999);
    const beforeDeadline = await Promise.race([directWait, Promise.resolve("still-waiting")]);
    expect(beforeDeadline).toBe("still-waiting");

    vi.advanceTimersByTime(1);
    const directResult = await directWait;
    expect(directResult).toEqual({ exited: false, timedOut: true });

    // Also verify continue() maps that timedOut result to a failure (not "Program exited").
    const contPromise = session.continue();
    const resumeMsg = await server.waitForMethod("Debugger.resume");
    server.sockets[0]!.receive({ id: resumeMsg.id, result: {} });
    await Promise.resolve();
    await Promise.resolve();

    vi.advanceTimersByTime(15_000);
    const contRes = await contPromise;
    expect(contRes.success).toBe(false);
    expect(contRes.error).toContain("Timed out waiting for 'continue' to pause or exit (15000ms)");
    expect(session.isActive).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

// ---------------------------------------------------------------------------
// 2. BrowserSession single-flight launch lock and disconnect recovery
// ---------------------------------------------------------------------------

test("BrowserSession: concurrent open() calls invoke chromium.launch() only once (single-flight lock)", async () => {
  const fakeBrowser = makeFakeBrowser();
  const launchDeferred = Promise.withResolvers<Browser>();
  const launchSpy = spyOn(chromium, "launch").mockImplementation(() => launchDeferred.promise);

  const session = new BrowserSession();
  browserSessions.push(session);

  const openA = session.open("tab-a", "https://example.test/a");
  const openB = session.open("tab-b", "https://example.test/b");
  const openADup = session.open("tab-a");

  expect(launchSpy).toHaveBeenCalledTimes(1);

  launchDeferred.resolve(fakeBrowser.browser);
  const [tabA, tabB, tabADup] = await Promise.all([openA, openB, openADup]);

  expect(launchSpy).toHaveBeenCalledTimes(1);
  expect(session.openTabNames.sort()).toEqual(["tab-a", "tab-b"]);
  expect(tabA).toBe(tabADup);
  expect(tabA).not.toBe(tabB);
  expect(fakeBrowser.pages.some((p) => p.gotoUrls.includes("https://example.test/a"))).toBe(true);
  expect(fakeBrowser.pages.some((p) => p.gotoUrls.includes("https://example.test/b"))).toBe(true);
  // Concurrent duplicate open for the same tab name closed the extra page cleanly.
  expect(fakeBrowser.pages.filter((p) => p.closed)).toHaveLength(1);
});

test("BrowserSession: disconnected browser clears stale tabs and relaunches cleanly on next open()", async () => {
  const firstBrowser = makeFakeBrowser();
  const secondBrowser = makeFakeBrowser();
  let launchCount = 0;
  const launchSpy = spyOn(chromium, "launch").mockImplementation(async () => {
    launchCount += 1;
    return launchCount === 1 ? firstBrowser.browser : secondBrowser.browser;
  });

  const session = new BrowserSession();
  browserSessions.push(session);

  const staleTab = await session.open("stale-1", "https://example.test/one");
  await session.open("stale-2", "https://example.test/two");
  expect(launchSpy).toHaveBeenCalledTimes(1);
  expect(session.openTabNames.sort()).toEqual(["stale-1", "stale-2"]);

  // Simulate headless Chromium crashing/disconnecting outside BrowserSession.
  firstBrowser.connected = false;

  const relaunchedSameName = await session.open("stale-1", "https://example.test/fresh");
  expect(launchSpy).toHaveBeenCalledTimes(2);
  expect(session.browserInstance).toBe(secondBrowser.browser);
  expect(session.has("stale-2")).toBe(false);
  expect(() => session.get("stale-2")).toThrow("No open tab named 'stale-2'");
  expect(session.openTabNames).toEqual(["stale-1"]);
  expect(relaunchedSameName).not.toBe(staleTab);
  expect(secondBrowser.pages).toHaveLength(1);
  expect(secondBrowser.pages[0]!.gotoUrls).toEqual(["https://example.test/fresh"]);
});

// ---------------------------------------------------------------------------
// 3. bashTool timeout validation & bisectTool AbortSignal cleanup
// ---------------------------------------------------------------------------

for (const badTimeout of [0, -1, -500, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
  test(`bashTool: rejects invalid timeoutMs (${String(badTimeout)}) with a soft error without spawning`, async () => {
    const spawnSpy = spyOn(Bun, "spawn");
    const res = await bashTool("echo should-not-run", process.cwd(), badTimeout);
    expect(res).toEqual({ success: false, output: "", error: "timeoutMs must be > 0" });
    expect(spawnSpy).not.toHaveBeenCalled();
  });
}

test("bisectTool: pre-aborted AbortSignal stops immediately without spawning git", async () => {
  const spawnSpy = spyOn(Bun, "spawn");
  const controller = new AbortController();
  controller.abort();

  const res = await bisectTool("HEAD~1", "HEAD", "true", false, 40, 60_000, process.cwd(), controller.signal);
  expect(res).toEqual({ success: false, output: "", error: "Bisect aborted" });
  expect(spawnSpy).not.toHaveBeenCalled();
});

test.skipIf(process.platform === "win32")(
  "bisectTool: aborting mid-run kills child predicate, exits without hanging, and runs git bisect reset",
  async () => {
    const repoDir = await makeTempDir("jeo-bisect-repo-");
    const stateDir = await makeTempDir("jeo-bisect-state-");
    const markerPath = path.join(stateDir, "predicate.pid");

    gitSync(repoDir, ["init", "-b", "main"]);
    gitSync(repoDir, ["config", "user.name", "Tester"]);
    gitSync(repoDir, ["config", "user.email", "tester@example.test"]);

    await fs.writeFile(path.join(repoDir, "file.txt"), "v1\n");
    gitSync(repoDir, ["add", "."]);
    gitSync(repoDir, ["commit", "-m", "good"]);
    const goodSha = gitSync(repoDir, ["rev-parse", "HEAD"]);

    await fs.writeFile(path.join(repoDir, "file.txt"), "v2\n");
    gitSync(repoDir, ["add", "."]);
    gitSync(repoDir, ["commit", "-m", "mid"]);

    await fs.writeFile(path.join(repoDir, "file.txt"), "v3\n");
    gitSync(repoDir, ["add", "."]);
    gitSync(repoDir, ["commit", "-m", "bad"]);

    const pidReady = Promise.withResolvers<number>();
    const tryReadPid = () => {
      try {
        const raw = fsSync.readFileSync(markerPath, "utf8").trim();
        const pid = Number(raw);
        if (Number.isInteger(pid) && pid > 0) {
          childPids.push(pid);
          pidReady.resolve(pid);
        }
      } catch {}
    };

    const watcher = fsSync.watch(stateDir, (_event, filename) => {
      if (filename === "predicate.pid") tryReadPid();
    });
    watchers.push(watcher);
    tryReadPid();

    const controller = new AbortController();
    const predicate = `echo $$ > "${markerPath}.tmp" && mv "${markerPath}.tmp" "${markerPath}" && exec sleep 30`;
    const bisectPromise = bisectTool(goodSha, "HEAD", predicate, false, 40, 60_000, repoDir, controller.signal);

    const predicatePid = await pidReady.promise;
    controller.abort();

    const res = await bisectPromise;
    expect(res.success).toBe(false);
    expect(res.error).toBe("Bisect aborted");
    expect(fsSync.existsSync(path.join(repoDir, ".git", "BISECT_START"))).toBe(false);
    expect(gitSync(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(isPidAlive(predicatePid)).toBe(false);
  },
);
