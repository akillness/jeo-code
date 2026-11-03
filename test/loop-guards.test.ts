import { test, expect } from "bun:test";
import {
  VERIFY_SIGNAL_RE,
  isVerificationSignal,
  repeatHint,
  classifyDoneGate,
} from "../src/agent/loop-guards";
import { verificationProducedEvidence } from "../src/agent/loop-guards";


test("isVerificationSignal only accepts explicit supported verification commands", () => {
  for (const command of ["bun test", "bun test test/foo.test.ts", "bun run typecheck", "tsc --noEmit", "cargo test", "npm run build", "eslint ."]) {
    expect(isVerificationSignal(command)).toBe(true);
  }
  for (const command of [
    "ls -la",
    "git status",
    "cat test.log",
    "./run.sh",
    "bun test\ntouch marker",
  ]) {
    expect(isVerificationSignal(command)).toBe(false);
  }
});

test("targeted pytest and cargo selectors are verification, not mutating scripts", () => {
  for (const command of [
    "pytest tests/test_users.py::test_update_profile",
    "pytest tests/test_io.py::TestWriter::test_write_file",
    "cargo test config::write_defaults",
  ]) expect(isVerificationSignal(command)).toBe(true);
  expect(isVerificationSignal("npm run test:fix")).toBe(false);
});

test("isVerificationSignal rejects bun test help mode", () => {
  expect(isVerificationSignal("bun test --help")).toBe(false);
});

test("isVerificationSignal rejects tsc version mode", () => {
  expect(isVerificationSignal("tsc --version")).toBe(false);
});

test("isVerificationSignal rejects bun test collection-only mode", () => {
  expect(isVerificationSignal("bun test --list")).toBe(false);
});

test("isVerificationSignal rejects Jest passWithNoTests mode", () => {
  expect(isVerificationSignal("jest missing.test.ts --passWithNoTests")).toBe(false);
});

test("isVerificationSignal rejects cargo compile-only test modes", () => {
  for (const command of ["cargo test --no-run", "cargo test -- --no-run"]) {
    expect(isVerificationSignal(command)).toBe(false);
  }
});

test("isVerificationSignal accepts Go test -run filters as executing verification", () => {
  for (const command of [
    "go test -run=NoSuchTestName ./...",
    "go test -run NoSuchTestName ./...",
  ]) {
    expect(isVerificationSignal(command)).toBe(true);
  }
  expect(isVerificationSignal("go test ./...")).toBe(true);
});

test("isVerificationSignal accepts Jest and Vitest --run execution modes", () => {
  for (const command of ["jest --run", "vitest --run"]) {
    expect(isVerificationSignal(command)).toBe(true);
  }
});
test("isVerificationSignal rejects mutating flags while accepting read-only forms", () => {
  const cases = [
    { readOnly: "bun test", mutating: "bun test --fix" },
    { readOnly: "npm run lint", mutating: "npm run lint --write" },
    { readOnly: "pnpm exec eslint .", mutating: "pnpm exec eslint . --fix" },
    { readOnly: "yarn test", mutating: "yarn test --update" },
    { readOnly: "npx vitest --run", mutating: "npx vitest -u" },
    { readOnly: "tsc --noEmit", mutating: "tsc --noEmit --update" },
    { readOnly: "cargo test", mutating: "cargo test --fix" },
    { readOnly: "go test ./...", mutating: "go test -u ./..." },
    { readOnly: "make check", mutating: "make check --write" },
  ];

  for (const { readOnly, mutating } of cases) {
    expect(isVerificationSignal(readOnly)).toBe(true);
    expect(isVerificationSignal(mutating)).toBe(false);
  }
});



test("VERIFY_SIGNAL_RE is the regex backing isVerificationSignal", () => {
  expect(VERIFY_SIGNAL_RE.test("bun test")).toBe(true);
  expect(VERIFY_SIGNAL_RE.test("run the spec")).toBe(false);
});

test("repeatHint tailors guidance to the repeated tool", () => {
  expect(repeatHint("search", { success: true, output: "no match" })).toContain("BROADEN");
  expect(repeatHint("search", { success: true, output: "src/a.ts:1: hit" })).toContain("already returned results");
  expect(repeatHint("read")).toContain("read a DIFFERENT file");
  expect(repeatHint("bash")).toContain("change the command");
  expect(repeatHint("edit")).toContain("take a different action");
});

test("repeatHint prepends a reflection directive when the previous attempt FAILED", () => {
  // A failed bash retry: keep the per-tool base, but lead with the reflect-and-change directive.
  const failed = repeatHint("bash", { success: false, output: "error: command not found" });
  expect(failed).toContain("The previous attempt FAILED");
  expect(failed).toContain("change the tool or its arguments");
  expect(failed).toContain("change the command"); // base hint still present
  // A successful repeat (results unchanged, not a failure) gets NO reflection prefix.
  const ok = repeatHint("bash", { success: true, output: "done" });
  expect(ok).not.toContain("The previous attempt FAILED");
  // Missing prev (no recorded result) is not treated as a failure.
  expect(repeatHint("edit")).not.toContain("The previous attempt FAILED");
});

