import { test, expect } from "bun:test";
import { parseYaml, PlanSchema, normalizePlanShape } from "../src/agent/plan";

test("parseYaml & PlanSchema: validates a well-formed YAML plan", () => {
  const validYaml = `
name: "Test Implementation Plan"
steps:
  - name: "Task 1: Setup database connection"
    description: "Initialize prisma or connection pool"
  - name: "Task 2: Implement authentication endpoints"
    files:
      - src/auth.ts
  - name: "Task 3: Review the implementation"
    role: critic
`;
  const parsed = parseYaml(validYaml);
  const result = PlanSchema.safeParse(parsed);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.name).toBe("Test Implementation Plan");
    expect(result.data.steps).toHaveLength(3);
    expect(result.data.steps[0].name).toBe("Task 1: Setup database connection");
    expect(result.data.steps[1].name).toBe("Task 2: Implement authentication endpoints");
  }
});

test("parseYaml & PlanSchema: accepts a plan with steps but no top-level name (name is optional)", () => {
  // Real planning models often omit a top-level name; the steps list is what matters.
  const yaml = `
steps:
  - name: "Task 1"
    role: critic
`;
  const parsed = parseYaml(yaml);
  const result = PlanSchema.safeParse(parsed);
  expect(result.success).toBe(true);
});

test("parseYaml & PlanSchema: rejects plan with non-string top-level name", () => {
  const invalidYaml = `
name: 12345
steps:
  - name: "Task 1"
`;
  const parsed = parseYaml(invalidYaml);
  const result = PlanSchema.safeParse(parsed);
  expect(result.success).toBe(false);
});

test("parseYaml & PlanSchema: rejects plan missing steps key", () => {
  const invalidYaml = `
name: "Only Name Plan"
`;
  const parsed = parseYaml(invalidYaml);
  const result = PlanSchema.safeParse(parsed);
  expect(result.success).toBe(false);
});

test("parseYaml & PlanSchema: rejects steps that do not have a name", () => {
  const invalidYaml = `
name: "No Step Name Plan"
steps:
  - description: "Missing name property"
`;
  const parsed = parseYaml(invalidYaml);
  const result = PlanSchema.safeParse(parsed);
  expect(result.success).toBe(false);
});

test("parseYaml & PlanSchema: rejects steps where name is not a string", () => {
  const invalidYaml = `
name: "Invalid Step Name Type Plan"
steps:
  - name: 456
`;
  const parsed = parseYaml(invalidYaml);
  const result = PlanSchema.safeParse(parsed);
  expect(result.success).toBe(false);
});

test("parseYaml: throws error on malformed/invalid YAML structure", () => {
  const malformedYaml = `
name: "Malformed Plan"
invalid line here without colon
`;
  expect(() => parseYaml(malformedYaml)).toThrow();
});

test("normalizePlanShape: tolerates common plan deviations so a valid-enough plan executes", () => {
  // top-level list of tasks
  expect(PlanSchema.safeParse(normalizePlanShape([{ name: "a" }, { name: "b" }, { name: "review", role: "critic" }])).success).toBe(true);
  // `tasks:` alias for `steps:`
  expect(PlanSchema.safeParse(normalizePlanShape({ tasks: [{ name: "a" }, { name: "review", role: "critic" }] })).success).toBe(true);
  // bare-string tasks
  expect(PlanSchema.safeParse(normalizePlanShape({ steps: ["do a", "do b", { name: "review", role: "critic" }] })).success).toBe(true);
  // step name under an alias key
  const norm = normalizePlanShape({ steps: [{ description: "implement reverse" }, { name: "review", role: "critic" }] });
  expect(PlanSchema.safeParse(norm).success).toBe(true);
  expect(norm.steps[0].name).toBe("implement reverse");
});

test("PlanSchema: rejects dependency-shaped step keys the serial executor cannot honor", () => {
  // round-10 LOW: `jeo team` runs steps in array order; a plan that DECLARES
  // ordering constraints must fail loudly instead of silently pretending
  // they are enforced.
  const yaml = `
steps:
  - name: "Task A"
  - name: "Task B"
    depends_on: "Task A"
`;
  const result = PlanSchema.safeParse(parseYaml(yaml));
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.some(i => i.message.includes("array order"))).toBe(true);
  }
  // Unknown NON-dependency keys remain tolerated (passthrough unchanged).
  const ok = PlanSchema.safeParse(parseYaml(`
steps:
  - name: "Task A"
    files:
      - src/x.ts
  - name: "Task B: review"
    role: critic
`));
  expect(ok.success).toBe(true);
});

