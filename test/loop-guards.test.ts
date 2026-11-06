import { test, expect } from "bun:test";
import {
  VERIFY_SIGNAL_RE,
  UNVERIFIED_MARKER,
  formatRejectedCompletion,
  isVerificationSignal,
  repeatHint,
  classifyDoneGate,
  verifierCores,
} from "../src/agent/loop-guards";
import { verificationProducedEvidence } from "../src/agent/loop-guards";

// The sentence every shell-evidence note ends with: only verification clears the gate, and the answer is labelled
// UNVERIFIED if the budget runs out first (a reply alone never lifts it).
const GATE_ESCAPE = "Only a passing verification command clears this check; if none applies, the answer is returned labelled UNVERIFIED once the correction budget is spent.";


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

test("classifyDoneGate: an unmeasured shell effect is named in the unverified and stale messages", () => {
  const unmeasured = "cap: workspace snapshot exceeded 2000 ms";
  const unverified = classifyDoneGate({ sawMutation: true, sawVerification: false, pendingHookFailure: null, unmeasured });
  expect(unverified.state).toBe("done_unverified");
  expect(unverified.block).toBe(true);
  expect(unverified.message).toContain("no passing verification");
  expect(unverified.message).toContain("could not measure a shell/computer call's effect");
  expect(unverified.message).toContain(unmeasured);
  expect(unverified.message).toContain(GATE_ESCAPE);

  const stale = classifyDoneGate({ sawMutation: true, sawVerification: true, verificationStale: true, pendingHookFailure: null, unmeasured });
  expect(stale.state).toBe("done_stale_verification");
  expect(stale.message).toContain(unmeasured);
  expect(stale.message).toContain(GATE_ESCAPE);
});

