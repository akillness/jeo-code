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
`;
  const parsed = parseYaml(validYaml);
  const result = PlanSchema.safeParse(parsed);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.name).toBe("Test Implementation Plan");
    expect(result.data.steps).toHaveLength(2);
    expect(result.data.steps[0].name).toBe("Task 1: Setup database connection");
    expect(result.data.steps[1].name).toBe("Task 2: Implement authentication endpoints");
  }
});

test("parseYaml & PlanSchema: accepts a plan with steps but no top-level name (name is optional)", () => {
  // Real planning models often omit a top-level name; the steps list is what matters.
  const yaml = `
steps:
  - name: "Task 1"
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
  expect(PlanSchema.safeParse(normalizePlanShape([{ name: "a" }, { name: "b" }])).success).toBe(true);
  // `tasks:` alias for `steps:`
  expect(PlanSchema.safeParse(normalizePlanShape({ tasks: [{ name: "a" }] })).success).toBe(true);
  // bare-string tasks
  expect(PlanSchema.safeParse(normalizePlanShape({ steps: ["do a", "do b"] })).success).toBe(true);
  // step name under an alias key
  const norm = normalizePlanShape({ steps: [{ description: "implement reverse" }] });
  expect(PlanSchema.safeParse(norm).success).toBe(true);
  expect(norm.steps[0].name).toBe("implement reverse");
});
