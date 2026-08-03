import { test, expect } from "bun:test";
import {
  APPLESCRIPT_BROWSERS,
  browserTabCloseCommand,
  callbackUrlFragment,
  closeAuthTab,
  closeAuthTabScript,
} from "../src/auth/browser-tab";

// The OAuth callback page asks the browser to close itself, but every current
// browser refuses that for a tab its own script did not open — and jeo hands the
// auth URL to the OS, so the tab is always "user-opened". Driving the browser from
// the outside (macOS AppleScript) is what actually closes it. These tests pin the
// targeting rules (only OUR callback URL, only running browsers) and the
// fail-silent contract, without ever spawning a real osascript.

test("callbackUrlFragment: narrows a redirect URI to host:port + path", () => {
  expect(callbackUrlFragment("http://localhost:1455/callback")).toBe("localhost:1455/callback");
  expect(callbackUrlFragment("http://localhost:54545/callback?code=x")).toBe("localhost:54545/callback");
  // Unparseable input must not produce a fragment that could match unrelated tabs.
  expect(callbackUrlFragment("not a url")).toBe("");
});

test("closeAuthTabScript: closes only tabs whose URL contains the callback fragment", () => {
  const script = closeAuthTabScript("localhost:1455/callback", ["Google Chrome"]);
  expect(script).toContain('if (URL of t) contains "localhost:1455/callback" then close t');
  // Never launches a browser: the whole block is gated on `is running`.
  expect(script).toContain('if application "Google Chrome" is running then');
  // A missing/sandboxed browser cannot abort the remaining blocks.
  expect(script.startsWith("try")).toBe(true);
  expect(script.trimEnd().endsWith("end try")).toBe(true);
});

test("closeAuthTabScript: emits one static tell block per browser (dynamic tells cannot compile app terms)", () => {
  const script = closeAuthTabScript("localhost:1/callback");
  for (const app of APPLESCRIPT_BROWSERS) {
    expect(script).toContain(`tell application "${app}"`);
  }
  expect(script.match(/end tell/g)?.length).toBe(APPLESCRIPT_BROWSERS.length);
  expect(script).not.toContain("tell application appName");
});

test("closeAuthTabScript: quotes/backslashes in the fragment cannot break out of the literal", () => {
  const script = closeAuthTabScript('evil" & do shell script "boom', ["Safari"]);
  expect(script).toContain('\\"');
  expect(script).not.toContain('contains "evil" &');
});

test("browserTabCloseCommand: macOS gets an osascript command, other platforms get none", () => {
  const cmd = browserTabCloseCommand("darwin", "localhost:1455/callback");
  expect(cmd?.[0]).toBe("osascript");
  expect(cmd?.[1]).toBe("-e");
  expect(cmd?.[2]).toContain("localhost:1455/callback");
  // No scriptable, browser-agnostic tab API exists there — the page's own message
  // is the fallback, and jeo must not shell out to something unreliable.
  expect(browserTabCloseCommand("linux", "localhost:1455/callback")).toBeNull();
  expect(browserTabCloseCommand("win32", "localhost:1455/callback")).toBeNull();
  // An empty fragment would match every tab — refuse to build a command at all.
  expect(browserTabCloseCommand("darwin", "")).toBeNull();
});

test("closeAuthTab: spawns the close command and reports success on exit 0", async () => {
  const calls: string[][] = [];
  const ok = await closeAuthTab("http://localhost:1455/callback", {
    platform: "darwin",
    env: {},
    spawn: cmd => {
      calls.push(cmd);
      return { exited: Promise.resolve(0), kill: () => {} };
    },
  });
  expect(ok).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]![0]).toBe("osascript");
  expect(calls[0]![2]).toContain("localhost:1455/callback");
});

test("closeAuthTab: JEO_AUTH_TAB_CLOSE=0 opts out entirely (no spawn)", async () => {
  let spawned = false;
  const ok = await closeAuthTab("http://localhost:1455/callback", {
    platform: "darwin",
    env: { JEO_AUTH_TAB_CLOSE: "0" },
    spawn: () => {
      spawned = true;
      return { exited: Promise.resolve(0), kill: () => {} };
    },
  });
  expect(ok).toBe(false);
  expect(spawned).toBe(false);
});

test("closeAuthTab: a non-zero exit, a throw, or an unsupported platform never rejects", async () => {
  const failed = await closeAuthTab("http://localhost:1455/callback", {
    platform: "darwin",
    env: {},
    spawn: () => ({ exited: Promise.resolve(1), kill: () => {} }),
  });
  expect(failed).toBe(false);

  const threw = await closeAuthTab("http://localhost:1455/callback", {
    platform: "darwin",
    env: {},
    spawn: () => {
      throw new Error("osascript missing");
    },
  });
  expect(threw).toBe(false);

  expect(await closeAuthTab("http://localhost:1455/callback", { platform: "linux", env: {} })).toBe(false);
});

test("closeAuthTab: a hung osascript is killed at the timeout instead of stalling the login", async () => {
  let killed = false;
  const started = Date.now();
  const ok = await closeAuthTab("http://localhost:1455/callback", {
    platform: "darwin",
    env: {},
    timeoutMs: 30,
    spawn: () => ({
      exited: new Promise<number>(() => {}), // never settles (permission prompt, wedged browser)
      kill: () => {
        killed = true;
      },
    }),
  });
  expect(ok).toBe(false);
  expect(killed).toBe(true);
  expect(Date.now() - started).toBeLessThan(2000);
});
