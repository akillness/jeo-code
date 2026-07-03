/**
 * `browser` tool — headless Chromium automation via Playwright (gjc `browser`
 * parity — see `browser-session.ts`'s header for the exact scope: headless-only,
 * no profile/CDP/Electron attach, no stealth patches). MUTATING: drives a real
 * browser and can run arbitrary page/host JS via `run`, so it is excluded from
 * read-only subagent roles the same way `bash`/`computer`/`debug` are.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolHandler } from "./engine";
import type { ToolResult } from "./tools";
import { browserSession, type BrowserSession } from "./browser-session";
import type { ObservedElement, ExtractFormat } from "./browser-tab";

/** One-line protocol description appended to the launch system prompt. */
export const BROWSER_TOOL_PROTOCOL_LINE =
  `browser {action:"open"|"close"|"run"|"act", name?, url?, viewport?, code?, actions?, all?} — headless ` +
  `Chromium automation (Playwright). 'open' {name, url?} opens/reuses a named tab (name defaults to "main"). ` +
  `'close' {name?, all?} closes one tab or every tab. 'act' {name, actions:[{verb, ...}]} runs structured steps ` +
  `(navigate/click/type/fill/select/press/scroll/back/wait/observe/extract/screenshot) — address elements by ` +
  `numeric 'id' from a prior 'observe' step (preferred) or a CSS 'selector'; prefer 'observe' over 'screenshot' ` +
  `for understanding page state. 'run' {name, code} executes an async function BODY with page/browser/tab/` +
  `display/assert/wait in scope for anything the structured verbs don't cover.`;

function err(message: string): ToolResult {
  return { success: false, output: "", error: message };
}

function tabNameOf(args: Record<string, any>): string {
  const n = typeof args.name === "string" ? args.name.trim() : "";
  return n || "main";
}

interface ActStep {
  verb: string;
  [key: string]: unknown;
}

