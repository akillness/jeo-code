import { test, expect } from "bun:test";

import { JobRegistry } from "../src/agent/job-registry";
import { runJobsSlash } from "../src/commands/launch/jobs-slash";

function capture() {
  const lines: string[] = [];
  return { lines, log: (next: string[]) => lines.push(...next) };
}

test("/jobs lists and awaits jobs through the existing registry", async () => {
  const registry = new JobRegistry();
  const list = capture();
  await runJobsSlash("/jobs", registry, process.cwd(), list.log);
  expect(list.lines.join("\n")).toContain("No background jobs");

  const job = registry.start("printf jobs-slash-ok", process.cwd());
  const awaited = capture();
  await runJobsSlash(`/jobs await ${job.id}`, registry, process.cwd(), awaited.log);
  expect(awaited.lines.join("\n")).toContain("all settled");
  expect(awaited.lines.join("\n")).toContain("JOBS-SLASH-OK".toLowerCase());
});

test("/jobs reports unknown actions and rejects malformed timeout options", async () => {
  const registry = new JobRegistry();
  const unknown = capture();
  await runJobsSlash("/jobs nope", registry, process.cwd(), unknown.log);
  expect(unknown.lines.join("\n")).toContain("Unknown /jobs action");

  const badTimeout = capture();
  await runJobsSlash("/jobs await --timeout-ms nope", registry, process.cwd(), badTimeout.log);
  expect(badTimeout.lines.join("\n")).toContain("Invalid timeout");
});
