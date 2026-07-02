/**
 * System-clipboard COPY for the jeo TUI.
 *
 * Why this exists — the terminal reality:
 *  - `cmd+c` / `cmd+v` are owned by the terminal emulator + OS, NOT the app. A
 *    terminal program cannot bind them. `cmd+v` already works: jeo enables
 *    bracketed paste (DECSET 2004), so a paste arrives as data on stdin. `cmd+c`
 *    copies whatever the user has SELECTED with the mouse — that selection is the
 *    terminal's, and the only way an app can put text on the system clipboard
 *    itself is the OSC 52 escape (or a local clipboard subprocess).
 *  - Under tmux `mouse on`, a mouse drag is captured by tmux's copy-mode instead
 *    of the terminal, so `cmd+c` no longer copies the dragged text. The fix lives
 *    in the tmux profile (`copy-command`, see launch/tmux.ts): it pipes the
 *    copy-mode selection straight to the system clipboard tool.
 *
 * This module gives jeo an app-driven "copy to the system clipboard" that works
 * locally AND across SSH/tmux:
 *  - OSC 52 (`ESC ] 52 ; c ; <base64> BEL`) asks the OUTER terminal to set its
 *    clipboard — the only mechanism that survives an SSH hop. Wrapped in tmux DCS
 *    passthrough when running inside tmux so it reaches the real terminal.
 *  - A local clipboard subprocess (pbcopy / wl-copy / xclip / xsel / clip) as a
 *    belt-and-suspenders path when jeo runs on the same machine as the terminal.
 */

/** Max base64 payload pushed through OSC 52. Many terminals silently drop very
 *  large clipboard writes (xterm's default is ~100KB of selection data); past
 *  this we skip OSC 52 and rely on the local clipboard tool instead. */
export const OSC52_MAX_BASE64 = 100_000;

/** Resolve the effective OSC 52 base64-payload cap. `JEO_OSC52_MAX` overrides the
 *  conservative {@link OSC52_MAX_BASE64} default for terminals/tmux configured to
 *  accept larger clipboard writes (e.g. tmux `set -g set-clipboard on` with a raised
 *  `buffer-limit`, or a terminal without xterm's ~100KB selection limit). A value
 *  `<= 0` disables the cap entirely (Infinity); an unparseable value keeps the
 *  default. Pure (env injected) so it is testable without touching the host. */
export function osc52MaxBase64(env: Record<string, string | undefined> = process.env): number {
  const raw = env.JEO_OSC52_MAX;
  if (raw === undefined || raw.trim() === "") return OSC52_MAX_BASE64;
  const n = Number(raw);
  if (!Number.isFinite(n)) return OSC52_MAX_BASE64;
  return n <= 0 ? Number.POSITIVE_INFINITY : n;
}

/**
 * Resolve the local system-clipboard WRITE command for a platform, or null when
 * no tool is available. Pure (the `which` probe is injected) so it is testable
 * without touching the host.
 *  - macOS: `pbcopy`.
 *  - Windows: `clip` (clip.exe).
 *  - Linux/BSD: Wayland `wl-copy` first, then X11 `xclip`, then `xsel`.
 */
export function systemClipboardCopyCommand(
  platform: NodeJS.Platform,
  which: (bin: string) => string | null,
): string[] | null {
  if (platform === "darwin") return which("pbcopy") ? ["pbcopy"] : null;
  if (platform === "win32") return ["clip"]; // clip.exe always ships with Windows

  if (which("wl-copy")) return ["wl-copy"];
  if (which("xclip")) return ["xclip", "-selection", "clipboard"];
  if (which("xsel")) return ["xsel", "--clipboard", "--input"];
  return null;
}

/**
 * Resolve the local system-clipboard READ command for a platform, or null when no
 * tool is available — the mirror of {@link systemClipboardCopyCommand} for the
 * Ctrl+V text-paste fallback. Pure (the `which` probe is injected) for testability.
 *  - macOS: `pbpaste`.
 *  - Windows: PowerShell `Get-Clipboard` (`-Raw` keeps embedded newlines intact).
 *  - Linux/BSD: Wayland `wl-paste` first, then X11 `xclip -o`, then `xsel`.
 */
export function systemClipboardPasteCommand(
  platform: NodeJS.Platform,
  which: (bin: string) => string | null,
): string[] | null {
  if (platform === "darwin") return which("pbpaste") ? ["pbpaste"] : null;
  if (platform === "win32") {
    return ["powershell", "-NoProfile", "-Command", "Get-Clipboard -Raw"];
  }
  if (which("wl-paste")) return ["wl-paste", "--no-newline"];
  if (which("xclip")) return ["xclip", "-selection", "clipboard", "-o"];
  if (which("xsel")) return ["xsel", "--clipboard", "--output"];
  return null;
}

/**
 * Read TEXT from the system clipboard, or null when empty / no tool / the read
 * failed. Never throws; capped at `timeoutMs` so a hung clipboard tool (remote
 * X11, sandboxed PowerShell) cannot freeze the prompt. Used as the Ctrl+V
 * fallback when the clipboard holds no image — previously that combination was
 * a SILENT no-op (one of the "복사붙여넣기가 잘 동작안하는 경우").
 */
