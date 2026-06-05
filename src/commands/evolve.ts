import {
  EVOLUTION_STAGES,
  getStageByIndex,
  renderAsciiArt,
  stageHeight,
  animateAsciiArt,
} from "../tui/components/ascii-art";
import {
  EVOLUTION_STAGE_COUNT,
  evolutionTrack,
  stageIndexForStep,
} from "../tui/components/evolution";
import { meter } from "../tui/components/meter";

export interface EvolveOptions {
  write?: (s: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

interface EvolveFlags {
  color: boolean;
  animate: boolean;
  step?: number;
  max: number;
}

function parseFlags(args: string[]): EvolveFlags {
  const flags: EvolveFlags = { color: true, animate: false, max: 25 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--no-color") flags.color = false;
    else if (a === "--animate") flags.animate = true;
    else if (a === "--step") {
      const n = parseInt(args[++i] ?? "", 10);
      if (Number.isFinite(n)) flags.step = n;
    } else if (a.startsWith("--step=")) {
      const n = parseInt(a.slice(7), 10);
      if (Number.isFinite(n)) flags.step = n;
    } else if (a === "--max") {
      const n = parseInt(args[++i] ?? "", 10);
      if (Number.isFinite(n) && n > 0) flags.max = n;
    } else if (a.startsWith("--max=")) {
      const n = parseInt(a.slice(6), 10);
      if (Number.isFinite(n) && n > 0) flags.max = n;
    }
  }
  return flags;
}

/**
 * Preview the joc "evolution" TUI identity: render the five stages (or one stage
 * for a given step) with art, evolution track, and a stage meter. A bounded,
 * cheap way to see the theme without launching an agent turn.
 */
export async function runEvolveCommand(args: string[], opts: EvolveOptions = {}): Promise<void> {
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  const flags = parseFlags(args);
  const line = (s = "") => write(s + "\n");

  const renderOne = async (index: number) => {
    const stage = getStageByIndex(index);
    const ratio = EVOLUTION_STAGE_COUNT > 1 ? index / (EVOLUTION_STAGE_COUNT - 1) : 1;
    line(`── Stage ${index + 1}/${EVOLUTION_STAGE_COUNT}: ${stage.name} ──`);
    if (flags.animate) {
      await animateAsciiArt(stage, { color: flags.color, write, height: stageHeight() });
    } else {
      for (const l of renderAsciiArt(stage, { color: flags.color, height: stageHeight() })) line(l);
    }
    line(evolutionTrack(index, { color: flags.color }));
    line(meter(ratio));
    line();
  };

  if (flags.step !== undefined) {
    await renderOne(stageIndexForStep(flags.step, flags.max));
    return;
  }
  for (let i = 0; i < EVOLUTION_STAGE_COUNT; i++) await renderOne(i);
}