test("classifyDoneGate: the unmeasured note never changes the verdict and is absent without a reason", () => {
  // It only explains a block that already holds; it must not create or lift one.
  expect(classifyDoneGate({ sawMutation: false, sawVerification: false, pendingHookFailure: null, unmeasured: "cap: x" }))
    .toEqual({ state: "done_ok", block: false, message: "" });
  expect(classifyDoneGate({ sawMutation: true, sawVerification: true, pendingHookFailure: null, unmeasured: "cap: x" }).block).toBe(false);
  const hook = classifyDoneGate({ sawMutation: true, sawVerification: true, pendingHookFailure: "bun test", unmeasured: "cap: x" });
  expect(hook.state).toBe("done_hook_failing");
  expect(hook.message).not.toContain("could not measure");
  const plain = classifyDoneGate({ sawMutation: true, sawVerification: false, pendingHookFailure: null });
  expect(plain.message).not.toContain("could not measure");
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

test("isVerificationSignal accepts pure && chains of recognized verifiers and rejects mixed chains", () => {
  expect(isVerificationSignal("bun run typecheck && bun test")).toBe(true);
  expect(isVerificationSignal("tsc --noEmit && bun test test/loop-guards.test.ts")).toBe(true);
  expect(isVerificationSignal("node --check app.js")).toBe(true);
  expect(isVerificationSignal("bun test && echo done")).toBe(false);
  expect(isVerificationSignal("bun test && touch marker")).toBe(false);
});

const AC8_POSITIVES = [
  "cd sub && bun test",
  "JEO_X=1 bun test",
  "env -u OPENAI_BASE_URL bun test",
  "timeout 120 bun test",
  "bun test 2>&1",
  "uv run pytest",
  "poetry run pytest",
  "pipenv run pytest",
  "/Library/Frameworks/Python.framework/Versions/3.11/bin/pytest",
  "./node_modules/.bin/tsc --noEmit",
  "rtk test bun test",
  "rtk bun test",
];

const AC8_NEGATIVES = [
  "bun test | tail -5",
  "bun test; true",
  "bun test || true",
  "cd sub && rm -rf x",
  "FOO=$(evil) bun test",
  "timeout 120 rm -rf x",
  "env bun test --update-snapshots",
  "bun test > out.txt",
];

test("isVerificationSignal accepts wrapped verifier forms (AC-8)", () => {
  const accepted = AC8_POSITIVES.filter(command => isVerificationSignal(command));
  expect(accepted).toEqual(AC8_POSITIVES);
});

test("isVerificationSignal rejects unsafe wrapper forms (AC-8)", () => {
  const accepted = AC8_NEGATIVES.filter(command => isVerificationSignal(command));
  expect(accepted).toEqual([]);
});

test("verifierCores strips wrappers down to the verifier invocation", () => {
  expect(verifierCores("cd sub && bun test")).toEqual(["bun test"]);
  expect(verifierCores("env -u OPENAI_BASE_URL JEO_X=1 timeout 60s bun test 2>&1")).toEqual(["bun test"]);
  expect(verifierCores("/Library/Frameworks/Python.framework/Versions/3.11/bin/pytest -q")).toEqual(["pytest -q"]);
  expect(verifierCores("./node_modules/.bin/tsc --noEmit && rtk test bun test test/a.test.ts")).toEqual(["tsc --noEmit", "bun test test/a.test.ts"]);
  expect(verifierCores("ls -a")).toBeNull();
  expect(verifierCores("")).toBeNull();
});

test("wrapper prefixes never hide mutating flags, env updates, or unsafe chains", () => {
  for (const command of [
    "UPDATE_SNAPSHOTS=1 bun test",
    "env JEST_UPDATE=1 bun test",
    "env -u X bun test -u",
    "timeout 60 bun test --update-snapshots",
    "uv run pytest --co",
    "rtk tsc -v",
    "cd sub",
    "cd sub && cd x && bun test",
    "cd $HOME && bun test",
    "bun test && cd sub",
    "./run.sh",
    "bun test 2>out.txt",
    "bun test 2>&1 | tail",
    'JEO_X="1" bun test',
    "rtk test false",
  ]) expect(isVerificationSignal(command)).toBe(false);
  // The env `-u NAME` option is a wrapper, not Jest's update flag.
  expect(isVerificationSignal("env -u OPENAI_BASE_URL -u ANTHROPIC_BASE_URL JEO_SKIP_BROWSER_TESTS=1 bun test")).toBe(true);
  expect(isVerificationSignal("bun test 2>&1 && bun run typecheck 2>&1")).toBe(true);
});

test("wrapped go and cargo verifiers still require real test evidence", () => {
  expect(verificationProducedEvidence("timeout 60 go test ./...", "? p [no test files]")).toBe(false);
  expect(verificationProducedEvidence("timeout 60 go test ./...", "ok p 0.01s")).toBe(true);
  expect(verificationProducedEvidence("cd x && cargo test", "test result: ok. 0 passed")).toBe(false);
  expect(verificationProducedEvidence("cd x && cargo test", "test result: ok. 3 passed; 0 failed")).toBe(true);
  expect(verificationProducedEvidence("cd x && bun test", "1 pass")).toBe(true);
});

test("formatRejectedCompletion keeps the candidate answer under the UNVERIFIED marker", () => {
  const rejection = "You modified files this turn but have no passing verification.";
  const text = formatRejectedCompletion("  Here is the answer: 42\n", 3, rejection);
  expect(UNVERIFIED_MARKER).toBe("UNVERIFIED");
  expect(text.startsWith(`${UNVERIFIED_MARKER} - the completion gate did not accept this answer; treat it as unconfirmed.`)).toBe(true);
  expect(text).toContain("\n\nHere is the answer: 42\n\n");
  expect(text).toContain(`Stopped: completion rejected after 3 corrections. ${rejection}`);
  expect(text.endsWith(`Stopped: completion rejected after 3 corrections. ${rejection}`)).toBe(true);
  expect(/^[\x20-\x7e\n]*$/.test(text)).toBe(true);
});

test("formatRejectedCompletion without a candidate returns the plain stop text", () => {
  for (const candidate of ["", "   \n\t "]) {
    expect(formatRejectedCompletion(candidate, 3, "reason here")).toBe("Stopped: completion rejected after 3 corrections. reason here");
  }
});

test("classifyDoneGate: shell-changed paths are named in the unverified and stale messages", () => {
  // Fails against the old gate: the message said only "you modified files", so the model could not tell its own
  // writes from an unrelated process's and retried the same completion.
  const shellChanged = "modified heartbeat.json; added x.txt";
  const note = `Note: around a shell/computer call the host saw these paths change: ${shellChanged}.`;

  const unverified = classifyDoneGate({ sawMutation: true, sawVerification: false, pendingHookFailure: null, shellChanged });
  expect(unverified.state).toBe("done_unverified");
  expect(unverified.block).toBe(true);
  expect(unverified.message).toContain("no passing verification");
  expect(unverified.message).toContain(note);
  expect(unverified.message).toContain("Something other than your commands may have written them (another process, or your own background job)");
  expect(unverified.message).toContain(GATE_ESCAPE);

  const stale = classifyDoneGate({ sawMutation: true, sawVerification: true, verificationStale: true, pendingHookFailure: null, shellChanged });
  expect(stale.state).toBe("done_stale_verification");
  expect(stale.block).toBe(true);
  expect(stale.message).toContain("You verified earlier, but then modified files again");
  expect(stale.message).toContain(note);
  expect(stale.message).toContain(GATE_ESCAPE);
});

test("classifyDoneGate: shell-changed and unmeasured notes compose, changed paths first", () => {
  const shellChanged = "added made.txt";
  const unmeasured = "cap: workspace snapshot exceeded 2000 ms";
  for (const input of [
    { sawMutation: true, sawVerification: false, pendingHookFailure: null },
    { sawMutation: true, sawVerification: true, verificationStale: true, pendingHookFailure: null },
  ]) {
    const { message } = classifyDoneGate({ ...input, shellChanged, unmeasured });
    const changedAt = message.indexOf(`these paths change: ${shellChanged}.`);
    const unmeasuredAt = message.indexOf(`(${unmeasured})`);
    expect(changedAt).toBeGreaterThan(-1);
    expect(unmeasuredAt).toBeGreaterThan(changedAt);
  }
});

test("classifyDoneGate: the shell-changed note never changes the verdict and is absent without paths", () => {
  // Like `unmeasured`, it only explains a block that already holds; it must not create or lift one.
  const shellChanged = "added made.txt";
  expect(classifyDoneGate({ sawMutation: false, sawVerification: false, pendingHookFailure: null, shellChanged }))
    .toEqual({ state: "done_ok", block: false, message: "" });
  expect(classifyDoneGate({ sawMutation: true, sawVerification: true, pendingHookFailure: null, shellChanged }))
    .toEqual({ state: "done_ok", block: false, message: "" });
  expect(classifyDoneGate({ sawMutation: true, sawVerification: true, verificationStale: false, pendingHookFailure: null, shellChanged }).block).toBe(false);
  // A failing hook keeps its own state and message: the model must fix the hook, not reason about paths.
  const hook = classifyDoneGate({ sawMutation: true, sawVerification: true, pendingHookFailure: "bun test", shellChanged });
  expect(hook.state).toBe("done_hook_failing");
  expect(hook.block).toBe(true);
  expect(hook.message).not.toContain(shellChanged);
  expect(hook.message).not.toContain("Only a passing verification command");
  // No (or empty) path list means no note at all, not a dangling "Note: ... change: .".
  for (const absent of [undefined, ""]) {
    const plain = classifyDoneGate({ sawMutation: true, sawVerification: false, pendingHookFailure: null, shellChanged: absent });
    expect(plain.state).toBe("done_unverified");
    expect(plain.message).not.toContain("these paths change");
    expect(plain.message).not.toContain("Something other than your commands");
    expect(plain.message).not.toContain(GATE_ESCAPE);
  }
});

test("formatRejectedCompletion pluralizes the correction count and keeps the UNVERIFIED marker rule", () => {
  // Fails against the old text, which said "after 1 corrections.".
  const rejection = "reason here";
  for (const { count, noun } of [
    { count: 0, noun: "corrections" },
    { count: 1, noun: "correction" },
    { count: 2, noun: "corrections" },
    { count: 3, noun: "corrections" },
  ]) {
    const stop = `Stopped: completion rejected after ${count} ${noun}. ${rejection}`;
    // No candidate answer: just the stop text, never the marker.
    for (const empty of ["", "   \n\t "]) expect(formatRejectedCompletion(empty, count, rejection)).toBe(stop);
    // A candidate answer is kept verbatim (trimmed) under the marker, with the same stop text last.
    const withAnswer = formatRejectedCompletion("  The answer\n", count, rejection);
    expect(withAnswer.startsWith(`${UNVERIFIED_MARKER} - `)).toBe(true);
    expect(withAnswer).toContain("\n\nThe answer\n\n");
    expect(withAnswer.endsWith(stop)).toBe(true);
  }
});
