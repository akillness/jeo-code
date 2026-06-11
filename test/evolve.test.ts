import { test, expect } from "bun:test";
import { runEvolveCommand } from "../src/commands/evolve";
import { EVOLUTION_STAGE_NAMES } from "../src/tui/components/evolution";
import { findCommand } from "../src/cli/runner";

test("evolve is a registered command", () => {
  expect(findCommand("evolve")).toBeDefined();
});

test("joc evolve (default) renders all five stages", async () => {
  const out: string[] = [];
  await runEvolveCommand(["--no-color"], { write: s => out.push(s) });
  const text = out.join("");
  for (const name of EVOLUTION_STAGE_NAMES) expect(text).toContain(name);
  expect(text).toContain("Stage 1/5");
  expect(text).toContain("Stage 5/5");
});

test("joc evolve --no-color emits no ANSI escapes", async () => {
  const out: string[] = [];
  await runEvolveCommand(["--no-color"], { write: s => out.push(s) });
  expect(out.join("").includes("\u001b[")).toBe(false);
});

test("joc evolve --step selects a single stage by step/max", async () => {
  const out: string[] = [];
  await runEvolveCommand(["--no-color", "--step", "100", "--max", "100"], { write: s => out.push(s) });
  const text = out.join("");
  expect(text).toContain("Super intelligence (Singularity)");
  expect(text).toContain("Stage 5/5");
  // only one stage header present
  expect((text.match(/── Stage /g) || []).length).toBe(1);
});

test("joc evolve --animate streams the stage without real delay", async () => {
  const out: string[] = [];
  await runEvolveCommand(["--no-color", "--animate", "--step", "0", "--max", "25"], {
    write: s => out.push(s),
    sleep: async () => {},
  });
  expect(out.join("")).toContain("Primordial Cell");
});

test("joc evolve --json emits the canonical stage model", async () => {
  const out: string[] = [];
  await runEvolveCommand(["--json"], { write: s => out.push(s) });
  const model = JSON.parse(out.join(""));
  expect(model.stageCount).toBe(5);
  expect(model.stages.length).toBe(5);
  expect(model.stages[0].name).toBe("Primordial Cell");
  expect(model.stages[0]).toHaveProperty("tip");
  expect(model.stages[0]).toHaveProperty("transition");
  expect(model.themes.map((t: { name: string }) => t.name)).toContain("matrix");
});

test("joc evolve --list-themes lists all themes", async () => {
  const out: string[] = [];
  await runEvolveCommand(["--list-themes"], { write: s => out.push(s) });
  const text = out.join("");
  for (const name of ["cosmic", "matrix", "solar", "mono"]) expect(text).toContain(name);
});

test("joc evolve --list prints one track line per stage", async () => {
  const out: string[] = [];
  await runEvolveCommand(["--list", "--no-color"], { write: s => out.push(s) });
  const lines = out.join("").trimEnd().split("\n");
  expect(lines.length).toBe(5);
  for (const name of EVOLUTION_STAGE_NAMES) expect(out.join("")).toContain(name);
});

test("joc evolve --ascii --no-color emits no unicode and no ANSI", async () => {
  const out: string[] = [];
  await runEvolveCommand(["--ascii", "--no-color", "--step", "100", "--max", "100"], { write: s => out.push(s) });
  const text = out.join("");
  expect(text.includes("\u001b[")).toBe(false);
  expect(/[^\x00-\x7f]/.test(text.replace(/[─—]/g, ""))).toBe(false); // header dashes excluded
});

test("joc evolve --gradient (theme matrix) paints truecolor when forced", async () => {
  const out: string[] = [];
  const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR, COLORTERM: process.env.COLORTERM, TERM: process.env.TERM };
  delete process.env.NO_COLOR;
  delete process.env.FORCE_COLOR;
  delete process.env.TERM;
  process.env.COLORTERM = "truecolor";
  try {
    await runEvolveCommand(["--gradient", "--theme", "matrix", "--step", "100", "--max", "100"], { write: s => out.push(s) });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  expect(out.join("")).toContain("\u001b[38;2;"); // truecolor escapes present
});

test("joc evolve --loop animates frames with injected sleep (no real delay)", async () => {
  const out: string[] = [];
  let sleeps = 0;
  await runEvolveCommand(["--loop", "3", "--no-color", "--step", "5", "--max", "25"], {
    write: s => out.push(s),
    sleep: async () => {
      sleeps++;
    },
  });
  // DNA stage (step 5/25) has 3 frames; --loop 3 draws 3 frames.
  expect(out.join("")).toContain("Double Helix");
  expect(sleeps).toBe(0); // frameDelayMs forced to 0 when sleep injected
});
