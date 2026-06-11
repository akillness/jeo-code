import {
  getStageByIndex,
  renderAsciiArt,
  stageHeight,
  stageWidth,
  stageCaption,
  animateAsciiArt,
  animateFrames,
} from "../tui/components/ascii-art";
import {
  EVOLUTION_STAGE_COUNT,
  EVOLUTION_STAGE_NAMES,
  EVOLUTION_STAGE_TIPS,
  evolutionTrack,
  stageIndexForStep,
  stageProgressRatio,
  transitionMessage,
} from "../tui/components/evolution";
import { meter } from "../tui/components/meter";
import { centerBlock, padLineTo } from "../tui/components/layout";
import { detectColorLevel, ColorLevel } from "../tui/components/color";
import { supportsUnicode } from "../tui/components/capability";
import { getTheme, listThemes, themeGradient } from "../tui/components/themes";
import { size, isTTY } from "../tui/terminal";

export interface EvolveOptions {
  write?: (s: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

interface EvolveFlags {
  color: boolean;
  animate: boolean;
  step?: number;
  max: number;
  ascii: boolean;
  gradient: boolean;
  theme: string;
  listThemes: boolean;
  list: boolean;
  json: boolean;
  loop: number;
  width?: number;
  fit: boolean;
}

function parseFlags(args: string[]): EvolveFlags {
  const flags: EvolveFlags = {
    color: true,
    animate: false,
    max: 25,
    ascii: false,
    gradient: false,
    theme: "cosmic",
    listThemes: false,
    list: false,
    json: false,
    loop: 0,
    fit: false,
  };
  const intArg = (inline: string | undefined, next: string | undefined): { v: number; consumed: boolean } => {
    if (inline !== undefined) return { v: parseInt(inline, 10), consumed: false };
    return { v: parseInt(next ?? "", 10), consumed: true };
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--no-color") flags.color = false;
    else if (a === "--animate") flags.animate = true;
    else if (a === "--ascii") flags.ascii = true;
    else if (a === "--gradient") flags.gradient = true;
    else if (a === "--fit") flags.fit = true;
    else if (a === "--list-themes") flags.listThemes = true;
    else if (a === "--list") flags.list = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--theme") flags.theme = args[++i] ?? flags.theme;
    else if (a.startsWith("--theme=")) flags.theme = a.slice(8);
    else if (a === "--step" || a.startsWith("--step=")) {
      const { v, consumed } = intArg(a.startsWith("--step=") ? a.slice(7) : undefined, args[i + 1]);
      if (Number.isFinite(v)) flags.step = v;
      if (consumed) i++;
    } else if (a === "--max" || a.startsWith("--max=")) {
      const { v, consumed } = intArg(a.startsWith("--max=") ? a.slice(6) : undefined, args[i + 1]);
      if (Number.isFinite(v) && v > 0) flags.max = v;
      if (consumed) i++;
    } else if (a === "--width" || a.startsWith("--width=")) {
      const { v, consumed } = intArg(a.startsWith("--width=") ? a.slice(8) : undefined, args[i + 1]);
      if (Number.isFinite(v) && v > 0) flags.width = v;
      if (consumed) i++;
    } else if (a === "--loop" || a.startsWith("--loop=")) {
      const { v, consumed } = intArg(a.startsWith("--loop=") ? a.slice(7) : undefined, args[i + 1]);
      flags.loop = Number.isFinite(v) && v > 0 ? v : 3;
      // `--loop` with no following integer keeps the default and does not consume.
      if (consumed && !Number.isFinite(v)) {
        /* no numeric arg followed */
      } else if (consumed) i++;
    }
  }
  return flags;
}

/** The canonical stage model as a plain object (for `--json` tooling). */
function stageModelJson() {
  return {
    stageCount: EVOLUTION_STAGE_COUNT,
    stages: Array.from({ length: EVOLUTION_STAGE_COUNT }, (_, i) => ({
      index: i,
      name: EVOLUTION_STAGE_NAMES[i],
      caption: stageCaption(getStageByIndex(i)),
      tip: EVOLUTION_STAGE_TIPS[i],
      transition: transitionMessage(i),
    })),
    themes: listThemes(),
  };
}

/**
 * Preview the joc "evolution" TUI identity: render the five stages (or one stage
 * for a given step) with art, evolution track, and a stage meter. Supports
 * theming, truecolor gradients, ASCII-only fallback, terminal-width fitting,
 * frame-loop animation, and machine-readable `--json` / `--list` output.
 */
export async function runEvolveCommand(args: string[], opts: EvolveOptions = {}): Promise<void> {
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  const flags = parseFlags(args);
  const line = (s = "") => write(s + "\n");

  if (flags.json) {
    line(JSON.stringify(stageModelJson(), null, 2));
    return;
  }

  if (flags.listThemes) {
    line("Evolution TUI themes:");
    for (const t of listThemes()) line(`  ${t.name.padEnd(8)} ${t.description}`);
    return;
  }

  const unicode = !flags.ascii && supportsUnicode();
  const theme = getTheme(flags.theme);
  const useColor = flags.color && theme.color;

  if (flags.list) {
    for (let i = 0; i < EVOLUTION_STAGE_COUNT; i++) {
      const track = evolutionTrack(i, { color: useColor, unicode });
      line(`${track} — ${EVOLUTION_STAGE_TIPS[i]}`);
    }
    return;
  }

  const cols = size().cols;
  const fitWidth = flags.fit || isTTY();
  const colorLevel = useColor ? detectColorLevel(process.env, isTTY()) : ColorLevel.None;
  const gradientOn = flags.gradient && useColor && colorLevel !== ColorLevel.None;
  const artWidth = flags.width ?? stageWidth();

  const renderOne = async (index: number, ratio?: number) => {
    const stage = getStageByIndex(index);
    const header = `── Stage ${index + 1}/${EVOLUTION_STAGE_COUNT}: ${stage.name} ──`;
    line(fitWidth ? padLineTo(header, cols, "center") : header);

    const renderOpts = {
      color: useColor,
      width: artWidth,
      height: stageHeight(),
      ...(gradientOn ? { gradient: themeGradient(theme, index), colorLevel } : {}),
    };

    if (flags.loop > 0) {
      await animateFrames(stage, { ...renderOpts, frames: flags.loop, write, sleep: opts.sleep, frameDelayMs: opts.sleep ? 0 : 120 });
    } else if (flags.animate) {
      await animateAsciiArt(stage, { ...renderOpts, write, sleep: opts.sleep, delayMs: opts.sleep ? 0 : 60 });
    } else {
      const art = renderAsciiArt(stage, renderOpts);
      for (const l of fitWidth ? centerBlock(art, cols) : art) line(l);
    }

    const track = evolutionTrack(index, { color: useColor, unicode, ratio });
    line(fitWidth ? padLineTo(track, cols, "center") : track);
    const meterRatio = EVOLUTION_STAGE_COUNT > 1 ? index / (EVOLUTION_STAGE_COUNT - 1) : 1;
    const bar = meter(meterRatio, 1, 20, { unicode });
    line(fitWidth ? padLineTo(bar, cols, "center") : bar);
    line();
  };

  if (flags.step !== undefined) {
    const idx = stageIndexForStep(flags.step, flags.max);
    await renderOne(idx, stageProgressRatio(flags.step, flags.max));
    return;
  }
  for (let i = 0; i < EVOLUTION_STAGE_COUNT; i++) await renderOne(i);
}