async function runActStep(session: BrowserSession, name: string, step: ActStep): Promise<Record<string, unknown>> {
  const tab = session.get(name);
  const verb = String(step.verb ?? "").trim().toLowerCase();
  try {
    switch (verb) {
      case "navigate": {
        const url = String(step.url ?? "");
        if (!url) return { verb, ok: false, error: "navigate requires 'url'." };
        await tab.goto(url, { waitUntil: step.wait_until as any });
        return { verb, ok: true, url: tab.page.url() };
      }
      case "click": {
        const target = step.id !== undefined ? Number(step.id) : String(step.selector ?? "");
        if (target === "" ) return { verb, ok: false, error: "click requires 'id' or 'selector'." };
        await tab.click(target);
        return { verb, ok: true };
      }
      case "type": {
        const target = step.id !== undefined ? Number(step.id) : String(step.selector ?? "");
        const text = String(step.text ?? "");
        if (target === "") return { verb, ok: false, error: "type requires 'id' or 'selector'." };
        await tab.type(target, text);
        return { verb, ok: true };
      }
      case "fill": {
        const selector = String(step.selector ?? "");
        if (!selector) return { verb, ok: false, error: "fill requires 'selector'." };
        await tab.fill(selector, String(step.value ?? ""));
        return { verb, ok: true };
      }
      case "select": {
        const selector = String(step.selector ?? "");
        if (!selector) return { verb, ok: false, error: "select requires 'selector'." };
        const values = Array.isArray(step.values) ? step.values.map((v: unknown) => String(v)) : [];
        const selected = await tab.select(selector, ...values);
        return { verb, ok: true, selected };
      }
      case "press": {
        const key = String(step.key ?? "");
        if (!key) return { verb, ok: false, error: "press requires 'key'." };
        await tab.press(key, { selector: typeof step.selector === "string" ? step.selector : undefined });
        return { verb, ok: true };
      }
      case "scroll": {
        await tab.scroll(Number(step.dx ?? 0), Number(step.dy ?? 0));
        return { verb, ok: true };
      }
      case "back": {
        await tab.back();
        return { verb, ok: true, url: tab.page.url() };
      }
      case "wait": {
        if (typeof step.ms === "number") await tab.waitFor(step.ms);
        else if (typeof step.selector === "string") await tab.waitFor(step.selector);
        else return { verb, ok: false, error: "wait requires 'selector' or 'ms'." };
        return { verb, ok: true };
      }
      case "observe": {
        const elements: ObservedElement[] = await tab.observe();
        return { verb, ok: true, url: tab.page.url(), title: await tab.page.title(), elements };
      }
      case "extract": {
        const format = (typeof step.format === "string" ? step.format : "markdown") as ExtractFormat;
        const content = await tab.extract(format);
        return { verb, ok: true, content: content.length > 8000 ? content.slice(0, 8000) + "…" : content };
      }
      case "screenshot": {
        const buf = await tab.screenshot({ selector: typeof step.selector === "string" ? step.selector : undefined, fullPage: !!step.fullPage });
        const savePath = path.join(os.tmpdir(), `jeo-browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
        await fs.writeFile(savePath, buf);
        return { verb, ok: true, saved: savePath, bytes: buf.length };
      }
      default:
        return { verb, ok: false, error: `Unknown act verb '${verb}'.` };
    }
  } catch (e: any) {
    return { verb, ok: false, error: e.message ?? String(e) };
  }
}

export function createBrowserTool(): ToolHandler {
  return async (args: Record<string, any>, _cwd: string): Promise<ToolResult> => {
    const action = String(args.action ?? "").trim().toLowerCase();

    if (action === "open") {
      const name = tabNameOf(args);
      const url = typeof args.url === "string" && args.url.trim() ? args.url.trim() : undefined;
      const viewport = args.viewport && typeof args.viewport === "object"
        ? { width: Number(args.viewport.width) || 1280, height: Number(args.viewport.height) || 800 }
        : undefined;
      try {
        const tab = await browserSession.open(name, url, viewport);
        return { success: true, output: `Tab '${name}' open at ${tab.page.url() || "about:blank"}.` };
      } catch (e: any) {
        return err(`Failed to open tab '${name}': ${e.message ?? e}`);
      }
    }

    if (action === "close") {
      const all = args.all === true;
      const name = typeof args.name === "string" ? args.name.trim() : undefined;
      if (!all && !name) return err(`browser {action:"close"} requires "name" or "all:true".`);
      const closed = await browserSession.close(name, all);
      return { success: true, output: closed.length ? `Closed: ${closed.join(", ")}.` : "No matching open tab." };
    }

    if (action === "run") {
      const name = tabNameOf(args);
      const code = typeof args.code === "string" ? args.code : "";
      if (!code.trim()) return err(`browser {action:"run"} requires a non-empty "code" body.`);
      if (!browserSession.has(name)) return err(`No open tab named '${name}'. Call browser {action:"open", name} first.`);
      const tab = browserSession.get(name);
      const displayed: string[] = [];
      const display = (v: unknown) => { displayed.push(typeof v === "string" ? v : JSON.stringify(v, null, 2)); };
      const assert = (cond: unknown, message?: string) => { if (!cond) throw new Error(message ?? "Assertion failed"); };
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      try {
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...a: string[]) => (...a: unknown[]) => Promise<unknown>;
        const fn = new AsyncFunction("page", "browser", "tab", "display", "assert", "wait", code);
        const result = await fn(tab.page, browserSession.browserInstance, tab, display, assert, wait);
        const resultText = result === undefined ? "" : `\n\nReturn value:\n${typeof result === "string" ? result : JSON.stringify(result, null, 2)}`;
        return { success: true, output: `${displayed.join("\n")}${resultText}`.trim() || "(no output)" };
      } catch (e: any) {
        return err(`browser run failed: ${e.message ?? e}`);
      }
    }

    if (action === "act") {
      const name = tabNameOf(args);
      if (!browserSession.has(name)) {
        try {
          await browserSession.open(name);
        } catch (e: any) {
          return err(`Failed to open tab '${name}': ${e.message ?? e}`);
        }
      }
      const steps = Array.isArray(args.actions) ? args.actions as ActStep[] : [];
      if (steps.length === 0) return err(`browser {action:"act"} requires a non-empty "actions" array.`);
      const results: Record<string, unknown>[] = [];
      for (const step of steps) {
        results.push(await runActStep(browserSession, name, step));
      }
      const allOk = results.every((r) => r.ok === true);
      return { success: allOk, output: JSON.stringify(results, null, 2) };
    }

    return err(`Unknown browser action '${action}'. Use open | close | run | act.`);
  };
}
