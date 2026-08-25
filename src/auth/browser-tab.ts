/**
 * Best-effort closing of the OAuth callback TAB the login opened.
 *
 * Why this exists: the callback page already asks the browser to close itself
 * (`window.close()` after a short countdown), but every current browser REFUSES
 * that for a tab the page's own script did not open. jeo hands the auth URL to
 * the OS (`open` / `xdg-open` / `start`), so the tab is user-opened by that rule
 * and the request is silently ignored — the login succeeds in the terminal while
 * a dead "Login complete" tab lingers in the browser (the reported bug).
 *
 * The only reliable way to close such a tab is to drive the browser from the
 * outside. macOS exposes exactly that through AppleScript, so this module builds
 * a targeted script that closes ONLY tabs whose URL contains the loopback
 * callback (e.g. `localhost:1455/callback`) — never any other tab — in whichever
 * of the common browsers is ALREADY running (`is running` never launches one).
 *
 * Everything here is best effort and failure-silent: no automation permission, a
 * browser without an AppleScript dictionary (Firefox), Linux/Windows, or a user
 * who already closed the tab all end as a no-op. `JEO_AUTH_TAB_CLOSE=0` opts out.
 */
import { jeoEnv } from "../util/env";

/** Chromium-family browsers whose AppleScript dictionary exposes `windows`/`tabs`
 *  with a `URL` property and a `close` command. Safari uses the same shape and is
 *  appended by {@link closeAuthTabScript}. Firefox has no tab-level dictionary at
 *  all, so it cannot be driven this way — its tab keeps the page's own fallback. */
export const APPLESCRIPT_BROWSERS: readonly string[] = [
  "Google Chrome",
  "Google Chrome Beta",
  "Google Chrome Canary",
  "Chromium",
  "Brave Browser",
  "Microsoft Edge",
  "Vivaldi",
  "Arc",
  "Safari",
];

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * The AppleScript that closes every tab whose URL contains `fragment`.
 *
 * One STATIC `tell` block per browser (never a dynamic `tell application appName`):
 * app-specific terms like `URL of t` only compile inside a literal tell block, so a
 * variable-driven loop would fail to compile and close nothing.
 *
 * Pass ONLY browsers that are actually running (see {@link runningBrowserApps}). A
 * block naming an app that is not INSTALLED cannot resolve its terminology and
 * fails at COMPILE time — which `try` cannot catch, since `try` guards runtime
 * errors only — so one missing browser would sink the whole script and close
 * nothing (verified with `osacompile`: "Expected class name but found property").
 * Each block keeps its own `try` + `is running` guard for the runtime races: a
 * browser quitting mid-script, or a window that refuses the query.
 */
export function closeAuthTabScript(fragment: string, browsers: readonly string[] = APPLESCRIPT_BROWSERS): string {
  const frag = escapeAppleScript(fragment);
  const blocks = browsers.map(
    app => `try
  if application "${escapeAppleScript(app)}" is running then
    tell application "${escapeAppleScript(app)}"
      repeat with w in (every window)
        repeat with t in (every tab of w)
          try
            if (URL of t) contains "${frag}" then close t
          end try
        end repeat
      end repeat
    end tell
  end if
end try`,
  );
  return blocks.join("\n");
}

/** The subset of {@link APPLESCRIPT_BROWSERS} currently running, derived from
 *  `ps -Ax -o comm=` output (each line is an executable path such as
 *  `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`). Reading the
 *  process list needs no Automation permission, so this narrows the generated
 *  script — and with it the compile surface and the number of permission prompts —
 *  to the browsers that could actually be holding the callback tab. */
export function runningBrowserApps(psOutput: string, browsers: readonly string[] = APPLESCRIPT_BROWSERS): string[] {
  const lines = psOutput.split("\n");
  return browsers.filter(app => lines.some(line => line.includes(`/${app}.app/`)));
}

/** The command to run for `platform`, or null when the platform has no reliable
 *  way to close a tab it did not open (Linux/Windows: no scriptable, browser-
 *  agnostic tab API — the callback page's own message is the fallback there). */
export function browserTabCloseCommand(
  platform: NodeJS.Platform,
  fragment: string,
  browsers: readonly string[] = APPLESCRIPT_BROWSERS,
): string[] | null {
  if (platform !== "darwin") return null;
  if (!fragment) return null;
  return ["osascript", "-e", closeAuthTabScript(fragment, browsers)];
}

/** The `host:port/path` slice of a redirect URI — the narrowest fragment that still
 *  identifies THIS login's callback tab (the port is unique per flow/run), so no
 *  unrelated tab can ever match. Returns "" when the URI cannot be parsed. */
export function callbackUrlFragment(redirectUri: string): string {
  try {
    const url = new URL(redirectUri);
    return `${url.host}${url.pathname}`;
  } catch {
    return "";
  }
}

export interface CloseAuthTabOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** Hard cap so a hung/permission-prompting osascript can never stall the login.
   *  The FIRST close on a machine raises macOS's "control Google Chrome" Automation
   *  prompt; if the user does not answer in time this kills the helper and the page's
   *  own fallback message takes over. Answering it once makes later logins instant. */
  timeoutMs?: number;
  /** Injected for tests; defaults to the real spawn. */
  spawn?: (cmd: string[]) => { exited: Promise<number>; kill: () => void };
  /** Running-process listing (`ps -Ax -o comm=`); injected for tests. Returning ""
   *  means "cannot tell", which is treated as "no known browser running". */
  listProcesses?: () => string;
}

/**
 * Close the browser tab still showing this login's callback page. Resolves `true`
 * only when the OS accepted the request; every other outcome (unsupported
 * platform, opt-out, spawn failure, timeout, non-zero exit) resolves `false` and
 * is silent — the terminal already reported the login result, so this must never
 * surface an error of its own.
 */
export async function closeAuthTab(redirectUri: string, opts: CloseAuthTabOptions = {}): Promise<boolean> {
  const env = opts.env ?? process.env;
  if (jeoEnv("AUTH_TAB_CLOSE", env) === "0") return false;
  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin") return false;
  const fragment = callbackUrlFragment(redirectUri);
  if (!fragment) return false;
  const listProcesses =
    opts.listProcesses ??
    (() => {
      try {
        return Bun.spawnSync(["ps", "-Ax", "-o", "comm="], { stdout: "pipe", stderr: "ignore" }).stdout.toString();
      } catch {
        return "";
      }
    });
  // Never script a browser that is not running: an uninstalled app breaks the whole
  // script at compile time, and a running-only list keeps the Automation prompt to
  // the browser the user actually has open.
  const browsers = runningBrowserApps(listProcesses());
  if (browsers.length === 0) return false;
  const cmd = browserTabCloseCommand(platform, fragment, browsers);
  if (!cmd) return false;
  const timeoutMs = opts.timeoutMs ?? 2000;
  const spawn =
    opts.spawn ??
    ((c: string[]) => {
      const proc = Bun.spawn(c, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      return { exited: proc.exited, kill: () => proc.kill() };
    });
  try {
    const proc = spawn(cmd);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<number>(resolve => {
      timer = setTimeout(() => {
        try { proc.kill(); } catch { /* already gone */ }
        resolve(-1);
      }, timeoutMs);
    });
    const code = await Promise.race([proc.exited, timeout]);
    if (timer) clearTimeout(timer);
    return code === 0;
  } catch {
    return false;
  }
}
