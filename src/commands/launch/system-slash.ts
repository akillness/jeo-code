/**
 * System/meta slash handlers (`/theme`, `/config` + `/settings`, `/evolve`)
 * extracted from launch.ts.
 *
 * These commands used to have two byte-identical implementations in
 * launch.ts — one in the one-shot control-command block, one in the
 * interactive REPL loop — which is exactly the kind of drift that lets a fix
 * to one copy silently miss the other. Following the `decideWikiSlash`
 * pattern (see wiki-slash.ts), the decision/formatting logic lives here as
 * pure (or narrowly side-effecting) functions; each launch.ts call site just
 * applies the persistence/live-repaint side effects appropriate to its mode.
 */

import { readGlobalConfig } from "../../agent/state";
import { describeModel } from "../../ai";
import { formatConfigPanel } from "../../tui/components/config-panel";
import { EVOLUTION_STAGES } from "../../tui/components/ascii-art";

/** Outcome of parsing a `/theme [name]` command line. `lines` are printed verbatim. */
export interface ThemeDecision {
  kind: "list" | "unknown" | "set";
  lines: string[];
  themeName?: string; // present when kind === "set"
}

/**
 * Decide what `/theme [name]` should print/do, given the known themes and
 * active name. Pure — callers apply the persistence + optional live-repaint
 * side effects based on `kind`.
 */
export function decideThemeSlash(
  cmd: string,
  themes: readonly { name: string; description: string }[],
  activeName: string,
): ThemeDecision {
  const want = cmd.substring(6).trim().toLowerCase();
  if (!want) {
    const lines = ["TUI themes (set with /theme <name>, persists via ~/.jeo/config.json):"];
    for (const t of themes) lines.push(`  ${t.name === activeName ? "*" : " "} ${t.name.padEnd(10)} ${t.description}`);
    return { kind: "list", lines };
  }
  if (!themes.some(t => t.name === want)) {
    return { kind: "unknown", lines: [`Unknown theme '${want}'. Known: ${themes.map(t => t.name).join(", ")}.`] };
  }
  return { kind: "set", lines: [`Theme set to ${want} — saved to ~/.jeo/config.json`], themeName: want };
}

/** Build the `/config` (+ `/settings`) panel lines. Read-only, no side effects. */
export async function buildConfigPanelLines(opts: {
  sessionModel?: string;
  sessionThinking?: string;
  sessionId?: string;
}): Promise<string[]> {
  const cfgNow = await readGlobalConfig();
  const label = opts.sessionModel || cfgNow.defaultModel;
  const { resolved, provider } = await describeModel(label);
  const lines = ["Effective runtime config:"];
  for (const line of formatConfigPanel({
    model: label,
    resolved,
    provider,
    thinkingLevel: opts.sessionThinking ?? cfgNow.thinkingLevel ?? "medium",
    ollamaBaseUrl: cfgNow.ollamaBaseUrl,
    openaiBaseUrl: cfgNow.openaiBaseUrl,
    requestMaxRetries: cfgNow.retry?.requestMaxRetries,
    sessionId: opts.sessionId,
  })) lines.push(line);
  return lines;
}

/** Run the `/evolve` ascii-art animation sequence. */
export async function runEvolveSimulation(
  animateAsciiArt: (stage: (typeof EVOLUTION_STAGES)[number], opts: { delayMs: number }) => Promise<void>,
): Promise<void> {
  console.log("=== Initiating Evolutionary Simulation ===");
  for (const stage of EVOLUTION_STAGES) {
    console.log(`\nStage: ${stage.name}`);
    await animateAsciiArt(stage, { delayMs: 40 });
  }
  console.log("\n=== Evolved to Singularity! ===");
}