test("classifyDoneGate: no mutation → accept", () => {
  const v = classifyDoneGate({ sawMutation: false, sawVerification: false, pendingHookFailure: null });
  expect(v.state).toBe("done_ok");
  expect(v.block).toBe(false);
  expect(v.message).toBe("");
});

test("classifyDoneGate: mutation + verification + clean hook → accept", () => {
  const v = classifyDoneGate({ sawMutation: true, sawVerification: true, pendingHookFailure: null });
  expect(v.state).toBe("done_ok");
  expect(v.block).toBe(false);
});

test("classifyDoneGate: mutation without verification → block (unverified)", () => {
  const v = classifyDoneGate({ sawMutation: true, sawVerification: false, pendingHookFailure: null });
  expect(v.state).toBe("done_unverified");
  expect(v.block).toBe(true);
  expect(v.message).toContain("no passing verification");
});

test("classifyDoneGate: failing post-turn hook outranks verification → block (hook)", () => {
  const v = classifyDoneGate({ sawMutation: true, sawVerification: true, pendingHookFailure: "bun test" });
  expect(v.state).toBe("done_hook_failing");
  expect(v.block).toBe(true);
  expect(v.message).toContain('post-turn hook "bun test" FAILING');
});

test("classifyDoneGate: verified then mutated again → block (stale verification)", () => {
  const v = classifyDoneGate({
    sawMutation: true,
    sawVerification: true,
    verificationStale: true,
    pendingHookFailure: null,
  });
  expect(v.state).toBe("done_stale_verification");
  expect(v.block).toBe(true);
  expect(v.message).toContain("no longer reflects the current tree");
});

test("classifyDoneGate: fresh verification (not stale) → accept", () => {
  const v = classifyDoneGate({
    sawMutation: true,
    sawVerification: true,
    verificationStale: false,
    pendingHookFailure: null,
  });
  expect(v.state).toBe("done_ok");
  expect(v.block).toBe(false);
});

test("classifyDoneGate: stale flag without any verification stays unverified", () => {
  // verificationStale is meaningless when nothing was verified; the unverified
  // branch must still win so the message is accurate.
  const v = classifyDoneGate({
    sawMutation: true,
    sawVerification: false,
    verificationStale: true,
    pendingHookFailure: null,
  });
  expect(v.state).toBe("done_unverified");
  expect(v.block).toBe(true);
  expect(v.message).toContain("no passing verification");
});

test("classifyDoneGate: failing hook outranks stale verification", () => {
  const v = classifyDoneGate({
    sawMutation: true,
    sawVerification: true,
    verificationStale: true,
    pendingHookFailure: "bun test",
  });
  expect(v.state).toBe("done_hook_failing");
  expect(v.block).toBe(true);
});


test("optional npm scripts are not verification evidence", () => {
  for (const command of ["npm run test --if-present", "npm test --if-present"]) expect(isVerificationSignal(command)).toBe(false);
});

test("Go test no-test output is not verification evidence", () => {
  expect(verificationProducedEvidence("go test ./...", "ok example/pkg 0.01s [no tests to run]")).toBe(false);
  expect(verificationProducedEvidence("go test ./...", "? example/pkg [no test files]")).toBe(false);
  expect(verificationProducedEvidence("go test ./...", "ok example/pkg 0.01s")).toBe(true);
  expect(verificationProducedEvidence("go test ./...", "? example/empty [no test files]\nok example/tested 0.01s")).toBe(true);
  expect(verificationProducedEvidence("go test ./...", "? example/empty [no test files]\nok example/filtered 0.01s [no tests to run]")).toBe(false);
  expect(verificationProducedEvidence("go test -json ./...", '{"Action":"pass","Package":"example/pkg"}\n')).toBe(false);
  expect(verificationProducedEvidence("go test ./...", "")).toBe(false);
  expect(verificationProducedEvidence("go test ./...", "unexpected output")).toBe(false);
  expect(verificationProducedEvidence("bun test", "1 pass")).toBe(true);
});

test("non-verifying scripts and runner inspection flags are not verification", () => {
  for (const command of ["npm run lint:fix", "npm run test:update", "npm run check:fix", "npm run build:deploy", "tsc -v", "tsc -V", "pytest --co", "make test -n", "go build -n ./..."]) {
    expect(isVerificationSignal(command)).toBe(false);
  }
});

test("runner-specific verbose and parallel flags remain valid verification", () => {
  for (const command of ["go test -v ./...", "cargo test -v", "pytest -n 2"]) expect(isVerificationSignal(command)).toBe(true);
  for (const command of ["go test -n ./...", "just test -n", "tsc -V", "tsc -v"]) expect(isVerificationSignal(command)).toBe(false);
});

test("cargo test with no executed tests is not verification", () => {
  expect(verificationProducedEvidence("cargo test missing", "test result: ok. 0 passed; 0 failed; 0 ignored; 12 filtered out; finished in 0.00s")).toBe(false);
  expect(verificationProducedEvidence("cargo test", "test result: ok. 2 passed; 0 failed; 0 ignored; 0 filtered out; finished in 0.00s")).toBe(true);
});
