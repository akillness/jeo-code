/**
 * Terminal color-capability detection + a tiny truecolor gradient engine.
 *
 * The evolution TUI wants smooth per-character color gradients across its ASCII
 * art, but a terminal might support 24-bit truecolor, 256 colors, 16 colors, or
 * nothing at all. This module detects the level from the environment (honoring
 * `NO_COLOR` / `FORCE_COLOR` / `COLORTERM` / `TERM`) and renders gradients that
 * gracefully downgrade: truecolor → 256 → 16 → plain text.
 *
 * Escapes are emitted directly (not via chalk) so the output is deterministic
 * and testable regardless of chalk's own TTY auto-detection.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { visibleWidth as widthOf } from "./width";

/** Color capability tiers. */
export enum ColorLevel {
  None = 0,
  Basic = 1, // 16 colors
  Ansi256 = 2,
  TrueColor = 3,
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export type EnvLike = Record<string, string | undefined>;

const ESC = "\x1b[";
/** Matches any SGR / CSI escape sequence. */
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Remove every SGR escape sequence, leaving only visible characters. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Visible DISPLAY width of a string, ignoring SGR escapes. Delegates to the
 *  width-aware implementation (consensus-seed P2.B9) so CJK/emoji glyphs count 2
 *  columns — every box/pad that calls this (input box, forge cards, welcome,
 *  tables) now aligns correctly for wide-character content instead of overflowing
 *  the right border (the "입력창 깨짐" corruption). */
export function visibleWidth(s: string): number {
  return widthOf(s);
}

/**
 * Detect the terminal color level from an environment map. Pure + injectable so
 * tests can pin behavior. `isTty` is a hint for the ambiguous "no signal" case.
 */
export function detectColorLevel(env: EnvLike = process.env, isTty = false): ColorLevel {
  // NO_COLOR: presence (any value, even empty) disables color. https://no-color.org
  if (env.NO_COLOR !== undefined) return ColorLevel.None;

  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === "0" || force === "false") return ColorLevel.None;
    if (force === "1" || force === "true") return ColorLevel.Basic;
    if (force === "2") return ColorLevel.Ansi256;
    if (force === "3") return ColorLevel.TrueColor;
    // Any other truthy value: assume basic.
    return ColorLevel.Basic;
  }

  const term = (env.TERM ?? "").toLowerCase();
  if (term === "dumb") return ColorLevel.None;

  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return ColorLevel.TrueColor;

  if (/-256(color)?$/.test(term) || term.includes("256")) return ColorLevel.Ansi256;
  if (/^(xterm|screen|vt100|vt220|rxvt|tmux|ansi|linux|konsole|alacritty|kitty|wezterm)/.test(term)) {
    return ColorLevel.Basic;
  }

  return isTty ? ColorLevel.Basic : ColorLevel.None;
}

/** Parse `#rrggbb` / `#rgb` / `rrggbb` into an RGB triple. Defaults to black on bad input. */
export function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

/** Linear interpolation between two RGB colors. `t` in [0,1]. */
export function lerpColor(a: RGB, b: RGB, t: number): RGB {
  const k = Math.max(0, Math.min(1, t));
  return {
    r: clamp255(a.r + (b.r - a.r) * k),
    g: clamp255(a.g + (b.g - a.g) * k),
    b: clamp255(a.b + (b.b - a.b) * k),
  };
}

/** `n` evenly spaced RGB stops from `from` to `to` (inclusive endpoints). */
export function gradientStops(from: RGB, to: RGB, n: number): RGB[] {
  const count = Math.max(1, Math.trunc(n));
  if (count === 1) return [from];
  const out: RGB[] = [];
  for (let i = 0; i < count; i++) out.push(lerpColor(from, to, i / (count - 1)));
  return out;
}

/** Convert an RGB triple to the nearest xterm-256 color index. */
export function rgbToAnsi256(c: RGB): number {
  const { r, g, b } = c;
  // Grayscale ramp (232-255) when channels are near-equal.
  if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const q = (v: number) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

/** Convert an RGB triple to the nearest basic 16-color SGR foreground code (30-37 / 90-97). */
export function rgbToAnsi16(c: RGB): number {
  const { r, g, b } = c;
  const max = Math.max(r, g, b);
  if (max < 40) return 30; // black
  const bright = max > 170;
  const bit = (v: number) => (v > max / 2 ? 1 : 0);
  const code = bit(r) + bit(g) * 2 + bit(b) * 4; // 0..7
  return (bright ? 90 : 30) + code;
}

/** Open-foreground escape for one color at a given level (empty at None). */
export function fgEscape(c: RGB, level: ColorLevel): string {
  switch (level) {
    case ColorLevel.TrueColor:
      return `${ESC}38;2;${c.r};${c.g};${c.b}m`;
    case ColorLevel.Ansi256:
      return `${ESC}38;5;${rgbToAnsi256(c)}m`;
    case ColorLevel.Basic:
      return `${ESC}${rgbToAnsi16(c)}m`;
    default:
      return "";
  }
}

/** Open-background escape for one color at a given level (empty at None). */
export function bgEscape(c: RGB, level: ColorLevel): string {
  switch (level) {
    case ColorLevel.TrueColor:
      return `${ESC}48;2;${c.r};${c.g};${c.b}m`;
    case ColorLevel.Ansi256:
      return `${ESC}48;5;${rgbToAnsi256(c)}m`;
    case ColorLevel.Basic:
      return `${ESC}${rgbToAnsi16(c) + 10}m`;
    default:
      return "";
  }
}

/** Reset escape (empty at None). */
export function resetEscape(level: ColorLevel): string {
  return level === ColorLevel.None ? "" : `${ESC}0m`;
}

/**
 * Apply a left→right color gradient across the visible characters of `text`.
 * SGR escapes already in `text` are stripped first (the gradient owns color).
 * At `ColorLevel.None` the plain text is returned unchanged. Whitespace runs
 * still consume gradient positions so multi-line art stays phase-aligned.
 */
export function applyGradient(text: string, from: RGB, to: RGB, level: ColorLevel = ColorLevel.TrueColor): string {
  const plain = stripAnsi(text);
  if (level === ColorLevel.None || plain.length === 0) return plain;
  const stops = gradientStops(from, to, plain.length);
  let out = "";
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i]!;
    if (ch === " ") {
      out += ch; // don't paint spaces (keeps escapes lean, transparent bg)
      continue;
    }
    out += fgEscape(stops[i]!, level) + ch;
  }
  return out + resetEscape(level);
}

