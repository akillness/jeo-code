/**
 * High-level per-tab helpers for the `browser` tool (gjc `browser` parity, via
 * Playwright instead of puppeteer — jeo-code already ships `playwright` for its own
 * test suite; this reuses it rather than adding a second automation dependency).
 *
 * `observe()` mirrors gjc's accessibility-snapshot-first philosophy: it returns a
 * bounded list of interactive elements (role/name/value) instead of a raw DOM dump
 * or a screenshot, and tags each one with a `data-jeo-observe-id` attribute so a
 * later `act`/`run` call can address it by stable numeric `id` instead of a fragile
 * CSS selector or pixel coordinates. Ids are stable until the next `observe()`/
 * navigation, exactly like the real tool's contract.
 */
import type { Page } from "playwright";

// Module-scoped (NOT global) DOM shims: these `page.evaluate()` callbacks run
// INSIDE the browser page, not in this Bun/Node process, so they need `document`/
// `HTMLElement` in scope for the callback body to type-check — but a real
// `/// <reference lib="dom" />` pulls DOM's global `ReadableStream`/`Headers`
// declarations into the WHOLE program's type-checking and breaks unrelated
// Bun/Node-side files (job-registry.ts, the anthropic provider, ...) that rely on
// the Node/Bun versions of those types. `declare const`/`type` inside a module
// file are scoped to this file only, so they carry no such risk.
declare const document: any;
type HTMLElement = any;
type HTMLInputElement = any;

export interface ObservedElement {
  id: number;
  role: string;
  name: string;
  value: string;
  tag: string;
}

const OBSERVE_ATTR = "data-jeo-observe-id";
const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, [role], [onclick], [tabindex]';
const MAX_OBSERVED = 300;

export type ExtractFormat = "markdown" | "text" | "html";

export interface Tab {
  page: Page;
  observe(): Promise<ObservedElement[]>;
  id(n: number): import("playwright").Locator;
  goto(url: string, opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" }): Promise<void>;
  click(selectorOrId: string | number): Promise<void>;
  type(selectorOrId: string | number, text: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  press(key: string, opts?: { selector?: string }): Promise<void>;
  scroll(dx: number, dy: number): Promise<void>;
  select(selector: string, ...values: string[]): Promise<string[]>;
  waitFor(selectorOrMs: string | number): Promise<void>;
  back(): Promise<void>;
  extract(format?: ExtractFormat): Promise<string>;
  screenshot(opts?: { selector?: string; fullPage?: boolean }): Promise<Buffer>;
  evaluate<T>(fn: (...args: any[]) => T, ...args: any[]): Promise<T>;
}

function resolveLocator(page: Page, selectorOrId: string | number) {
  return typeof selectorOrId === "number" ? page.locator(`[${OBSERVE_ATTR}="${selectorOrId}"]`) : page.locator(selectorOrId).first();
}

export function createTab(page: Page): Tab {
  return {
    page,

    async observe(): Promise<ObservedElement[]> {
      return page.evaluate(
        ({ sel, attr, max }) => {
          const nodes = Array.from(document.querySelectorAll(sel)).slice(0, max) as HTMLElement[];
          return nodes.map((el, i) => {
            el.setAttribute(attr, String(i));
            const tag = el.tagName.toLowerCase();
            const explicitRole = el.getAttribute("role");
            const role = explicitRole || (tag === "a" ? "link" : tag === "button" ? "button" : tag === "input" ? "textbox" : tag === "select" ? "combobox" : tag === "textarea" ? "textbox" : tag);
            const name = el.getAttribute("aria-label") || (el as HTMLInputElement).placeholder || el.textContent?.trim().replace(/\s+/g, " ").slice(0, 200) || "";
            const value = (el as HTMLInputElement).value ?? "";
            return { id: i, role, name, value, tag };
          });
        },
        { sel: INTERACTIVE_SELECTOR, attr: OBSERVE_ATTR, max: MAX_OBSERVED },
      );
    },

    id(n: number) {
      return page.locator(`[${OBSERVE_ATTR}="${n}"]`);
    },

    async goto(url, opts) {
      await page.goto(url, { waitUntil: opts?.waitUntil ?? "load" });
    },

    async click(selectorOrId) {
      await resolveLocator(page, selectorOrId).click();
    },

    async type(selectorOrId, text) {
      const loc = resolveLocator(page, selectorOrId);
      await loc.fill("");
      await loc.pressSequentially(text);
    },

    async fill(selector, value) {
      await page.locator(selector).first().fill(value);
    },

    async press(key, opts) {
      if (opts?.selector) await page.locator(opts.selector).first().press(key);
      else await page.keyboard.press(key);
    },

    async scroll(dx, dy) {
      await page.mouse.wheel(dx, dy);
    },

    async select(selector, ...values) {
      return page.locator(selector).first().selectOption(values);
    },

    async waitFor(selectorOrMs) {
      if (typeof selectorOrMs === "number") await page.waitForTimeout(selectorOrMs);
      else await page.waitForSelector(selectorOrMs);
    },

    async back() {
      await page.goBack({ waitUntil: "load" });
    },

    async extract(format: ExtractFormat = "markdown") {
      if (format === "html") return page.content();
      // No readability port for v1 — markdown/text both collapse to the page's
      // rendered plain text (still far more compact/relevant than raw HTML).
      return page.evaluate(() => document.body?.innerText ?? "");
    },

    async screenshot(opts) {
      if (opts?.selector) return page.locator(opts.selector).first().screenshot();
      return page.screenshot({ fullPage: !!opts?.fullPage });
    },

    async evaluate(fn, ...args) {
      return page.evaluate(fn as any, ...(args as any));
    },
  };
}
