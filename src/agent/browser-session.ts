/**
 * Named-tab browser session registry (gjc `browser` parity, via Playwright — already
 * a jeo-code dependency for its own test suite, so this reuses it rather than adding
 * a second automation engine). One shared headless Chromium instance is launched
 * lazily on the first `open()` and kept alive across calls; tabs are addressed by
 * name and reused ("open once, reuse many times" — the real tool's stated contract).
 *
 * Scope, stated honestly: headless Chromium only for v1 — no existing Chrome profile
 * attach, no Electron/CDP-endpoint connect, no stealth-mode patches. Those are real
 * gaps versus the full tool; a plain headless session covers the large majority of
 * "fetch/observe/click through a page" agent use cases.
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

  get openTabNames(): string[] {
    return [...this.tabs.keys()];
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    this.browser = await chromium.launch({ headless: true });
    return this.browser;
  }

  /** Open (or reuse) a named tab. Navigates when `url` is given. */
  async open(name: string, url?: string, viewport?: { width: number; height: number }): Promise<Tab> {
    const browser = await this.ensureBrowser();
    let entry = this.tabs.get(name);
    if (!entry) {
      const page = await browser.newPage(viewport ? { viewport } : undefined);
      entry = { page, tab: createTab(page) };
      this.tabs.set(name, entry);
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
}

/** Process-wide singleton — one shared headless browser, many named tabs. */
export const browserSession = new BrowserSession();

// Safety net: never leave a headless Chromium process running past the CLI's exit.
process.on("exit", () => {
  void browserSession.terminate();
});
