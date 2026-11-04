import { test, expect } from "bun:test";
import { spawnSync } from "child_process";

test("gjc basic response", () => {
  const result = spawnSync("gjc", ["-p", "Hello", "--max-tokens", "5", "--non-interactive", "--no-animation"], {
    encoding: "utf-8",
    timeout: 30000
  });
  console.log("STDOUT:", result.stdout);
  console.log("STDERR:", result.stderr);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Hello");
});
