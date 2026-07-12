import { test, expect } from "bun:test";
import { renderRoutineWorkflow, validateCron, type RoutineConfig } from "../src/util/routine-template";

function baseConfig(overrides: Partial<RoutineConfig> = {}): RoutineConfig {
  return {
    name: "jeo nightly triage",
    trigger: "schedule",
    cron: "0 7 * * *",
    prompt: "triage new issues and label them",
    ...overrides,
  };
}

// --- renderRoutineWorkflow: structural shape per trigger type ---

test("renderRoutineWorkflow: schedule trigger produces a plausible cron block, workflow_dispatch, permissions, and setup steps", () => {
  const yaml = renderRoutineWorkflow(baseConfig());
  expect(yaml).toContain("on:");
  expect(yaml).toContain("  schedule:");
  expect(yaml).toContain("    - cron: '0 7 * * *'");
  expect(yaml).toContain("  workflow_dispatch: {}");
  expect(yaml).toContain("permissions:");
  expect(yaml).toContain("  contents: write");
  expect(yaml).toContain("  pull-requests: write");
  expect(yaml).toContain("uses: actions/checkout@v4");
  expect(yaml).toContain("uses: oven-sh/setup-bun@v2");
  expect(yaml).toContain("run: bun install -g jeo-code");
});

test("renderRoutineWorkflow: issues trigger produces the issues block and workflow_dispatch", () => {
  const yaml = renderRoutineWorkflow(baseConfig({ trigger: "issues", cron: undefined }));
  expect(yaml).toContain("on:");
  expect(yaml).toContain("  issues:");
  expect(yaml).toContain("    types: [opened, labeled]");
  expect(yaml).toContain("  workflow_dispatch: {}");
});

test("renderRoutineWorkflow: pull_request trigger produces the pull_request block and workflow_dispatch", () => {
  const yaml = renderRoutineWorkflow(baseConfig({ trigger: "pull_request", cron: undefined }));
  expect(yaml).toContain("on:");
  expect(yaml).toContain("  pull_request:");
  expect(yaml).toContain("    types: [opened, synchronize]");
  expect(yaml).toContain("  workflow_dispatch: {}");
});

test("renderRoutineWorkflow: openPr true (default) emits the create-pull-request step, not the direct-commit steps", () => {
  const yaml = renderRoutineWorkflow(baseConfig());
  expect(yaml).toContain("uses: peter-evans/create-pull-request@v6");
  expect(yaml).not.toContain("Configure git identity");
  expect(yaml).not.toContain("git push");
});

test("renderRoutineWorkflow: openPr false emits the direct-commit steps, not the create-pull-request step", () => {
  const yaml = renderRoutineWorkflow(baseConfig({ openPr: false }));
  expect(yaml).not.toContain("uses: peter-evans/create-pull-request@v6");
  expect(yaml).toContain("Configure git identity");
  expect(yaml).toContain("git add -A");
  expect(yaml).toContain("git push");
});

// --- renderRoutineWorkflow: schedule + missing cron throws ---

test("renderRoutineWorkflow: throws when trigger is 'schedule' and cron is missing", () => {
  expect(() => renderRoutineWorkflow(baseConfig({ cron: undefined }))).toThrow(/cron is required/);
});

// --- renderRoutineWorkflow: shell-injection-prevention contract for the jeo run step ---

test("renderRoutineWorkflow: the run: line is EXACTLY the fixed jeo invocation, never inlining the prompt, regardless of prompt content (shell-injection-prevention contract)", () => {
  const maliciousPrompt = 'do something normal $(echo INJECTED) `rm -rf /` "quotes" and $VARS';
  const yaml = renderRoutineWorkflow(baseConfig({ prompt: maliciousPrompt }));
  const lines = yaml.split("\n");
  const runLine = lines.find(l => l.includes("$JEO_ROUTINE_PROMPT"));
  expect(runLine).toBe('        run: jeo "$JEO_ROUTINE_PROMPT" -p');
  // The malicious content must never appear on the run: line itself.
  expect(runLine).not.toContain("INJECTED");
  expect(runLine).not.toContain("rm -rf");
  // It DOES appear, but only inside the env: var assignment (inert data to bash).
  const envLine = lines.find(l => l.includes("JEO_ROUTINE_PROMPT:"));
  expect(envLine).toBeDefined();
  expect(envLine).toContain(JSON.stringify(maliciousPrompt));
});

test("renderRoutineWorkflow: the API key secret env var name is used both in the run step's env: block and the workflow's expected secret reference", () => {
  const yaml = renderRoutineWorkflow(baseConfig({ apiKeyEnvVar: "OPENAI_API_KEY" }));
  expect(yaml).toContain("OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");
});

test("renderRoutineWorkflow: apiKeyEnvVar defaults to ANTHROPIC_API_KEY when omitted", () => {
  const yaml = renderRoutineWorkflow(baseConfig({ apiKeyEnvVar: undefined }));
  expect(yaml).toContain("ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}");
});

test("renderRoutineWorkflow: name is single-quoted and internal single quotes are escaped per YAML rules", () => {
  const yaml = renderRoutineWorkflow(baseConfig({ name: "jeo's nightly job" }));
  expect(yaml).toContain("name: 'jeo''s nightly job'");
});

// --- validateCron ---

test("validateCron: accepts a valid 5-field expression", () => {
  expect(validateCron("0 7 * * *")).toBe(true);
  expect(validateCron("15 * * * *")).toBe(true);
  expect(validateCron("0,30 8-17 * * 1-5")).toBe(true);
});

test("validateCron: rejects a 4-field expression (wrong field count)", () => {
  expect(validateCron("0 7 * *")).toBe(false);
});

test("validateCron: rejects a 6-field expression (wrong field count)", () => {
  expect(validateCron("0 7 * * * *")).toBe(false);
});

test("validateCron: rejects non-numeric garbage in a field", () => {
  expect(validateCron("0 7 * * MON")).toBe(false);
  expect(validateCron("banana 7 * * *")).toBe(false);
});
