import { test, expect, mock, afterAll } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { yamlList, parseSeedAcceptanceCriteria, parseSeedList, parseCriterion } from "../src/agent/seed";
import { writeWorkflowState } from "../src/agent/state";

// Round-12 (architect ref 8-Round10Planning #5): the seed writer and ultragoal's
// reader share ONE module + ONE encoding. Criteria with embedded quotes, colons,
// and backslashes must round-trip exactly — the old reader stripped every double
// quote and mangled them silently into the verification ledger.

const realTools = { ...(await import("../src/agent/tools")) };
afterAll(() => {
  mock.module("../src/agent/tools", () => realTools);
});

test("yamlList → parseSeedAcceptanceCriteria round-trips hostile values exactly", () => {
  const criteria = [
    'Display "Done" message after save',
    "Supports key: value pairs in config",
    "Handles C:\\Users\\path style input",
    "한국어 기준도 정확히 보존된다",
    "Trailing - dash - items survive",
  ];
  const doc = `# seed\ngoal: "x"\n${yamlList("constraints", [])}\n\n${yamlList("acceptance_criteria", criteria)}\n`;
  expect(parseSeedAcceptanceCriteria(doc)).toEqual(criteria);
});

test("legacy unquoted/hand-written items still parse; interior quotes preserved", () => {
  const doc = [
    "acceptance_criteria:",
    "  - plain unquoted item",
    '  - "outer quotes stripped"',
    '  - has "interior" quotes unquoted',
    "",
    "next_section:",
    "  - not a criterion",
  ].join("\n");
  expect(parseSeedAcceptanceCriteria(doc)).toEqual([
    "plain unquoted item",
    "outer quotes stripped",
    'has "interior" quotes unquoted',
  ]);
});

test("parseSeedList: section headers end the list; other lists are not leaked", () => {
  const doc = `constraints:\n  - "only constraint"\nacceptance_criteria:\n  - "only criterion"\n`;
  expect(parseSeedList(doc, "constraints")).toEqual(["only constraint"]);
  expect(parseSeedAcceptanceCriteria(doc)).toEqual(["only criterion"]);
});

test("ultragoal report carries quoted criteria UNMANGLED end to end", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-seedrt-"));
  const seedPath = path.join(dir, "seed.yaml");
  await fs.writeFile(seedPath, `goal: "x"\n${yamlList("acceptance_criteria", ['Display "Done" message after save'])}\n`);
  await writeWorkflowState("deep-interview", {
    active: false,
    current_phase: "complete",
    skill: "deep-interview",
    slug: "rt",
    seed_path: seedPath,
  }, dir);
  await mock.module("../src/agent/tools", () => ({
    ...realTools,
    bashTool: async () => ({ success: true, output: "1 pass" }),
  }));
  const { runUltragoalEngine } = await import("../src/commands/ultragoal");
  const res = await runUltragoalEngine({ cwd: dir, io: { output: () => {} } });
  expect(res.ok).toBe(true);
  const report = await fs.readFile(path.join(dir, ".jeo", "state", "ultragoal-report.md"), "utf-8");
  expect(report).toContain('Display "Done" message after save'); // exact, quotes intact
  expect(report).not.toContain("Display Done message"); // the old mangling
  await fs.rm(dir, { recursive: true, force: true });
});

test("parseCriterion splits a trailing {verify: <cmd>} directive off the criterion text", () => {
  expect(parseCriterion("Typecheck is clean {verify: bun run typecheck}")).toEqual({
    text: "Typecheck is clean",
    verify: "bun run typecheck",
  });
  // No directive → plain text, no verify command.
  expect(parseCriterion("Looks nice")).toEqual({ text: "Looks nice" });
  // Only a trailing directive is a directive; an inner brace stays as text.
  expect(parseCriterion("Render {x} placeholder")).toEqual({ text: "Render {x} placeholder" });
  // An empty directive is ignored (no command to run).
  expect(parseCriterion("Builds {verify:  }")).toEqual({ text: "Builds" });
  // The directive survives a full yamlList → parse round-trip unmangled.
  const raw = 'Build compiles {verify: bun run build && echo "done"}';
  const doc = `${yamlList("acceptance_criteria", [raw])}\n`;
  expect(parseCriterion(parseSeedAcceptanceCriteria(doc)[0]!)).toEqual({
    text: "Build compiles",
    verify: 'bun run build && echo "done"',
  });
});
