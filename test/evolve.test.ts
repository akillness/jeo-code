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