export async function readClipboardText(
  deps: { which?: (bin: string) => string | null; platform?: NodeJS.Platform } = {},
  timeoutMs = 4000,
): Promise<string | null> {
  const platform = deps.platform ?? process.platform;
  const which = deps.which ?? ((bin: string) => Bun.which(bin));
  const cmd = systemClipboardPasteCommand(platform, which);
  if (!cmd) return null;
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, timeoutMs);
    const text = await new Response(proc.stdout).text();
    clearTimeout(timer);
    if ((await proc.exited) !== 0) return null;
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * The single shell command string tmux's `copy-command` option runs to push a
 * copy-mode selection onto the system clipboard, or null when no tool exists.
 * With `copy-command` set + `mouse on`, a mouse drag-select (and right-click
 * paste menus, in terminals that surface them) lands directly on the system
 * clipboard — bypassing OSC 52's terminal-support requirement. Shares the
 * resolver above so the REPL `/dump` path and the tmux profile never diverge.
 */
export function tmuxCopyCommand(
  platform: NodeJS.Platform,
  which: (bin: string) => string | null,
): string | null {
  const argv = systemClipboardCopyCommand(platform, which);
  return argv ? argv.join(" ") : null;
}

export interface Osc52Options {
  /** Wrap in tmux DCS passthrough so the sequence reaches the OUTER terminal. */
  tmux?: boolean;
  /** Clipboard selection: `c` = system clipboard (default), `p` = primary. */
  clipboard?: "c" | "p";
  /** Max base64 payload to emit (default {@link OSC52_MAX_BASE64}); larger returns "". */
  maxBase64?: number;
}

/**
 * Build the OSC 52 clipboard-SET escape for `text`, or "" when the base64 payload
 * exceeds the cap (default {@link OSC52_MAX_BASE64}, overridable via `maxBase64`; the
 * caller falls back to a local tool). When `tmux` is set the whole sequence is wrapped
 * in DCS passthrough (`ESC P tmux ; … ESC \`) with every inner ESC doubled, the tmux
 * contract for forwarding an escape to the terminal underneath it.
 */
export function osc52Sequence(text: string, opts: Osc52Options = {}): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  if (b64.length > (opts.maxBase64 ?? OSC52_MAX_BASE64)) return "";
  const target = opts.clipboard ?? "c";
  const inner = `\x1b]52;${target};${b64}\x07`;
  if (!opts.tmux) return inner;
  // tmux passthrough: inner ESCs are doubled; the trailing ESC \ is the DCS
  // terminator and is appended AFTER the doubling, never itself doubled.
  return `\x1bPtmux;${inner.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
}

export interface CopyToClipboardDeps {
  /** Write the OSC 52 escape to the terminal (defaults to process.stdout). */
  write?: (s: string) => void;
  /** Spawn a local clipboard subprocess (defaults to Bun.spawn). */
  spawn?: (cmd: string[], opts: { stdin: "pipe" }) => { stdin: { write(s: string): void; end(): unknown }; exited: Promise<number> };
  /** Probe for a binary on PATH (defaults to Bun.which). */
  which?: (bin: string) => string | null;
  /** Host platform (defaults to process.platform). */
  platform?: NodeJS.Platform;
  /** True when running inside tmux (defaults to !!process.env.TMUX). */
  insideTmux?: boolean;
  /** Environment for resolving the OSC 52 cap (`JEO_OSC52_MAX`); defaults to process.env. */
  env?: Record<string, string | undefined>;
}

export interface CopyResult {
  /** OSC 52 escape was emitted to the terminal. */
  osc52: boolean;
  /** A local clipboard subprocess accepted the text. */
  local: boolean;
  /** OSC 52 was SKIPPED because the base64 payload exceeded the cap — the remote
   *  (SSH/tmux) clipboard was NOT updated; only a local tool, if any, ran. Lets the
   *  caller warn the user instead of silently dropping the remote path. */
  osc52SkippedTooLarge: boolean;
}

/**
 * Copy `text` to the system clipboard via BOTH available paths: OSC 52 (works
 * over SSH/tmux) and a local clipboard subprocess (works on the same host). Both
 * are best-effort; the union maximizes the chance the user's `cmd+v` finds the
 * text regardless of where the terminal actually runs. Returns which paths fired.
 */
export async function copyTextToClipboard(text: string, deps: CopyToClipboardDeps = {}): Promise<CopyResult> {
  const platform = deps.platform ?? process.platform;
  const which = deps.which ?? ((bin: string) => Bun.which(bin));
  const insideTmux = deps.insideTmux ?? !!process.env.TMUX;
  const write = deps.write ?? ((s: string) => { try { process.stdout.write(s); } catch { /* terminal gone */ } });
  const spawn = deps.spawn ?? ((cmd, opts) => Bun.spawn(cmd, opts) as ReturnType<NonNullable<CopyToClipboardDeps["spawn"]>>);
  const maxBase64 = osc52MaxBase64(deps.env ?? process.env);

  const result: CopyResult = { osc52: false, local: false, osc52SkippedTooLarge: false };

  const seq = osc52Sequence(text, { tmux: insideTmux, maxBase64 });
  if (seq) {
    write(seq);
    result.osc52 = true;
  } else {
    // osc52Sequence only returns "" when the payload is over the cap.
    result.osc52SkippedTooLarge = true;
  }

  const cmd = systemClipboardCopyCommand(platform, which);
  if (cmd) {
    try {
      const proc = spawn(cmd, { stdin: "pipe" });
      proc.stdin.write(text);
      await proc.stdin.end();
      const code = await proc.exited;
      if (code === 0) result.local = true;
    } catch { /* local tool unavailable / failed — OSC 52 may still have worked */ }
  }

  return result;
}