// --- Maker -> verifier ORDERING (v0.8.24): a plan containing mutating work
// must have a DEDICATED architect/critic step AFTER the last such mutation.
// The prior fixture repairs (team-run/team-parallel/ralplan-*/approve*/
// workflow-integrity) only proved plans WITH a trailing verifier stay valid —
// none of them asserted the REJECT direction. This block closes that gap:
// every meaningful boundary of the rule, directly against PlanSchema. ---

test("PlanSchema ordering: rejects a plan ending with an unverified mutating step", () => {
  const result = PlanSchema.safeParse(parseYaml('steps:\n  - name: "Build it"\n    role: executor\n'));
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.some(i => i.message.includes("unverified mutation") && i.message.includes("Build it"))).toBe(true);
  }
});

test("PlanSchema ordering: accepts the SAME plan once a trailing critic/architect step follows the mutation", () => {
  const critic = PlanSchema.safeParse(parseYaml('steps:\n  - name: "Build it"\n    role: executor\n  - name: "verify"\n    role: critic\n'));
  expect(critic.success).toBe(true);
  const architect = PlanSchema.safeParse(parseYaml('steps:\n  - name: "Build it"\n    role: executor\n  - name: "verify"\n    role: architect\n'));
  expect(architect.success).toBe(true);
});

test("PlanSchema ordering: a read-only-only plan (no mutating step at all) needs no verifier — nothing to verify", () => {
  const result = PlanSchema.safeParse(parseYaml('steps:\n  - name: "sequence the work"\n    role: planner\n  - name: "review the design"\n    role: architect\n'));
  expect(result.success).toBe(true);
});

test("PlanSchema ordering: a verifier placed BEFORE the mutation it should check does NOT satisfy the rule", () => {
  // The verifier ran against a plan that hadn't mutated anything yet — its
  // verdict cannot possibly cover the LATER change.
  const result = PlanSchema.safeParse(parseYaml('steps:\n  - name: "review the plan"\n    role: critic\n  - name: "Build it"\n    role: executor\n'));
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.some(i => i.message.includes("unverified mutation") && i.message.includes("Build it"))).toBe(true);
  }
});

test("PlanSchema ordering: only the LAST unverified mutation matters — an earlier mutation covered by an earlier verifier does not force a SECOND one", () => {
  const result = PlanSchema.safeParse(parseYaml(
    'steps:\n' +
    '  - name: "first change"\n    role: executor\n' +
    '  - name: "check first change"\n    role: critic\n' +
    '  - name: "second change"\n    role: executor\n' +
    '  - name: "check second change"\n    role: architect\n',
  ));
  expect(result.success).toBe(true);
});

test("PlanSchema ordering: a step with NO role (or an unknown non-readonly role) defaults to mutating, same as an explicit 'executor'", () => {
  const noRole = PlanSchema.safeParse(parseYaml('steps:\n  - name: "Build it"\n'));
  expect(noRole.success).toBe(false);
  const unknownRole = PlanSchema.safeParse(parseYaml('steps:\n  - name: "Build it"\n    role: developer\n'));
  expect(unknownRole.success).toBe(false);
  // Both fixed the same way — a trailing critic step.
  const fixed = PlanSchema.safeParse(parseYaml('steps:\n  - name: "Build it"\n    role: developer\n  - name: "verify"\n    role: critic\n'));
  expect(fixed.success).toBe(true);
});

test("PlanSchema ordering: a critic INSIDE the same parallel_group as a mutating sibling does NOT clear the gate (concurrent, cannot see the still-in-flight change)", () => {
  const result = PlanSchema.safeParse(parseYaml(
    'steps:\n' +
    '  - name: "mutate"\n    role: executor\n    parallel_group: g1\n' +
    '  - name: "verify"\n    role: critic\n    parallel_group: g1\n',
  ));
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.some(i => i.message.includes("unverified mutation"))).toBe(true);
  }
});

test("PlanSchema ordering: a critic in a SEPARATE step AFTER the parallel_group DOES clear the gate for the whole group", () => {
  const result = PlanSchema.safeParse(parseYaml(
    'steps:\n' +
    '  - name: "mutate a"\n    role: executor\n    parallel_group: g1\n' +
    '  - name: "mutate b"\n    role: executor\n    parallel_group: g1\n' +
    '  - name: "verify both"\n    role: critic\n',
  ));
  expect(result.success).toBe(true);
});
