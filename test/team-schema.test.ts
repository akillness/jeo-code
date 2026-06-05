import { test, expect } from "bun:test";
import { parseYaml, PlanSchema } from "../src/commands/team";

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

test("parseYaml & PlanSchema: rejects plan missing top-level name", () => {
  const invalidYaml = `
steps:
  - name: "Task 1"
`;
  const parsed = parseYaml(invalidYaml);
  const result = PlanSchema.safeParse(parsed);
  expect(result.success).toBe(false);
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
