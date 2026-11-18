/**
 * Named-tab browser session registry via Playwright — already a jeo-code dependency
 * for its own test suite, so this reuses it rather than adding a second automation
 * engine. One shared headless Chromium instance is launched lazily on the first
 * `open()` and kept alive across calls; tabs are addressed by name and reused.
 *
 * Scope: headless Chromium only for v1 — no existing Chrome profile attach,
 * no Electron/CDP-endpoint connect, no stealth-mode patches. A plain headless
 * session supports fetching, observing, and clicking through pages.
 */
import { chromium, type Browser, type Page } from "playwright";
import { createTab, type Tab } from "./browser-tab";

interface TabEntry {
  page: Page;
  tab: Tab;
}

export class BrowserSession {
  private browser: Browser | undefined;
  private tabs = new Map<string, TabEntry>();
  private launchingPromise: Promise<Browser> | undefined;

  get openTabNames(): string[] {
    return [...this.tabs.keys()];
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (this.launchingPromise) return this.launchingPromise;
    // Previous browser disconnected or exited — drop stale tab entries before relaunching.
    this.tabs.clear();
    this.browser = undefined;
    this.launchingPromise = chromium.launch({ headless: true })
      .then((browser) => {
        this.browser = browser;
        return browser;
      })
      .finally(() => {
        this.launchingPromise = undefined;
      });
    return this.launchingPromise;
  }

  /** Open (or reuse) a named tab. Navigates when `url` is given. */
  async open(name: string, url?: string, viewport?: { width: number; height: number }): Promise<Tab> {
    const browser = await this.ensureBrowser();
    let entry = this.tabs.get(name);
    if (!entry) {
      const page = await browser.newPage(viewport ? { viewport } : undefined);
      const existing = this.tabs.get(name);
      if (existing) {
        await page.close().catch(() => {});
        entry = existing;
        if (viewport) await entry.page.setViewportSize(viewport);
      } else {
        entry = { page, tab: createTab(page) };
        this.tabs.set(name, entry);
      }
    } else if (viewport) {
      await entry.page.setViewportSize(viewport);
    }
    if (url) await entry.tab.goto(url);
    return entry.tab;
  }

  /** Look up an already-open tab by name, or throw a clear error. */
  get(name: string): Tab {
    const entry = this.tabs.get(name);
    if (!entry) {
      throw new Error(`No open tab named '${name}'. Call browser {action:"open", name} first.`);
    }
    return entry.tab;
  }

  has(name: string): boolean {
    return this.tabs.has(name);
  }

  get browserInstance(): Browser | undefined {
    return this.browser;
  }

  /** Close one named tab, or every tab (`all`). `all` also closes the shared browser. */
  async close(name?: string, all = false): Promise<string[]> {
    const closed: string[] = [];
    if (all) {
      if (this.launchingPromise) {
        await this.launchingPromise.catch(() => {});
      }
      for (const [n, entry] of this.tabs) {
        await entry.page.close().catch(() => {});
        closed.push(n);
      }
      this.tabs.clear();
      if (this.browser) {
        await this.browser.close().catch(() => {});
        this.browser = undefined;
      }
      return closed;
    }
    if (name) {
      const entry = this.tabs.get(name);
      if (entry) {
        await entry.page.close().catch(() => {});
        this.tabs.delete(name);
        closed.push(name);
      }
    }
    return closed;
  }

  async terminate(): Promise<void> {
    await this.close(undefined, true);
  }

  /** Synchronous last-resort cleanup for `process.on("exit")` where async work cannot run. */
  terminateSync(): void {
    const browser = this.browser;
    const procFn: unknown = browser && "process" in browser ? browser.process : undefined;
    const proc: unknown = typeof procFn === "function" ? Reflect.apply(procFn, browser, []) : undefined;
    if (proc && typeof proc === "object") {
      const killFn: unknown = "kill" in proc ? proc.kill : undefined;
      if (typeof killFn === "function") {
        const exitCode = "exitCode" in proc ? proc.exitCode : undefined;
        const signalCode = "signalCode" in proc ? proc.signalCode : undefined;
        if ((exitCode === null || exitCode === undefined) && (signalCode === null || signalCode === undefined)) {
          try {
            Reflect.apply(killFn, proc, ["SIGKILL"]);
          } catch {
            try { Reflect.apply(killFn, proc, []); } catch {}
          }
        }
      }
    } else if (browser) {
      void browser.close().catch(() => {});
    }
    this.tabs.clear();
    this.browser = undefined;
  }
}

/** Process-wide singleton — one shared headless browser, many named tabs. */
export const browserSession = new BrowserSession();

const SIGNAL_TERMINATE_GRACE_MS = 1_500;
const handleSignalTermination = (sig: "SIGINT" | "SIGTERM", listener: () => void): void => {
  const alone = process.listenerCount(sig) <= 1;
  if (!alone) return;
  const termination = browserSession.terminate().catch(() => {});
  const { promise: timeout, resolve: resolveTimeout } = Promise.withResolvers<void>();
  const timer = setTimeout(resolveTimeout, SIGNAL_TERMINATE_GRACE_MS);
  timer.unref?.();
  void Promise.race([termination, timeout]).finally(() => {
    clearTimeout(timer);
    browserSession.terminateSync();
    process.removeListener(sig, listener);
    try {
      process.kill(process.pid, sig);
    } catch {
      process.exit(sig === "SIGINT" ? 130 : 143);
    }
  });
};
const onSigint = () => handleSignalTermination("SIGINT", onSigint);
const onSigterm = () => handleSignalTermination("SIGTERM", onSigterm);

process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

// Safety net: never leave a headless Chromium process running past the CLI's exit.
process.on("exit", () => {
  browserSession.terminateSync();
});
