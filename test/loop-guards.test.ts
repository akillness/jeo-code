import { test, expect } from "bun:test";
import {
  VERIFY_SIGNAL_RE,
  UNVERIFIED_MARKER,
  formatRejectedCompletion,
  isVerificationSignal,
  repeatHint,
  classifyDoneGate,
  verifierCores,
  parseVerifier,
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

// Unsafe wrapper forms that stay unrecognized. The forms that used to be listed here (`| tail`, `; true`, `|| true`)
// are weak-but-recognized now: see AC8_WEAK_POSITIVES.
const AC8_NEGATIVES = [
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

// Weak forms: the shell's exit status is not the verifier's own (a pipe, `|| true`, `; true`, ...), so they are
// recognized but untrusted; the evidence tests below pin what then has to appear in the output.
const AC8_WEAK_POSITIVES = [
  "bun test | tail -5",
  "bun test; true",
  "bun test || true",
  "bun test 2>&1 | tail",
];

test("isVerificationSignal recognizes weak wrapper forms but never trusts their exit status (AC-8)", () => {
  expect(AC8_WEAK_POSITIVES.filter(command => !isVerificationSignal(command))).toEqual([]);
  expect(AC8_WEAK_POSITIVES.filter(command => parseVerifier(command)?.trusted !== false)).toEqual([]);
  for (const command of AC8_WEAK_POSITIVES) expect(verifierCores(command)).toEqual(["bun test"]);
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

const RECOGNIZED_VERIFIERS: ReadonlyArray<readonly [command: string, trusted: boolean]> = [
  ["bun test 2>&1 | tail -20", false],
  ["bun test | tee", false],
  ["bun test; echo done", false],
  ["bun test || true", false],
  ["set -e; bun test", false],
  ['bash -c "bun test"', true],
  ["time bun test", true],
  ["(cd x && bun test)", false],
  ["cd x; bun test", false],
  ['cd "x y" && bun test', true],
  ['pytest -k "foo and bar"', true],
  ["make -j4 test", true],
  ["make ci", true],
  ["make verify", true],
  ["pnpm -r test", true],
  ["pnpm --filter web test", true],
  ["yarn workspace web test", true],
  ["npm --prefix web test", true],
  ["bun run --silent test", true],
  ["bun --cwd web test", true],
  ["bun run --cwd web test", true],
  ["./gradlew test", true],
  ["mvn test", true],
  ["dotnet test", true],
  ["rspec", true],
  ["bundle exec rspec", true],
  ["phpunit", true],
  ["ruff check .", true],
  ["mypy .", true],
  ["flake8 src", true],
  ["golangci-lint run", true],
  ["staticcheck ./...", true],
  ["prettier --check .", true],
  ["cargo fmt --check", true],
  ["npx playwright test", true],
];

test("recognized verifier forms carry the expected trusted flag", () => {
  const wrong = RECOGNIZED_VERIFIERS.filter(([command, trusted]) => {
    const parsed = parseVerifier(command);
    return !isVerificationSignal(command) || parsed === null || parsed.trusted !== trusted;
  }).map(([command]) => command);
  expect(wrong).toEqual([]);
});

const UNRECOGNIZED_COMMANDS = [
  "bun test | grep ok",
  "bun test | head -1 && rm -rf x",
  "echo bun test",
  "bun test; rm -rf .",
  "bun test | tee src/x.ts",
  "bun test | tee package.json",
  "bun test | tee /etc/passwd",
  "bun test | tee out.log.ts",
  "ruff check . | tail",
  "ruff check .; echo ok",
  "mypy . || true",
  "git diff --check | cat",
  'bun test "--update-snapshots"',
  "bun test -u",
  "prettier --write .",
  "rm -rf x && bun test | tail",
  "bun test > out.log",
  "bun test $(rm -rf x)",
];

test("commands that can mutate, hide a failure, or run something else stay unrecognized", () => {
  expect(UNRECOGNIZED_COMMANDS.filter(command => isVerificationSignal(command))).toEqual([]);
});

test("quoted arguments are accepted but cannot hide an excluded flag", () => {
  for (const command of ["pytest -k 'foo and bar'", 'cd "x y" && bun test']) expect(isVerificationSignal(command)).toBe(true);
  const hidden = [
    "bun test '-u'",
    "bun test '--update-snapshots'",
    'jest "--updateSnapshot"',
    'pytest "--collect-only"',
    'pytest -k "foo" "--co"',
  ];
  expect(hidden.filter(command => isVerificationSignal(command))).toEqual([]);
});

test("tee takes no file argument: a verified call is not snapshot-bracketed, so a file write would be invisible", () => {
  for (const command of ["bun test | tee", "bun test | tee -a", "bun test | tee | tail -5", "bun test | tail | tee"]) {
    expect({ command, trusted: parseVerifier(command)?.trusted }).toEqual({ command, trusted: false });
  }
  const writes = [
    "bun test | tee out.log", "bun test | tee -a out.log", "bun test | tee out.txt", "bun test | tee x.out",
    "bun test | tee src/x.ts", "bun test | tee ../x.log", "bun test | tee package.json", "bun test | tee /etc/passwd",
    "bun test | tee out.log.ts", "bun test | tee -a src/x.ts", "bun test | tail | tee out.log", "bun test | tee a b",
  ];
  expect(writes.filter(command => isVerificationSignal(command))).toEqual([]);
});

test("head is not a display stage: it closes the pipe early, so a later failure is never seen", () => {
  const closing = [
    "go test ./... | head -4", "bun test | head -1", "bun test | head -3", "bun test | head -n 5", "bun test 2>&1 | head",
    "cargo test | head -20", "bun test | tail | head -2",
  ];
  expect(closing.filter(command => isVerificationSignal(command))).toEqual([]);
  // `tail` and a bare `tee` only relay what the runner printed.
  for (const command of ["bun test | tail", "bun test | tail -20", "bun test | tail -n 5", "bun test | tail -n5"]) {
    expect({ command, trusted: parseVerifier(command)?.trusted }).toEqual({ command, trusted: false });
  }
});

const SILENT_LINTERS = [
  "ruff check .", "mypy .", "flake8 src", "prettier --check .", "cargo fmt --check",
  "golangci-lint run", "staticcheck ./...",
];

test("silent linters are recognized in direct form only, never piped, chained with `;`/`||`, or subshelled", () => {
  for (const linter of SILENT_LINTERS) {
    expect(parseVerifier(linter)?.trusted).toBe(true);
    expect(parseVerifier(`cd x && ${linter}`)?.trusted).toBe(true);
    const weakForms = [
      `${linter} | tail`, `${linter} || true`, `${linter}; echo ok`, `${linter}; true`, `set -e; ${linter}`,
      `cd x; ${linter}`, `(${linter})`, `${linter} | tee`, `${linter} 2>&1 | tail -5`,
    ];
    expect(weakForms.filter(command => isVerificationSignal(command))).toEqual([]);
  }
});

test("a weak form needs every core to be a test runner; a direct chain may mix runners and linters", () => {
  expect(parseVerifier("bun test && ruff check .")).toEqual({ cores: ["bun test", "ruff check ."], trusted: true, echoed: null });
  expect(parseVerifier("bun test && bun run typecheck | tail")).toBeNull();
  expect(parseVerifier("bun test | tail && ruff check .")).toBeNull();
  expect(parseVerifier("bun test && bun test | tail")).toEqual({ cores: ["bun test", "bun test"], trusted: false, echoed: null });
});

test("parseVerifier reports cores, trust, and the discounted trailing echo", () => {
  expect(parseVerifier("bun test")).toEqual({ cores: ["bun test"], trusted: true, echoed: null });
  // An echo whose text could read as a pass summary is refused outright, not merely discounted.
  expect(parseVerifier("bun test; echo '5 passed'")).toBeNull();
  expect(parseVerifier("bun test; echo finished")).toEqual({ cores: ["bun test"], trusted: false, echoed: "finished" });
  expect(parseVerifier("bun test || echo done")).toEqual({ cores: ["bun test"], trusted: false, echoed: "done" });
  expect(parseVerifier('cd "x y" && bun test | tee')).toEqual({ cores: ["bun test"], trusted: false, echoed: null });
  expect(parseVerifier("(bun test)")).toEqual({ cores: ["bun test"], trusted: false, echoed: null });
  expect(parseVerifier("bash -c 'bun test | tail'")).toEqual({ cores: ["bun test"], trusted: false, echoed: null });
  // An echo inside `bash -c`, a subshell piped onward, and a doubly nested shell are not the tail of the whole output.
  expect(parseVerifier("bash -c 'bun test; echo x'")).toBeNull();
  expect(parseVerifier("(bun test) | tail")).toBeNull();
  expect(parseVerifier("bash -c 'bash -c \"bun test\"'")).toBeNull();
  expect(parseVerifier("bun test; echo done && rm x")).toBeNull();
  expect(parseVerifier("bun test || echo $HOME")).toBeNull();
  expect(parseVerifier("ls")).toBeNull();
  expect(parseVerifier("")).toBeNull();
});

// verificationProducedEvidence never sees the exit status: engine.ts only calls it for a call whose tool result
// succeeded. So a DIRECT runner's own status is trusted here, and only a weak form has to prove itself from output.
const WEAK_TEST_FORMS = [
  "bun test 2>&1 | tail -20",
  "bun test | tee",
  "bun test || true",
  "bun test; true",
  "set -e; bun test",
  "(cd x && bun test)",
  "cd x; bun test",
];

test("weak verifier forms are evidence only with a positive pass summary and no failure marker", () => {
  for (const command of WEAK_TEST_FORMS) {
    expect({ command, evidence: verificationProducedEvidence(command, "3 pass\n0 fail") }).toEqual({ command, evidence: true });
    expect({ command, evidence: verificationProducedEvidence(command, "1 pass\n1 fail") }).toEqual({ command, evidence: false });
    expect({ command, evidence: verificationProducedEvidence(command, "") }).toEqual({ command, evidence: false });
  }
  const piped = "bun test 2>&1 | tail -20";
  expect(verificationProducedEvidence(piped, "ERROR boom\n3 pass\n0 fail")).toBe(false);
  expect(verificationProducedEvidence(piped, "3 pass\n0 fail\nrun timed out")).toBe(false);
  expect(verificationProducedEvidence(piped, "0 pass\n0 fail")).toBe(false);
  expect(verificationProducedEvidence(piped, "compile error: unexpected token")).toBe(false);
  expect(verificationProducedEvidence(piped, "\u001b[32m3 pass\u001b[0m\n\u001b[2m0 fail\u001b[0m")).toBe(true);
});

test("a weak form's passed-test titles never read as failures, but a (fail) line always does", () => {
  const piped = "bun test 2>&1 | tail -20";
  expect(verificationProducedEvidence(piped, "(pass) adds numbers\n(pass) rejects 3 failed logins\n 2 pass\n 0 fail")).toBe(true);
  expect(verificationProducedEvidence(piped, "(pass) a\n(pass) b")).toBe(false);
  // `tail` can cut the summary's fail line off; the (fail) title line alone must still reject the run.
  expect(verificationProducedEvidence(piped, "(pass) a\n(fail) b\n 1 pass")).toBe(false);
});

test("an echo that could pass for a summary is never a verifier; a neutral one is recognized and discounted", () => {
  const forgeries: string[] = [];
  for (const text of ["5 passed", "5 pass", "3 passing", "pass", "OK", "all ok", "success", "SUCCESS", "0", "12"]) {
    forgeries.push(`bun test ; echo '${text}'`, `bun test || echo '${text}'`);
  }
  forgeries.push('bun test nonexistentdir/ || echo "5 pass"', "bun test; echo passed", "bun test; echo 5", "bun test || echo OK");
  expect(forgeries.filter(command => isVerificationSignal(command))).toEqual([]);
  for (const command of ["bun test || echo done", "bun test; echo finished", "bun test || echo tests-failed"]) {
    expect({ command, trusted: parseVerifier(command)?.trusted }).toEqual({ command, trusted: false });
  }
});

test("echoed text is discounted wherever it lands as a whole line, never read as the runner's output", () => {
  const echo = "bun test; echo done";
  expect(verificationProducedEvidence(echo, "done")).toBe(false);
  expect(verificationProducedEvidence(echo, "done\ndone")).toBe(false);
  expect(verificationProducedEvidence(echo, "3 pass\n0 fail\ndone")).toBe(true);
  expect(verificationProducedEvidence(echo, "done\n3 pass\n0 fail")).toBe(true);
  expect(verificationProducedEvidence(echo, "3 pass\n0 fail done")).toBe(true);
  // The bash tool joins stdout then stderr, so the echo can sit above the runner's own lines. `ERROR` is neutral
  // text for an echo, but a failure marker if it were read as output: it must go wherever it sits as a whole line...
  const marker = "bun test; echo ERROR";
  expect(verificationProducedEvidence(marker, "ERROR\n3 pass\n0 fail")).toBe(true);
  expect(verificationProducedEvidence(marker, "3 pass\n0 fail\nERROR")).toBe(true);
  // ...while a real failure line that merely contains the word stays.
  expect(verificationProducedEvidence(marker, "ERROR\n3 pass\n0 fail\nERROR: boom")).toBe(false);
  expect(verificationProducedEvidence("bun test; echo done", "done\n3 pass\n1 fail")).toBe(false);
});

test("a direct test runner whose output says nothing ran is not evidence without a positive pass line", () => {
  const direct = "cd x && bun test";
  expect(verificationProducedEvidence(direct, "0 pass")).toBe(false);
  expect(verificationProducedEvidence(direct, "0 pass\n0 fail")).toBe(false);
  expect(verificationProducedEvidence(direct, "2 pass\n0 fail")).toBe(true);
  const nothingRan: ReadonlyArray<readonly [command: string, output: string]> = [
    ["bun test", "error: No tests found!"],
    ["pytest", "collected 0 items\n\n============ no tests ran in 0.01s ============"],
    ["python -m unittest", "Ran 0 tests in 0.000s\n\nNO TESTS RAN"],
    ["jest", "Tests:       0 passed, 0 total"],
  ];
  expect(nothingRan.filter(([command, output]) => verificationProducedEvidence(command, output)).map(([command]) => command)).toEqual([]);
  // A positive pass line anywhere keeps the run valid, and "10 pass" is not "0 pass".
  expect(verificationProducedEvidence("bun test", "0 pass\n3 pass")).toBe(true);
  expect(verificationProducedEvidence("bun test", "10 pass\n0 fail")).toBe(true);
  expect(verificationProducedEvidence("pytest", "== 5 passed in 0.1s ==")).toBe(true);
});

test("direct silent linters count on a clean exit with empty output", () => {
  for (const linter of SILENT_LINTERS) expect({ linter, evidence: verificationProducedEvidence(linter, "") }).toEqual({ linter, evidence: true });
  expect(verificationProducedEvidence("mypy .", "Success: no issues found in 3 source files")).toBe(true);
});

test("a direct runner trusts its own exit status where the same output sinks a weak form", () => {
  const mixed = "1 pass\n1 fail";
  expect(verificationProducedEvidence("bun test", mixed)).toBe(true);
  expect(verificationProducedEvidence("bun test | tail", mixed)).toBe(false);
});

test("weak forms keep the go and cargo real-test-run requirement", () => {
  expect(verificationProducedEvidence("go test ./... | tail -5", "ok p 0.01s")).toBe(true);
  expect(verificationProducedEvidence("go test ./... | tail -5", "? p [no test files]")).toBe(false);
  expect(verificationProducedEvidence("cargo test 2>&1 | tail", "test result: ok. 3 passed; 0 failed")).toBe(true);
  expect(verificationProducedEvidence("cargo test 2>&1 | tail", "test result: ok. 0 passed; 0 failed")).toBe(false);
  expect(verificationProducedEvidence("go test ./...", "? p [no test files]")).toBe(false);
  expect(verificationProducedEvidence("cargo test", "test result: ok. 0 passed; 0 failed")).toBe(false);
});

// Each row: a runner-shaped pass summary, plus ONE failure marker that is not the summary's own count line. A weak form
// has no trustworthy exit status, so the marker alone must sink it, wherever in the output it appears.
const WEAK_FAILURE_MARKERS: ReadonlyArray<readonly [name: string, command: string, summary: string, marker: string]> = [
  ["cargo: target failed", "cargo test 2>&1 | tail -12", "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured", "error: 1 target failed:\n    `--test integ`"],
  ["cargo: test failed", "cargo test 2>&1 | tail", "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured", "error: test failed, to rerun pass `--lib`"],
  ["cargo: could not compile", "cargo test 2>&1 | tail", "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured", "error: could not compile `x` (lib test) due to 1 previous error"],
  ["cargo: test result FAILED", "cargo test | tail", "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured", "test result: FAILED."],
  ["cargo: test line FAILED", "cargo test | tail", "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured", "test config::loads ... FAILED"],
  ["cargo: failures block", "cargo test | tail", "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured", "failures:"],
  ["mvn: BUILD FAILURE", "mvn test 2>&1 | tail", "Tests run: 5, Failures: 0, Errors: 0, Skipped: 0", "[INFO] BUILD FAILURE"],
  ["mvn: Tests run with failures", "mvn test | tail", "Tests run: 5, Failures: 0, Errors: 0, Skipped: 0", "Tests run: 3, Failures: 2, Errors: 0, Skipped: 0"],
  ["mvn: Tests run with errors", "mvn test | tail", "Tests run: 5, Failures: 0, Errors: 0, Skipped: 0", "Tests run: 3, Failures: 0, Errors: 2, Skipped: 0"],
  ["phpunit: ERRORS!", "phpunit | tail", "OK (3 tests, 3 assertions)", "ERRORS!"],
  ["phpunit: FAILURES!", "phpunit | tail", "OK (3 tests, 3 assertions)", "FAILURES!"],
  ["dotnet: Failed!", "dotnet test | tail", "Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3", "Failed!"],
];

test("weak forms are sunk by the failure markers of cargo, maven, phpunit and dotnet, above or below the summary", () => {
  const wrong: string[] = [];
  for (const [name, command, summary, marker] of WEAK_FAILURE_MARKERS) {
    if (!verificationProducedEvidence(command, summary)) wrong.push(`${name}: control summary alone must count`);
    if (verificationProducedEvidence(command, `${summary}\n${marker}`)) wrong.push(`${name}: marker below the summary`);
    if (verificationProducedEvidence(command, `${marker}\n${summary}`)) wrong.push(`${name}: marker above the summary`);
  }
  expect(wrong).toEqual([]);
});

test("a weak form scans the whole output for a failure marker, not just a tail window", () => {
  const filler = "still running\n".repeat(60);
  const piped = "bun test | tail";
  expect(verificationProducedEvidence(piped, `ERROR boom\n${filler}3 pass\n0 fail`)).toBe(false);
  expect(verificationProducedEvidence(piped, `3 pass\n0 fail\n${filler}ERROR late`)).toBe(false);
  expect(verificationProducedEvidence(piped, `${filler}3 pass\n0 fail`)).toBe(true);
});

test("cargo `test result: ok` followed by `error: 1 target failed` through tail is not evidence", () => {
  const output = "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured\nerror: 1 target failed:\n    `--test integ`";
  expect(verificationProducedEvidence("cargo test 2>&1 | tail -12", output)).toBe(false);
  expect(verificationProducedEvidence("cargo test 2>&1 | tail -12", "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured")).toBe(true);
  // A direct cargo run keeps its own exit status as the verdict: the marker is only consulted for weak forms.
  expect(verificationProducedEvidence("cargo test", output)).toBe(true);
});

// make/just/rake/gradle/mvn/dotnet take TARGETS, i.e. further commands: `make ci deploy` would run `deploy`.
const TASK_RUNNER_REJECTED = [
  "make ci deploy", "make test deploy", "make -j4 test deploy", "make clean deploy test", "make test UPDATE=1", "make test SHELL=/bin/evil",
  "make test MAKEFLAGS=-n", "make deploy", "make clean", "make all", "make test -n",
  "just test deploy", "just ci publish",
  "mvn test deploy", "mvn clean test deploy", "mvn test -fn", "mvn verify deploy", "mvn test -Dmaven.test.failure.ignore=true",
  "gradle check publish", "gradle build publishToMavenLocal", "gradle test deploy", "gradle test --scan", "gradle test -x test", "gradle test -x check",
  "gradle test --exclude-task check", "./gradlew build publish",
  "rake test db:drop", "bundle exec rake test db:reset", "rake spec db:migrate", "rake db:drop",
  "dotnet test deploy", "dotnet test publish",
];
const TASK_RUNNER_ACCEPTED = [
  "make ci", "make test", "make -j4 test", "make -C sub test", "make clean test", "make test ci", "make ci TARGET=x", "make -j4 test lint",
  "make lint", "make build", "make check", "make format-check", "make unit", "make e2e", "make coverage", "make spec",
  "just test", "just test ci",
  "mvn test", "mvn clean test", "mvn clean verify", "mvn -q test", "mvn -T 4C test", "mvn test -Dtest=Foo",
  "gradle test", "gradle clean test", "./gradlew test", "gradlew test --tests Foo", "gradle build", "gradle check",
  "rake test", "bundle exec rake test", "rake spec", "rake test TESTOPTS=-v",
  "dotnet test", "dotnet test foo.csproj", "dotnet test --no-build", "dotnet test -c Release",
];

test("task runners accept only flags, NAME=VALUE and allow-listed targets: extra targets are rejected", () => {
  expect(TASK_RUNNER_REJECTED.filter(command => isVerificationSignal(command))).toEqual([]);
  expect(TASK_RUNNER_ACCEPTED.filter(command => !isVerificationSignal(command))).toEqual([]);
  for (const command of ["make ci | tail", "make -C sub test | tail", "mvn clean test | tail", "dotnet test | tail", "rake test | tail", "just test | tail"]) {
    expect({ command, trusted: parseVerifier(command)?.trusted }).toEqual({ command, trusted: false });
  }
  // A silent target is recognized directly but never through a pipe, `||` or `;`.
  for (const command of ["make lint | tail", "make build || true", "gradle build | tail", "make check; echo done"]) {
    expect({ command, recognized: isVerificationSignal(command) }).toEqual({ command, recognized: false });
  }
  // A chain stays strict on every link.
  expect(isVerificationSignal("make test && make deploy")).toBe(false);
  expect(parseVerifier("make lint && make test")).toEqual({ cores: ["make lint", "make test"], trusted: true, echoed: null });
});

// Task-runner tails accept ANY flag, the value it consumes, NAME=VALUE, Gradle project paths and allow-listed targets;
// a per-tool deny-list (TASK_DENY) then removes the test-skipping, non-running and mutating ones.
const TASK_FLAGS_RECOGNIZED = [
  "make test -j 4", "make test --jobs 4", "make -j 4 test", "make -j8 test", "make test V=1", "mvn -am test", "mvn -ntp test",
  "mvn -B -q verify", "mvn clean test", "./gradlew :app:test", "./gradlew --no-daemon check", "gradle test --tests Foo",
  "dotnet test -c Release", "rspec spec/foo_spec.rb", "make -C sub test",
  // make: jobs/load spellings, and flags that only change output or ordering
  "make test -j4", "make test --jobs=4", "make --jobs 4 test", "make -l 4 test", "make test -j 4 -C sub", "make test -k", "make test -s",
  "make test -w", "make test -B", "make test --keep-going", "make test --no-print-directory", "make test FOO=1",
  // mvn
  "mvn -T 4 test", "mvn -T1C test", "mvn -pl a,b test", "mvn -pl :a test", "mvn -P ci test", "mvn -Pci test", "mvn -U test", "mvn -X test",
  "mvn -e test", "mvn -o test", "mvn -fae test", "mvn --fail-at-end test", "mvn test -Dtest=Foo#bar", "mvn test -Dfoo=bar", "mvn -f sub/pom.xml test",
  "mvn -rf :a test", "./mvnw -B verify", "mvn -t tc.xml test",
  // gradle
  "gradle test -i", "gradle test --info", "gradle test --no-daemon", "gradle test --offline", "gradle test --continue", "gradle test --parallel",
  "gradle test --max-workers 4", "gradle test --console plain", "gradle test -Dfoo=bar", "gradle test -Pversion=1", "gradle test --tests 'Foo*'",
  "gradle -p sub test", "gradle --no-daemon :app:test --tests Foo", "gradle test -Dorg.gradle.jvmargs=-Xmx2g",
  // just / rake / dotnet / rspec
  "just -f x test", "just test FOO=1", "rake test -t", "rake test --trace", "rake test -j 4", "rake test -j", "rake -f Rakefile test",
  "dotnet test --filter Name~Foo", "dotnet test -l trx", "dotnet test -v n", "dotnet test foo.csproj", "dotnet test --no-build", "dotnet test --nologo",
  "rspec spec/foo_spec.rb:12", "bundle exec rspec spec",
];

test("task runners accept any flag and the value it consumes when it is not on that tool's deny-list", () => {
  const wrong = TASK_FLAGS_RECOGNIZED.filter(command => parseVerifier(command)?.trusted !== true);
  expect(wrong).toEqual([]);
});

test("a value-taking flag consumes its value, so a value that looks like a target is not one", () => {
  // `deploy` is the DIRECTORY / FILE / FILTER here, not a target: the command still runs only `test`.
  for (const command of [
    "make -C deploy test", "make test -C deploy", "make -f deploy test", "gradle -p deploy test", "gradle test --tests deploy",
    "gradle -b deploy.gradle test", "mvn -pl deploy test", "mvn -f deploy test", "just -f deploy test", "rake -f deploy test",
    "dotnet test -c deploy", "dotnet test --filter deploy", "gradle test --console deploy",
  ]) expect({ command, recognized: isVerificationSignal(command) }).toEqual({ command, recognized: true });
  // Conversely a target swallowed as a flag's value leaves nothing to run, and a bare `deploy` is still a target.
  for (const command of [
    "make -C test", "make -j 4", "make -C sub deploy", "gradle -p test", "mvn -pl test", "mvn -P test", "mvn -T test", "mvn -t test", "make -jtest",
  ]) expect({ command, recognized: isVerificationSignal(command) }).toEqual({ command, recognized: false });
});

test("a Gradle project path is a target only when its last segment is allow-listed", () => {
  for (const command of ["./gradlew :app:test", "gradle :app:sub:test", "gradle :test", "gradle app:test", "gradle :app:check", "gradle :app:test :lib:check"]) {
    expect({ command, trusted: parseVerifier(command)?.trusted }).toEqual({ command, trusted: true });
  }
  for (const command of ["gradle :app:deploy", "gradle :app:publish", "gradle :app:test :lib:deploy", "gradle :app:test deploy", ":app:test"]) {
    expect({ command, recognized: isVerificationSignal(command) }).toEqual({ command, recognized: false });
  }
});

// Flags and properties that skip the tests, only print/list/touch, mask a failing exit status, or rewrite lock files.
const TASK_DENIED: Readonly<Record<string, readonly string[]>> = {
  make: [
    "make test -n", "make test --dry-run", "make test -t", "make test --touch", "make test -q", "make test --question", "make test -i",
    "make test --ignore-errors", "make test -W x", "make test -o x", "make test --what-if x", "make test --just-print", "make test --recon",
    "make test --eval x", "make -kn test",
  ],
  "make NAME=VALUE": [
    "make test SKIP=1", "make test IGNORE_X=1", "make test UPDATE_SNAPSHOTS=1", "make test GOLDEN=1", "make test SHELL=/bin/sh", "make test MAKEFLAGS=-n",
  ],
  just: ["just test -n", "just --dry-run test", "just test --list", "just test --evaluate", "just test -s", "just test -e", "just test -l", "just test SKIP=1"],
  // The same flags BEFORE the target. `shortNoOp` needs a token between the tool name and `-n`, so a leading `-n`
  // (`just -n test`) is rejected by the deny-list alone.
  "flag before target": [
    "just -n test", "just -l test", "just --dry-run test", "make -n test", "make -t test", "make --dry-run test", "make -i test", "make -q test",
    "make -W x test", "make -o x test", "rake -n test", "rake -T test", "rake -P test", "rake --dry-run test", "gradle -m test", "gradle -t test",
    "gradle --dry-run test", "gradle --write-locks test", "gradle --scan test", "gradle -x test test", "mvn -fn test", "mvn --fail-never test",
    "mvn -DskipTests test", "mvn -Dmaven.test.skip.exec=true test",
  ],
  rake: [
    "rake test -n", "rake test --dry-run", "rake -T test", "rake -P test", "rake -D test", "rake test --tasks", "rake test --prereqs",
    "rake test --describe", "rake test -E x", "rake test -V", "rake test SKIP=1",
  ],
  gradle: [
    "gradle test -m", "gradle test -a", "gradle test -t", "gradle test --continuous", "./gradlew test -x test", "gradle test -x check",
    "gradle test --exclude-task check", "gradle test --dry-run", "gradle test --scan", "gradle test -I init.gradle", "gradle test --init-script x.gradle",
    "./gradlew test --write-locks", "gradle test --update-locks x", "gradle test --write-verification-metadata sha256", "gradle test --refresh-dependencies",
    "gradle test --export-keys", "gradle test --no-rebuild",
    "./gradlew test -Ptest.ignoreFailures=true", "gradle test -Dskip.tests=true", "gradle test -Pignore=1", "gradle test -PskipTests",
    "gradle test --project-prop skipTests=true", "gradle test --system-prop skip=1", "gradle test -P ignore=1",
  ],
  mvn: [
    "mvn test -DskipTests", "mvn test -DskipTests=true", "mvn test -Dmaven.test.skip=true", "mvn test -Dmaven.test.skip.exec=true",
    "mvn test -Dmaven.test.failure.ignore=true", "mvn test -Dmaven.test.failure.ignore", "mvn test -Dtest.failure.ignore", "mvn test -DfailIfNoTests=false",
    "mvn test -Dsurefire.failIfNoSpecifiedTests=false", "mvn test -DskipITs", "mvn test -Dcheckstyle.skip", "mvn test -Drat.ignore=1",
    "mvn -D skipTests test", "mvn test --define skipTests", "mvn -P skip-tests test", "mvn -P ignore test", "mvn --activate-profiles skip test",
    "mvn -fn test", "mvn --fail-never test", "mvn -v", "mvn --version", "mvn -h test", "mvn test --help",
  ],
  dotnet: [
    "dotnet test -t", "dotnet test --list-tests", "dotnet test -h", "dotnet test --help", "dotnet test -?", "dotnet test -p:Skip=1",
    "dotnet test -p:IgnoreX=true", "dotnet test -Dskip=1", "dotnet test /p:Skip=1",
  ],
  "extra targets (round 1)": [
    "make ci deploy", "mvn test deploy", "gradle check publish", "rake test db:drop", "gradle build publishToMavenLocal", "bundle exec rake test db:reset",
  ],
};

test("task runners reject their test-skipping, non-running, failure-masking and lock-rewriting flags and properties", () => {
  const accepted: Record<string, string[]> = {};
  for (const [group, commands] of Object.entries(TASK_DENIED)) {
    const leaked = commands.filter(command => isVerificationSignal(command));
    if (leaked.length) accepted[group] = leaked;
  }
  expect(accepted).toEqual({});
});

test("a denied flag is rejected however it is quoted, chained or piped", () => {
  const hidden = [
    "make test '-n'", 'make "-n" test', "make 'test' -n", "gradle test '-x' test", "mvn test '-DskipTests'", "cd sub && mvn test -DskipTests",
    "make test -n | tail", "bun test && ./gradlew test -x test", "./gradlew test -x test || true", "(mvn test -DskipTests)",
  ];
  expect(hidden.filter(command => isVerificationSignal(command))).toEqual([]);
  // One denied link sinks a whole && chain; clean links on both sides do not rescue it.
  expect(isVerificationSignal("make lint && make test -n && bun test")).toBe(false);
  expect(parseVerifier("make lint && mvn clean test && bun test")).toEqual({ cores: ["make lint", "mvn clean test", "bun test"], trusted: true, echoed: null });
});

test("the deny-list is per tool: the same flag letter means different things", () => {
  // `-t` touches files in make and lists tests in dotnet, but selects toolchains in mvn and is a plain trace flag in rake.
  expect(isVerificationSignal("make test -t")).toBe(false);
  expect(isVerificationSignal("dotnet test -t")).toBe(false);
  expect(isVerificationSignal("gradle test -t")).toBe(false);
  expect(isVerificationSignal("mvn -t tc.xml test")).toBe(true);
  expect(isVerificationSignal("rake test -t")).toBe(true);
  // `-i` ignores errors in make, but is gradle's `--info` log level.
  expect(isVerificationSignal("make test -i")).toBe(false);
  expect(isVerificationSignal("gradle test -i")).toBe(true);
  // Case matters: mvn's `-X` (debug) and `-U` (update snapshots) are not gradle's `-x test` skip or jest's `-u` update.
  expect(isVerificationSignal("mvn -X test")).toBe(true);
  expect(isVerificationSignal("mvn -U test")).toBe(true);
  expect(isVerificationSignal("gradle test -x test")).toBe(false);
  expect(isVerificationSignal("mvn -u test")).toBe(false);
  // `-D`/`-P` carrying an innocuous property stays fine; only skip/ignore/failure/dry-run/update/snapshot/golden names are denied.
  expect(isVerificationSignal("mvn test -Dfoo=bar")).toBe(true);
  expect(isVerificationSignal("mvn test -DskipTests")).toBe(false);
});

// engine.ts credits a call only when it IS a recognized verifier and its output shows evidence. A rejected command is
// never credited, whatever it printed: a skipped, dry or failure-ignoring run looks like success on its own.
function credited(command: string, output: string): boolean {
  return isVerificationSignal(command) && verificationProducedEvidence(command, output);
}

test("the output of a skipped, dry, or failure-ignoring run never earns credit for a rejected command", () => {
  const skipped: ReadonlyArray<readonly [command: string, output: string]> = [
    ["mvn test -DskipTests", "[INFO] Tests are skipped.\n[INFO] BUILD SUCCESS"],
    ["mvn test -Dmaven.test.skip.exec=true", "[INFO] Tests are skipped.\n[INFO] BUILD SUCCESS"],
    ["mvn test -Dmaven.test.failure.ignore=true", "Tests run: 3, Failures: 1, Errors: 0, Skipped: 0\n[INFO] BUILD SUCCESS"],
    ["./gradlew test -x test", "> Task :test SKIPPED\nBUILD SUCCESSFUL in 1s"],
    ["gradle test -m", "> Task :test SKIPPED\nBUILD SUCCESSFUL in 1s"],
    ["./gradlew test -Ptest.ignoreFailures=true", "3 tests completed, 1 failed\nBUILD SUCCESSFUL in 2s"],
    ["./gradlew test --write-locks", "BUILD SUCCESSFUL in 2s"],
    ["make test -n", "bun test"],
    ["make test --dry-run", "bun test"],
    ["make test -t", "touch test"],
  ];
  expect(skipped.filter(([command]) => isVerificationSignal(command))).toEqual([]);
  expect(skipped.filter(([command, output]) => credited(command, output)).map(([command]) => command)).toEqual([]);
  // Controls: the same gate does credit a real run, so the rejection above is the command's, not the helper's.
  expect(credited("mvn test", "Tests run: 3, Failures: 0, Errors: 0, Skipped: 0\n[INFO] BUILD SUCCESS")).toBe(true);
  expect(credited("make test -j 4", "3 pass\n0 fail")).toBe(true);
  expect(credited("./gradlew :app:test", "BUILD SUCCESSFUL in 2s")).toBe(true);
});

test("a recognized task-runner run that executed zero tests is still not evidence", () => {
  expect(isVerificationSignal("mvn -B -q verify")).toBe(true);
  expect(credited("mvn -B -q verify", "Tests run: 0, Failures: 0, Errors: 0, Skipped: 0\n[INFO] BUILD SUCCESS")).toBe(false);
  expect(credited("mvn -B -q verify", "Tests run: 4, Failures: 0, Errors: 0, Skipped: 0\n[INFO] BUILD SUCCESS")).toBe(true);
  expect(credited("dotnet test -c Release", "No test is available in x.dll.")).toBe(false);
  expect(credited("make test --jobs 4", "0 pass")).toBe(false);
  expect(credited("make test --jobs 4", "2 pass\n0 fail")).toBe(true);
});

test("`git diff --check` is not a verifier, alone or chained, and prettier write clusters are rejected", () => {
  for (const command of ["git diff --check", "git diff --check HEAD", "git diff --check && bun test", "bun test && git diff --check"]) {
    expect({ command, recognized: isVerificationSignal(command) }).toEqual({ command, recognized: false });
  }
  for (const command of [
    "prettier --check -cw .", "prettier --check -wc .", "prettier -cw .", "prettier -w .", "prettier -l -w .",
    "npx prettier --check -cw .", "pnpm exec prettier --check -wc .", "prettier --check '-cw' .", "prettier --check --write .",
  ]) expect({ command, recognized: isVerificationSignal(command) }).toEqual({ command, recognized: false });
  for (const command of ["prettier --check .", "prettier -c .", "prettier -l .", "prettier --check -l .", "prettier --list-different .", "prettier --check src -c"]) {
    expect({ command, recognized: isVerificationSignal(command) }).toEqual({ command, recognized: true });
  }
});

test("direct runners that report nothing ran are not evidence: node, maven, rspec, jest, vitest, phpunit, dotnet", () => {
  const nothingRan: ReadonlyArray<readonly [command: string, output: string]> = [
    ["node --test", "# tests 0\n# pass 0\n# fail 0"],
    ["node --test", "\u2139 tests 0\n\u2139 pass 0\n\u2139 fail 0"],
    ["mvn test", "Tests run: 0, Failures: 0, Errors: 0, Skipped: 0\n[INFO] BUILD SUCCESS"],
    ["rspec", "Finished in 0.0003 seconds\n0 examples, 0 failures"],
    ["bundle exec rspec", "0 examples, 0 failures"],
    ["jest", "No tests to run."],
    ["jest", "No tests found, exiting with code 1"],
    ["vitest", "No test files found, exiting with code 1"],
    ["phpunit", "No tests executed!"],
    ["dotnet test", "No test is available in x.dll."],
  ];
  expect(nothingRan.filter(([command, output]) => verificationProducedEvidence(command, output)).map(([command, output]) => `${command}: ${output}`)).toEqual([]);
  // The same runners with real counts, and a zero line next to a real pass line, still count; 10 is not 0.
  const ran: ReadonlyArray<readonly [command: string, output: string]> = [
    ["node --test", "# tests 3\n# pass 3\n# fail 0"],
    ["node --test", "# tests 10\n# pass 10\n# fail 0"],
    ["mvn test", "Tests run: 5, Failures: 0, Errors: 0, Skipped: 0\n[INFO] BUILD SUCCESS"],
    ["mvn test", "Tests run: 0, Failures: 0, Errors: 0\nTests run: 5, Failures: 0, Errors: 0"],
    ["rspec", "3 examples, 0 failures"],
    ["rspec", "10 examples, 0 failures"],
  ];
  expect(ran.filter(([command, output]) => !verificationProducedEvidence(command, output)).map(([command, output]) => `${command}: ${output}`)).toEqual([]);
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