/**
 * Paint `text` on a left→right BACKGROUND gradient (`from`→`to`) with a fixed
 * high-contrast foreground — the status-bar "highlight block" look. Unlike
 * `applyGradient`, spaces ARE painted (the block must be continuous).
 * At `ColorLevel.None` the plain text is returned unchanged.
 */
export function applyBgGradient(
  text: string,
  from: RGB,
  to: RGB,
  level: ColorLevel = ColorLevel.TrueColor,
  fg: RGB = { r: 235, g: 235, b: 235 },
): string {
  const plain = stripAnsi(text);
  if (level === ColorLevel.None || plain.length === 0) return plain;
  const stops = gradientStops(from, to, plain.length);
  let out = fgEscape(fg, level);
  for (let i = 0; i < plain.length; i++) {
    out += bgEscape(stops[i]!, level) + plain[i]!;
  }
  return out + resetEscape(level);
}

/**
 * Apply a flowing color gradient across the visible characters of `text`,
 * shifted by `phase` (0..1 wraps) around the palette.
 * If colorLevel < 3 (or opts.colorLevel < 3), return the text unchanged.
 */
export function animatedGradientText(
  text: string,
  palette: readonly string[],
  phase: number,
  opts: { colorLevel: number }
): string {
  if (opts.colorLevel < 3) {
    return text;
  }
  const plain = stripAnsi(text);
  if (plain.length === 0) {
    return plain;
  }

  const rgbPalette = palette.map(hex => hexToRgb(hex));
  const M = rgbPalette.length;
  if (M === 0) {
    return plain;
  }

  let out = "";
  const N = plain.length;

  for (let i = 0; i < N; i++) {
    const ch = plain[i]!;
    if (ch === " ") {
      out += ch;
      continue;
    }

    const x = N > 1 ? i / (N - 1) : 0;
    let t = (x + phase) % 1;
    if (t < 0) t += 1;

    let color: RGB;
    if (M === 1) {
      color = rgbPalette[0]!;
    } else {
      const rawSegment = t * M;
      const index = Math.floor(rawSegment);
      const fraction = rawSegment - index;
      const colorA = rgbPalette[index % M]!;
      const colorB = rgbPalette[(index + 1) % M]!;
      color = lerpColor(colorA, colorB, fraction);
    }

    out += fgEscape(color, ColorLevel.TrueColor) + ch;
  }

  return out + resetEscape(ColorLevel.TrueColor);
}
export function detectAppearance(env: EnvLike = process.env): "light" | "dark" | undefined {
  const colorfgbg = env.COLORFGBG;
  if (colorfgbg) {
    const parts = colorfgbg.split(";");
    if (parts.length > 1) {
      const bgStr = parts[parts.length - 1]!.trim();
      const bg = parseInt(bgStr, 10);
      if (!isNaN(bg)) {
        if (bg >= 0 && bg <= 6) return "dark";
        if (bg === 8) return "dark";
        if (bg === 7) return "light";
        if (bg >= 9 && bg <= 15) return "light";
        if (bg >= 232 && bg <= 243) return "dark";
        if (bg >= 244 && bg <= 255) return "light";
        if (bg >= 16 && bg <= 231) {
          const code = bg - 16;
          const b = code % 6;
          const g = Math.floor((code % 36) / 6);
          const r = Math.floor(code / 36);
          const R = r * 51;
          const G = g * 51;
          const B = b * 51;
          const Y = 0.299 * R + 0.587 * G + 0.114 * B;
          return Y < 128 ? "dark" : "light";
        }
      }
    }
  }

  if (process.platform === "darwin") {
    try {
      const style = execSync("defaults read -g AppleInterfaceStyle", { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
      if (style === "Dark") {
        return "dark";
      }
      return "light";
    } catch (e) {
      return "light";
    }
  }

  return undefined;
}
