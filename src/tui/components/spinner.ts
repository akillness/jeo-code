import { EVOLUTION_SPINNER_FRAMES, stageIndexForStep, clampStageIndex } from "./evolution";

/**
 * Stage-aware spinner. Frames evolve with the agent's step against its budget,
 * sourced from the canonical evolution model so the spinner stays in lockstep
 * with the ASCII art, meter, and footer track.
 */
export class Spinner {
  private defaultFrames: string[];
  private frames: string[];
  private index: number = 0;

  constructor(frames?: string[]) {
    // Default to the "AI Coding Agent" stage frames when none are supplied.
    this.defaultFrames = frames || [...EVOLUTION_SPINNER_FRAMES[3]!];
    this.frames = this.defaultFrames;
  }

  /** Switch frame set to the stage matching `step`/`maxSteps`. */
  updateStep(step: number, maxSteps: number = 25): void {
    const idx = stageIndexForStep(step, maxSteps);
    this.setStage(idx);
  }

  /** Switch frame set to an explicit stage index (clamped). */
  setStage(stageIndex: number): void {
    this.frames = [...EVOLUTION_SPINNER_FRAMES[clampStageIndex(stageIndex)]!];
    // Keep the animation phase valid when the frame count shrinks.
    this.index = this.frames.length ? this.index % this.frames.length : 0;
  }

  /** Reset to the default frame set and phase. */
  reset(): void {
    this.frames = this.defaultFrames;
    this.index = 0;
  }

  next(): string {
    const frame = this.frames[this.index]!;
    this.index = (this.index + 1) % this.frames.length;
    return frame;
  }

  current(): string {
    return this.frames[this.index]!;
  }
}
