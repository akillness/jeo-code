/**
 * Intermediate-judgment guards for the agent loop — the mid-run "should this turn
 * continue, correct itself, or stop" decisions that run between model calls.
 *
 * This module provides a named `GuardState` taxonomy and pure,
 * independently-testable classifier functions. `engine.ts` owns the control
 * flow (history mutation, `step++`, `continue`, `return finish(...)`);
 * only the judgment is handled here, keeping classification separate from
 * runtime actions without changing behavior.
 */

/**
 * Named taxonomy of the loop's intermediate judgments.
 * Each member names one decision the loop can reach mid-turn.
 */
export type GuardState =
  | "ok" // proceed: emit / execute the tool call as-is
  | "repeat_correct" // exact-repeat detected → ONE corrective bounce (skip execution)
  | "repeat_stop" // exact-repeat survived the correction → consolidate-stop
  | "cycle_correct" // A↔B alternation detected → ONE corrective bounce
  | "cycle_stop" // cycle survived the correction → consolidate-stop
  | "consecutive_failure_stop" // MAX_FAILURES different-but-failing steps → stop
  | "invalid_tool_stop" // MAX_INVALID_CALLS replies with no usable tool field → stop
  | "parse_salvage" // repeated non-JSON prose → salvage the text as the final answer
  | "context_overflow_retry" // provider reported context overflow → ONE trim + retry
  | "refusal_retry" // safety refusal → context-reset ladder, then unbounded backoff resends
  | "done_unverified" // mutated files, no verification signal → pushback on done
  | "done_stale_verification" // verified, then mutated again → re-verify before done
  | "done_hook_failing" // post-turn hook still failing → pushback on done
  | "done_ok"; // done accepted — the turn is finished

/**
 * Bounded thresholds for every loop guard — the single, named source of truth.
 * Kept in one frozen object so the limits are discoverable and testable instead of
 * sprinkled as bare literals through the loop body.
 */
/**
 * Prefix of the launch-level `onBeforeDone` nudge that merely restates the mutation-verification gate. The engine's
 * own `classifyDoneGate` already blocks (and explains) that case, so the engine must not count the restatement as an
 * independent block — otherwise the shell-only correction cap could never apply in the interactive loop.
 */
export const MUTATION_NUDGE_PREFIX = "Cannot finish: a workspace mutation from this session still lacks a successful, non-stale verification.";

export const GUARD_LIMITS = Object.freeze({
  /** Identical step repeats tolerated before a consolidated stop (with corrections en route). */
  MAX_REPEAT: 4,
  /** Consecutive different-but-failing steps before the turn stops. */
  MAX_FAILURES: 5,
  /** Rejected completion attempts that may request a correction before stopping incomplete. */
  MAX_DONE_CORRECTIONS: 3,
  /** Same, when the only mutation evidence is a shell/computer snapshot bracket (no built-in mutator
   *  succeeded). An unrelated process writing in the cwd looks identical to the command's own writes, so
   *  one correction states the paths and asks for verification; a second full-history retry only burns tokens. */
  MAX_SHELL_ONLY_DONE_CORRECTIONS: 1,
  /** Context-mutating refusal-ladder rungs (resend → reset → guidance strip) before
   *  recovery switches to unbounded backoff resends; refusal recovery is never terminal. */
  MAX_REFUSAL_RETRIES: 3,
  /** First post-ladder refusal backoff wait (ms); doubles per attempt. */
  REFUSAL_BACKOFF_BASE_MS: 2_000,
  /** Ceiling on the post-ladder refusal backoff wait (ms). */
  REFUSAL_BACKOFF_MAX_MS: 30_000,
  /** Replies with no usable `tool`/`tools` field before the turn stops. */
  MAX_INVALID_CALLS: 3,
  /** Consecutive non-JSON parse failures before the prose is salvaged as the answer. */
  MAX_PARSE_BOUNCES: 2,
  /** Recent-signature window scanned for an A↔B (≤2 distinct calls) cycle. */
  CYCLE_WINDOW: 6,
  /** Mid-stream transient-network drops (Bun/undici socket-closed, ECONNRESET, stream
   *  idle, 5xx, …) tolerated per turn before surfacing a terminal error. Distinct from
   *  the refusal ladder: these are infra/transport faults, not content-classifier trips,
   *  so a bounded retry (not unbounded backoff) is correct — a persistent failure past
   *  this many attempts is a real outage worth surfacing, not spinning on forever. */
  MAX_TRANSIENT_NETWORK_RETRIES: 5,
  /** First transient-network retry wait (ms); doubles per attempt. */
  TRANSIENT_NETWORK_BACKOFF_BASE_MS: 1_000,
  /** Ceiling on the transient-network retry wait (ms). */
  TRANSIENT_NETWORK_BACKOFF_MAX_MS: 15_000,
});

/**
 * Recognized standalone verification commands. Matching the full command prevents
 * filenames, prose, and shell output from impersonating verification evidence.
 *
 * Two tables share one argument grammar: TEST_CORES run tests and print a pass summary, so output can
 * corroborate them; SILENT_CORES (type checkers, linters, formatters in check mode, builds) report only through
 * their exit status and print little or nothing on success.
 */
// Argument tail: plain tokens or balanced quoted strings (`pytest -k "foo and bar"`); `$`, backticks and
// backslashes never appear inside it, so nothing in a quoted argument can expand or escape.
const ARG = String.raw`(?:\s+(?:[A-Za-z0-9_./:@+*?,=-]+|"[^"$\x60\\\r\n]*"|'[^'$\x60\\\r\n]*'))*`;
const PM_VALUE = String.raw`[A-Za-z0-9_./:@+*?,~^-]+`;
// Workspace / directory selection that may sit between a package manager and its script.
const PM_OPT = String.raw`(?:\s+(?:-r|--recursive|--workspaces|--silent|-s|--quiet|-q)|\s+(?:--filter|-F|--prefix|--cwd|-C|--workspace|-w|--dir)(?:=|\s+)${PM_VALUE})*`;
const PM = String.raw`(?:(?:bun|npm|pnpm|yarn)${PM_OPT}|yarn\s+workspace\s+[A-Za-z0-9_./@-]+)(?:\s+(?:run|exec|x|dlx))?${PM_OPT}`;
// make/just/rake/gradle/mvn take TARGETS (further commands), not script arguments: `make ci deploy` would run
// `deploy`. Their tails are therefore a closed grammar: any flag (judged by TASK_DENY below) together with the value a
// value-taking flag consumes, NAME=VALUE, and allow-listed targets. Any other bare token rejects the command.
const TARGETS = ["test", "tests", "check", "ci", "verify", "lint", "typecheck", "type-check", "vet", "clean", "build", "compile", "all", "unit", "integration", "e2e", "coverage", "format-check", "spec"];
const BUILD_TEST_TARGETS = ["test", "tests", "ci", "verify", "spec", "unit", "integration", "e2e", "coverage"];
const BUILD_SILENT_TARGETS = ["check", "lint", "typecheck", "type-check", "vet", "build", "compile", "format-check"];
// NAME=VALUE: never an update/snapshot/skip switch and never one of make's program-selecting variables.
const ASSIGN = String.raw`(?![A-Za-z0-9_]*(?:UPDATE|SNAPSHOT|GOLDEN|SKIP|IGNORE)[A-Za-z0-9_]*=)(?!(?:SHELL|MAKE|MAKEFLAGS|MAKEFILES)=)[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_./:@+,%=-]*`;
const TASK_VALUE = String.raw`[A-Za-z0-9_./:@+*?,~^#!%=-]`;
const QUOTED_VALUE = String.raw`(?:${TASK_VALUE}+|"[^"$\x60\\\r\n]*"|'[^'$\x60\\\r\n]*')`;
const DOTNET_PROJECT = String.raw`(?!-)[A-Za-z0-9_~-]*[./][A-Za-z0-9_./~-]*`;
interface TaskSpec {
  /** Flags that consume the next token (or `=value`) as their argument, as a regex alternation. */
  value: string;
  /** Flags whose argument is an OPTIONAL number (`make -j` vs `make -j 4`). */
  numeric?: string;
  /** Whether bare `NAME=VALUE` tokens are accepted (make, just, rake). */
  assign?: boolean;
  /** Whether targets may carry a Gradle project path (`:app:test`); only the LAST segment must be allow-listed. */
  path?: boolean;
  /** Value token shape; defaults to unquoted TASK_VALUE. */
  token?: string;
}
const MAKE_SPEC: TaskSpec = { value: "-C|--directory|-f|--file|--makefile|-I|--include-dir", numeric: "-j|--jobs|-l|--load-average|--max-load", assign: true };
const JUST_SPEC: TaskSpec = { value: "-f|--justfile|-d|--working-directory", assign: true };
const RAKE_SPEC: TaskSpec = { value: "-f|--rakefile|-I|--libdir|-R|--rakelibdir", numeric: "-j|--jobs", assign: true };
const GRADLE_SPEC: TaskSpec = { value: "-p|--project-dir|-b|--build-file|-c|--settings-file|-g|--gradle-user-home|--tests|--max-workers|--console|--warning-mode|--project-cache-dir", path: true };
const MVN_SPEC: TaskSpec = { value: "-pl|--projects|-f|--file|-T|--threads|-P|--activate-profiles|-s|--settings|-gs|--global-settings|-t|--toolchains|-rf|--resume-from|-l|--log-file" };
const DOTNET_SPEC: TaskSpec = { value: "-c|--configuration|-f|--framework|-v|--verbosity|-l|--logger|--filter|-r|--runtime|-a|--arch|--os|-s|--settings" };
/**
 * One flag token: a value-taking flag with its argument, an optional-number flag, any other `-x`/`--long[=v]` flag, or
 * (if enabled) NAME=VALUE. The generic alternative excludes the exact names handled by the first two, so every token
 * has ONE parse (`-C test` consumes `test` as the directory) and matching stays linear. Whether a flag is acceptable is
 * decided afterwards by TASK_DENY on the whole command, never by this grammar.
 */
function taskFlag(spec: TaskSpec): string {
  const token = QUOTED_VALUE;
  const names = spec.numeric ? `${spec.value}|${spec.numeric}` : spec.value;
  const alts = [
    String.raw`(?:${spec.value})(?:=|\s+)${token}`,
    String.raw`(?!(?:${names})(?=[=\s]|$))--?[A-Za-z][\w.:-]*(?:=${TASK_VALUE}*)?`,
  ];
  if (spec.numeric) alts.push(String.raw`(?:${spec.numeric})(?:(?:=|\s+)\d+(?:\.\d+)?)?`);
  if (spec.assign) alts.push(ASSIGN);
  return alts.join("|");
}
/**
 * `head (flag | non-primary target)* PRIMARY (flag | allow-listed target)*`. The leading run excludes the primary
 * targets so the split point is unique; every token after `head` must be a flag, NAME=VALUE or an allow-listed target.
 */
function taskCore(head: string, spec: TaskSpec, primary: readonly string[]): string {
  const flag = taskFlag(spec);
  const pre = spec.path ? String.raw`(?:(?!-)[\w.-]*:)*` : "";
  const rest = TARGETS.filter(target => !primary.includes(target)).join("|");
  return String.raw`${head}(?:\s+(?:${flag}|${pre}(?:${rest})))*\s+${pre}(?:${primary.join("|")})(?:\s+(?:${flag}|${pre}(?:${TARGETS.join("|")})))*`;
}
const PRETTIER = String.raw`(?:(?:npx|bunx)\s+|(?:pnpm|npm|yarn|bun)\s+(?:exec|x|dlx)\s+)?prettier`;
const TEST_CORES: readonly string[] = [
  String.raw`${PM}\s+(?:test|tests|spec|vitest|jest)(?::[\w-]+)?`,
  String.raw`(?:npx|bunx)\s+(?:vitest|jest|pytest)`,
  String.raw`(?:(?:npx|bunx)|(?:pnpm|npm|yarn|bun)\s+(?:exec|x|dlx))\s+playwright\s+test`,
  String.raw`(?:vitest|jest|pytest|phpunit|playwright\s+test)`,
  String.raw`(?:bundle\s+exec\s+)?rspec`,
  String.raw`(?:python(?:3(?:\.\d+)?)?|uv)\s+(?:(?:-m\s+)?pytest|-m\s+unittest)`,
  String.raw`node\s+--test`,
  String.raw`deno\s+test`,
  String.raw`cargo\s+test`,
  String.raw`go\s+test`,
];
const SILENT_CORES: readonly string[] = [
  String.raw`${PM}\s+(?:typecheck|lint|build|check|tsc|eslint)(?::[\w-]+)?`,
  String.raw`(?:npx|bunx)\s+(?:tsc|eslint)`,
  String.raw`(?:tsc|eslint|mypy|flake8|staticcheck|ruff\s+check|golangci-lint\s+run)`,
  String.raw`(?:python(?:3(?:\.\d+)?)?|uv)\s+-m\s+(?:py_compile|mypy|flake8|ruff\s+check)`,
  String.raw`node\s+(?:--check|-c)`,
  String.raw`deno\s+(?:check|lint)`,
  String.raw`cargo\s+(?:check|build|clippy)`,
  String.raw`cargo\s+fmt(?=(?:\s+\S+)*\s+--check(?:\s|$))`,
  String.raw`go\s+(?:vet|build)`,
  String.raw`${PRETTIER}(?=(?:\s+\S+)*\s+(?:--check|-c|--list-different|-l)(?:\s|$))`,
];
// Task-runner cores carry their own closed tail (see taskCore); VERIFY_SIGNAL_RE must not append ARG to them.
const STRICT_TEST_CORES: readonly string[] = [
  taskCore("make", MAKE_SPEC, BUILD_TEST_TARGETS),
  taskCore("just", JUST_SPEC, BUILD_TEST_TARGETS),
  taskCore(String.raw`(?:bundle\s+exec\s+)?rake`, RAKE_SPEC, ["test", "tests", "spec"]),
  taskCore("(?:gradle|gradlew)", GRADLE_SPEC, ["test"]),
  taskCore("(?:mvn|mvnw)", MVN_SPEC, ["test", "verify"]),
  String.raw`dotnet\s+test(?:\s+(?:${taskFlag(DOTNET_SPEC)}|${DOTNET_PROJECT}))*`,
];
const STRICT_SILENT_CORES: readonly string[] = [
  taskCore("make", MAKE_SPEC, BUILD_SILENT_TARGETS),
  taskCore("just", JUST_SPEC, BUILD_SILENT_TARGETS),
  taskCore("(?:gradle|gradlew)", GRADLE_SPEC, ["check", "build"]),
];
// Loose cores match case-insensitively; the task-runner cores stay case-sensitive because their flags differ by case
// (`mvn -B` batch vs `-b` builder, `-P` profile vs `-p`, `make -C` vs `-c`): `i` would let one swallow the target.
/** Anchored match of every recognized verifier core (test runners and silent checkers) with its tail. */
export const VERIFY_SIGNAL_RE = new RegExp(`^(?:(?i:${[...TEST_CORES, ...SILENT_CORES].join("|")})${ARG}|${[...STRICT_TEST_CORES, ...STRICT_SILENT_CORES].join("|")})$`);
/** Cores that run tests and print a pass summary: the only ones whose output can stand in for a trustworthy exit status. */
const TEST_CORE_RE = new RegExp(`^(?:(?i:${TEST_CORES.join("|")})${ARG}|${STRICT_TEST_CORES.join("|")})$`);
// `-x test` (gradle skip) and `-u` (jest update) are lowercase-only: mvn's `-X` (debug) and `-U` (update dependencies) are not them.
const NONEXECUTING_VERIFY_FLAG_RE = /(?:^|\s)(?:--help|-h|--version|-version|--list(?:-tests|Tests)?|-list|--collect-only|--co|--show-?config|--show-settings|--show-files|--init|--dry-run|--no-run|--passWithNoTests|--if-present|-DskipTests|-Dmaven\.test\.skip|-Dmaven\.test\.failure\.ignore|-Dtest\.failure\.ignore|-DfailIfNoTests|-Dsurefire\.failIfNoSpecifiedTests|(?-i:-x)\s+test)(?=$|\s|=)/i;
const MUTATING_VERIFY_FLAG_RE = /(?:^|\s)(?:--fix|--fix-only|--unsafe-fixes|--add-noqa|--install-types|-fix|--write|--update|(?-i:-u)|--update[-_]snapshots?|--updateSnapshots?|--snapshot[-_]updates?)(?=$|\s|=)/i;
// Judged on the first script token after any manager options, so `pnpm --filter web test:fix` is still caught.
const MUTATING_VERIFY_SCRIPT_RE = /^(?:bun|npm|pnpm|yarn)\b(?:\s+\S+)*?\s+[\w-]+:[^\s]*(?:fix|update|write|deploy|publish)[^\s]*/i;
// Any short-flag cluster containing `w` (`-w`, `-cw`, `-wc`) writes files; `--write` is caught by MUTATING_VERIFY_FLAG_RE.
const PRETTIER_WRITE_RE = new RegExp(String.raw`^${PRETTIER}\b.*(?:^|\s)-[A-Za-z]*w[A-Za-z]*(?=\s|$)`, "i");
// Per-tool flag deny-list, judged on the command text with quotes turned into spaces. The same letter means different
// things per tool (`-t` touches in make, selects toolchains in mvn; `-i` ignores errors in make, logs in gradle), so
// each tool has its own list. Denied: dry-run / listing / touch / "what if" modes and anything that skips tests, masks a
// failing exit status, or rewrites lock files. make/just/rake may bundle short flags (`-kn`), so those match clusters.
const PROP_DENY_RE = /(?:^|\s)(?:-D|-P|--define|--project-prop|--system-prop|--activate-profiles|-p:)\s*\S*?(?:skip|ignore|failure|dry.?run|update|snapshot|golden|exec=true)/i;
const TASK_DENY: readonly { head: RegExp; deny: readonly RegExp[] }[] = [
  { head: /^make\b/, deny: [/(?:^|\s)(?:-[A-Za-z]*[ntqiWo][A-Za-z]*|--(?:dry-run|just-print|recon|touch|question|what-if|new-file|assume-new|old-file|assume-old|ignore-errors|eval))(?=\s|=|$)/] },
  { head: /^just\b/, deny: [/(?:^|\s)(?:-[A-Za-z]*[nlse][A-Za-z]*|--(?:dry-run|list|show|evaluate|edit|init|dump|summary|choose|fmt|variables|changelog|completions|command))(?=\s|=|$)/] },
  { head: /^(?:bundle\s+exec\s+)?rake\b/, deny: [/(?:^|\s)(?:-[A-Za-z]*[nTPDWperEhHV][A-Za-z]*|--(?:dry-run|tasks|prereqs|describe|where|execute|execute-print|execute-continue|require|help|version))(?=\s|=|$)/] },
  { head: /^(?:gradle|gradlew)\b/, deny: [/(?:^|\s)(?:-[mta](?=\s|$)|-[xI]\S*|--(?:dry-run|exclude-task|continuous|init-script|scan|write-locks|update-locks|write-verification-metadata|refresh-dependencies|export-keys|no-rebuild)(?=\s|=|$))/, PROP_DENY_RE] },
  { head: /^(?:mvn|mvnw)\b/, deny: [/(?:^|\s)(?:-v|--version|-h|--help|-fn|--fail-never)(?=\s|=|$)/, PROP_DENY_RE] },
  { head: /^dotnet\b/, deny: [/(?:^|\s)(?:-t|--list-tests|-h|--help|-\?)(?=\s|=|$)/, PROP_DENY_RE] },
];

// ── Verifier command grammar ──────────────────────────────────────────────────
// The done-gate trusts the shell's exit status of a verifier. A form whose status is NOT the verifier's own can
// report success while the verifier failed, so it is "weak": it counts ONLY when the OUTPUT shows positive pass
// evidence AND no failure marker (see verificationProducedEvidence). Direct forms keep tool success + evidence.
//
// command    := "(" body ")" | body                       one outer subshell level, always weak; `2>&1` tokens removed
// body       := ( (set|cd) ";" )* [cdSeg "&&"] pipeline ( "&&" pipeline )* [ ("||" | ";") trailer ]
// pipeline   := verifierSeg ( "|" display )*              display := tail [-N | -n N] | tee [-a]   (never a file, never head)
// trailer    := true | ":" | echo <plain words>           echo only at the top level; its text must hold no digit/pass/ok/success
// verifierSeg:= prefix* core | (bash|sh|zsh|dash) -c "<body>"   nested -c is judged on the inner body, one level deep
// prefix     := `NAME=VALUE`, `env [-u NAME]... [NAME=VALUE]...`, `timeout N[s|m]`, `time [-p]`,
//               `uv|poetry|pipenv run`, `rtk [test]`      each propagates the verifier's exit status
// core       := first `/`-bearing token replaced by its basename, then VERIFY_SIGNAL_RE with no
//               non-executing / mutating flag, no mutating script, and no short no-op form.
// Weak = any pipe, `||`/`;` trailer, `set`/`cd ;` prefix or subshell. A weak form is recognized only when EVERY core
// is a test runner (TEST_CORE_RE): a silent linter has no output to corroborate it, and `grep`/`awk`/`sed`/`sort`/
// `cut`/`head` stages, `rm`, `git commit`, installers or any other command never qualify as display or trailer.
// make/just/rake/gradle/mvn/dotnet cores use a closed tail (see taskCore): any flag not on that tool's TASK_DENY list,
// its value, NAME=VALUE and allow-listed targets; any other bare target (deploy, install, publish, db:drop) rejects.
// Only plain tokens or balanced quotes are accepted: `$`, backticks, backslashes, redirections and grouping
// outside the single subshell are rejected before any stage is read.
const STDERR_MERGE_RE = /(^|\s)2>&1(?=\s|$)/g;
const ASSIGN_PREFIX_RE = /^([A-Za-z_][A-Za-z0-9_]*)=[A-Za-z0-9_./:@+,=%-]*\s+/;
const ENV_PREFIX_RE = /^env(?:\s+-u\s+[A-Za-z_][A-Za-z0-9_]*)*(?:\s+([A-Za-z_][A-Za-z0-9_]*)=[A-Za-z0-9_./:@+,=%-]*)*\s+/;
const TIMEOUT_PREFIX_RE = /^timeout\s+\d+[sm]?\s+/;
const RUNNER_PREFIX_RE = /^(?:uv|poetry|pipenv)\s+run\s+/;
const RTK_PREFIX_RE = /^rtk\s+(?:test\s+)?/;
const TIME_PREFIX_RE = /^time\s+(?:-p\s+)?/;
const CD_SEGMENT_RE = /^cd\s+(?:[A-Za-z0-9_./:@+,=~-]+|"[^"$`\\]*"|'[^'$`\\]*')$/;
const SET_STMT_RE = /^set(?:\s+(?:-[A-Za-z]+|-o\s+pipefail|pipefail))+$/;
const BINARY_PATH_RE = /^([A-Za-z0-9_.@+-]*\/[A-Za-z0-9_./@+-]*)(?=\s|$)/;
const SHELL_C_RE = /^(?:ba|z|da)?sh\s+(?:-o\s+pipefail\s+)?-[elux]*c\s+(?:"([^"]*)"|'([^']*)')$/;
// `head` is not display-only (it closes the pipe early, hiding a later failure) and `tee <file>` could overwrite a
// tracked file through a symlink: a verified call is never snapshot-bracketed, so that write would be invisible.
const DISPLAY_STAGE_RE = /^(?:tail(?:\s+(?:-\d+|-n\s*\d+))?|tee(?:\s+-a)?)$/;
/** Echo text that could read as a pass summary (or contains a count) is refused rather than discounted. */
const ECHO_PASSLIKE_RE = /\d|\bpass(?:ed|ing)?\b|\bok\b|success/i;
const TRAILER_RE = /^(?:true|:|echo((?:\s+(?:[A-Za-z0-9_.,:@%+=\/][A-Za-z0-9_.,:@%+=\/-]*|"[^"$`\\]*"|'[^'$`\\]*'))*))$/;
/** Env names that are the env-form of an update/snapshot flag (parity with MUTATING_VERIFY_FLAG_RE). */
const MUTATING_VERIFY_ENV_RE = /UPDATE|SNAPSHOT|GOLDEN/i;
const ENV_ASSIGNMENT_NAME_RE = /([A-Za-z_][A-Za-z0-9_]*)=/g;

/** Result of {@link parseVerifier}: the verifier invocations and how far the shell's exit status can be trusted. */
export interface VerifierParse {
  /** Normalized verifier invocations (wrapper prefixes, `cd`, pipes and trailers stripped). */
  cores: string[];
  /** True when the shell's exit status IS the verifier's own, so tool success is itself the pass signal. */
  trusted: boolean;
  /** Literal text a trailing `echo` prints; the evidence check discounts it so it cannot fake a pass line. */
  echoed: string | null;
}

interface Chain { cores: string[]; weak: boolean; echoed: string | null }

/**
 * Parse a command as a recognized verification, or null when it is not one. See the grammar above for what is
 * accepted and which forms are weak (`trusted: false`).
 */
export function parseVerifier(cmd: string): VerifierParse | null {
  let command = cmd.trim().replace(STDERR_MERGE_RE, "$1").trim();
  if (!command) return null;
  let wrapped = false;
  if (command.startsWith("(") && command.endsWith(")")) {
    command = command.slice(1, -1).trim();
    wrapped = true;
  }
  const chain = parseChain(command, false);
  if (!chain) return null;
  const weak = wrapped || chain.weak;
  if (weak && !chain.cores.every(core => TEST_CORE_RE.test(core))) return null;
  return { cores: chain.cores, trusted: !weak, echoed: chain.echoed };
}

/**
 * Normalized verifier invocations (cores) of a command, or null when the command is not a
 * recognized verification. Wrapper prefixes and a leading `cd <path> &&` are stripped,
 * so flag/script exclusions are judged on the verifier itself, never on the wrappers.
 */
export function verifierCores(cmd: string): string[] | null {
  return parseVerifier(cmd)?.cores ?? null;
}

/**
 * Split on top-level `&&`, `||`, `|` and `;` while leaving quoted text intact. Rejects anything that could change
 * what runs: expansion, escapes, newlines, redirections, grouping and a lone `&` outside quotes.
 */
function splitShell(command: string): { stages: string[]; ops: string[] } | null {
  const stages: string[] = [];
  const ops: string[] = [];
  let start = 0;
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "$" || ch === "`" || ch === "\\" || ch === "\n" || ch === "\r") return null;
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if ("<>(){}".includes(ch)) return null;
    let op: string;
    if (ch === "&") {
      if (command[i + 1] !== "&") return null;
      op = "&&";
    } else if (ch === "|") op = command[i + 1] === "|" ? "||" : "|";
    else if (ch === ";") op = ";";
    else continue;
    stages.push(command.slice(start, i).trim());
    ops.push(op);
    i += op.length - 1;
    start = i + 1;
  }
  if (quote) return null;
  stages.push(command.slice(start).trim());
  return stages.some(stage => !stage) ? null : { stages, ops };
}

function parseChain(command: string, nested: boolean): Chain | null {
  const shell = splitShell(command);
  if (!shell) return null;
  const { stages, ops } = shell;
  const last = stages.length - 1;
  let p = 0;
  let weak = false;
  // `set -e;` / `cd x;` change state only; they cannot mask the next command's status, but are not the verifier's own.
  while (p < last && ops[p] === ";" && (SET_STMT_RE.test(stages[p]) || CD_SEGMENT_RE.test(stages[p]))) { weak = true; p++; }
  if (p < last && ops[p] === "&&" && CD_SEGMENT_RE.test(stages[p])) p++;
  const cores: string[] = [];
  let echoed: string | null = null;
  for (;;) {
    const stage = parseStage(stages[p], nested);
    if (!stage) return null;
    cores.push(...stage.cores);
    if (stage.weak) weak = true;
    p++;
    while (p <= last && ops[p - 1] === "|") {
      if (!DISPLAY_STAGE_RE.test(stages[p])) return null;
      weak = true;
      p++;
    }
    if (p > last) break;
    if (ops[p - 1] === "&&") continue;
    // `||` or `;`: exactly one trailing stage that cannot run anything else.
    if (p !== last) return null;
    const trailer = TRAILER_RE.exec(stages[p]);
    if (!trailer) return null;
    if (trailer[1] !== undefined) {
      if (nested) return null; // only a top-level echo is the tail of the whole output, where it can be discounted
      echoed = [...trailer[1].matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(t => t[1] ?? t[2] ?? t[3]).join(" ");
      if (ECHO_PASSLIKE_RE.test(echoed)) return null;
    }
    weak = true;
    break;
  }
  return { cores, weak, echoed };
}

function parseStage(segment: string, nested: boolean): Chain | null {
  const rest = unwrap(segment);
  if (rest === null) return null;
  const shell = SHELL_C_RE.exec(rest);
  if (shell) return nested ? null : parseChain(shell[1] ?? shell[2], true);
  const core = verifierCore(rest);
  return core ? { cores: [core], weak: false, echoed: null } : null;
}

/** Strip exit-code-propagating wrapper prefixes and normalize a path-qualified binary; null on a mutating env. */
function unwrap(segment: string): string | null {
  let rest = segment;
  for (;;) { // terminates: every successful match strictly shortens `rest`
    const assign = ASSIGN_PREFIX_RE.exec(rest);
    if (assign) {
      if (MUTATING_VERIFY_ENV_RE.test(assign[1])) return null;
      rest = rest.slice(assign[0].length);
      continue;
    }
    const env = ENV_PREFIX_RE.exec(rest);
    if (env) {
      if ([...env[0].matchAll(ENV_ASSIGNMENT_NAME_RE)].some(m => MUTATING_VERIFY_ENV_RE.test(m[1]))) return null;
      rest = rest.slice(env[0].length);
      continue;
    }
    const other = TIMEOUT_PREFIX_RE.exec(rest) ?? RUNNER_PREFIX_RE.exec(rest) ?? RTK_PREFIX_RE.exec(rest) ?? TIME_PREFIX_RE.exec(rest);
    if (other) {
      rest = rest.slice(other[0].length);
      continue;
    }
    break;
  }
  const bin = BINARY_PATH_RE.exec(rest);
  return bin ? bin[1].slice(bin[1].lastIndexOf("/") + 1) + rest.slice(bin[1].length) : rest;
}

function verifierCore(rest: string): string | null {
  // Flag exclusions are judged with quote characters turned into spaces: `bun test "--update-snapshots"` must not hide
  // the flag behind a quote. A quoted `-k` expression that merely contains a flag-like word fails closed.
  const flat = rest.replace(/["']/g, " ");
  const shortNoOp = /^(?:(?:npx|bunx|bun|npm|pnpm|yarn)\s+(?:(?:run|exec|x|dlx)\s+)?)?tsc\b.*(?:^|\s)-[vV](?=\s|$)/.test(flat)
    || /^(?:make|just|go)\s+.*(?:^|\s)-n(?=\s|$)/.test(flat)
    || PRETTIER_WRITE_RE.test(flat);
  const task = TASK_DENY.find(entry => entry.head.test(rest));
  return !shortNoOp && VERIFY_SIGNAL_RE.test(rest) && !NONEXECUTING_VERIFY_FLAG_RE.test(flat)
    && !MUTATING_VERIFY_FLAG_RE.test(flat) && !MUTATING_VERIFY_SCRIPT_RE.test(flat)
    && !task?.deny.some(re => re.test(flat)) ? rest : null;
}

/**
 * True only when the command itself is a recognized verifier invocation (or a pure `&&`
 * chain of them, optionally led by `cd <path> &&` and wrapped in exit-code-propagating
 * prefixes — see {@link parseVerifier}, which also admits the weak forms). Output is never what
 * RECOGNIZES a command: arbitrary commands can print words such as "tests passed".
 */
export function isVerificationSignal(cmd: string): boolean {
  return parseVerifier(cmd) !== null;
}

// Output evidence. Every pattern is anchored to a summary position so a test TITLE cannot impersonate a summary.
const PASS_LINE_RES: readonly RegExp[] = [
  // bun "12 pass", mocha "12 passing", jest "Tests: 1 failed, 4 passed", vitest "Tests 5 passed", pytest "== 5 passed",
  // playwright "5 passed (3s)", deno "ok | 3 passed"
  /^[ \t=]*(?:ok[ \t]*\|[ \t]*)?(?:Tests?:?[ \t]+)?(?:\d+ [A-Za-z]+(?:[ \t]*[,|][ \t]*|[ \t]+))*[1-9]\d* pass(?:ed|ing)?\b/,
  /^\s*(?:\u2139|#)\s*pass\s+[1-9]\d*\b/, // node --test
  /^ok\s+\S+\s+(?:\(cached\)|[\d.]+s)/, // go (the `[no tests ...]` forms are excluded by the caller)
  /^\s*--- PASS:/, // go test -v
  /^\s*[1-9]\d* examples?, 0 failures?/, // rspec
  /Tests run:\s*[1-9]\d*,\s*Failures:\s*0,\s*Errors:\s*0/, // maven
  /^\s*Passed!.*\bPassed:\s*[1-9]\d*/, // dotnet
  /^OK \([1-9]\d* tests?,/, // phpunit
];
const FAILURE_LINE_RES: readonly RegExp[] = [
  /(?:^|[^\d])[1-9]\d*\s+(?:fail(?:ed|ing|ures?)?|errors?)\b/i,
  /\b(?:Failures|Errors|Failed):\s*[1-9]/,
  /^\s*\(fail\)/,
  /^\s*(?:FAIL|FAILED|ERROR)\b/,
  /^\s*--- FAIL/,
  /^\s*panic:|panicked at/,
  /test result: FAILED|\.\.\. FAILED\b|^failures:\s*$/, // cargo
  /^\s*error: .*(?:target|test).*failed|\bcould not compile\b/i, // cargo: the FAILED line can scroll out of a `tail` window
  /^\[ERROR\]|BUILD (?:FAILED|FAILURE)|^FAILURE:/, // maven / gradle
  /Tests run:.*(?:Failures|Errors): [1-9]/, // maven
  /\b(?:ERRORS|FAILURES)!/, // phpunit
  /^\s*Failed!/, // dotnet
  /^\s*(?:\u2139|#)\s*fail\s+[1-9]/,
  /\bSegmentation fault\b|\bBus error\b|\bKilled\b|\btimed out\b/,
  /\berror TS\d+/,
];
/** A line a runner prints for a test that PASSED: its title may legitimately mention "errors" or "failed". */
const PASSED_TITLE_RE = /^\s*(?:\((?:pass|skip|todo)\)|[\u2713\u2714\u221a])/;
/** Explicit "nothing ran" output; only consulted when no positive pass summary is present. */
const NO_TESTS_RE = /(?:^|[^\d])0 pass(?:ed|ing)?\b|(?:^|[^\d])0 examples?\b|\bno tests? (?:ran|found|to run|executed)\b|\bno test files found\b|\bNo test is available\b|\bcollected 0 items\b|\bRan 0 tests\b|\bTests run:\s*0\b|(?:\u2139|#)\s*pass\s+0\b/i;
const ANSI_RE = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;

function hasPassSummary(text: string): boolean {
  if (/\bBUILD SUCCESSFUL\b/.test(text) && !/\bNO-SOURCE\b/.test(text)) return true; // gradle prints no counts
  if (/test result: ok\.\s+[1-9]\d* passed/.test(text)) return true;
  return text.split(/\r?\n/).some(line => PASS_LINE_RES.some(re => re.test(line)) && !/\[no tests to run\]|\[no test files\]/i.test(line));
}

/**
 * Drop the text a trailing `echo` printed so it cannot supply (or hide) a pass line. The bash tool joins stdout then
 * stderr, so the echo can sit mid-output: every whole-line occurrence goes, and so does a glued trailing suffix.
 */
function withoutEchoText(text: string, echoed: string | null): string {
  if (!echoed) return text;
  const kept = text.split(/\r?\n/).filter(line => line.trim() !== echoed).join("\n");
  const trimmed = kept.trimEnd();
  return trimmed.endsWith(echoed) ? trimmed.slice(0, trimmed.length - echoed.length) : kept;
}

/**
 * Output-side judgment of a verifier run the caller already knows succeeded (exit 0).
 * - Go and Cargo need real test-run evidence, judged on the verifier cores so a wrapped
 *   `timeout 60 go test ./...` or `cd x && cargo test` still needs it.
 * - A direct test runner whose output says nothing ran (`0 pass`, "no tests ran") is not evidence unless a positive
 *   pass summary is also present; silent linters and empty output stay evidence on tool success alone.
 * - A weak form (see the grammar above) has no trustworthy exit status: it needs a positive pass summary and no
 *   failure marker anywhere in the output.
 */
export function verificationProducedEvidence(cmd: string, output: string): boolean {
  const parsed = parseVerifier(cmd);
  const cores = parsed?.cores ?? [cmd.trim()];
  const text = withoutEchoText(output.replace(ANSI_RE, ""), parsed?.echoed ?? null);
  if (cores.some(c => /^go\s+test(?:\s|$)/.test(c))) {
    const summaries = text.split(/\r?\n/).filter(line => /^(?:ok|\?)\s+/.test(line));
    if (!summaries.some(line => !/\[no tests to run\]|\[no test files\]/i.test(line))) return false;
  }
  if (cores.some(c => /^cargo\s+test(?:\s|$)/.test(c))
    && ![...text.matchAll(/test result: ok\.\s+(\d+) passed/g)].some(match => Number(match[1]) > 0)) return false;
  if (!parsed) return true;
  if (!parsed.trusted) {
    const failed = text.split(/\r?\n/).some(line => !PASSED_TITLE_RE.test(line) && FAILURE_LINE_RES.some(re => re.test(line)));
    return hasPassSummary(text) && !failed;
  }
  return !(cores.some(c => TEST_CORE_RE.test(c)) && !hasPassSummary(text) && NO_TESTS_RE.test(text));
}

/** Marker that prefixes a candidate answer the completion gate never accepted. */
export const UNVERIFIED_MARKER = "UNVERIFIED";

/**
 * Result text when completion was rejected GUARD_LIMITS.MAX_DONE_CORRECTIONS times. Keeps the
 * model's last candidate answer, never presents it as accepted, and keeps the gate reason.
 */
export function formatRejectedCompletion(candidate: string, corrections: number, rejection: string): string {
  const stop = `Stopped: completion rejected after ${corrections} correction${corrections === 1 ? "" : "s"}. ${rejection}`;
  const answer = candidate.trim();
  if (!answer) return stop;
  return `${UNVERIFIED_MARKER} - the completion gate did not accept this answer; treat it as unconfirmed.\n\n${answer}\n\n${stop}`;
}

/**
 * Result-aware repeat nudge: tells the model WHY repeating the call won't help and what
 * to try instead, tailored to the repeated tool and its last actual result. When the
 * previous attempt FAILED, prepend a reflection directive so the model extracts the
 * lesson and changes tool/arguments instead of retrying the same failing call unchanged.
 */
export function repeatHint(tool: string, prev?: { success: boolean; output: string }): string {
  const out = prev?.output ?? "";
  const empty = !prev || !prev.success || out.trim() === "" || /no match|0 match|no result|not found|no file/i.test(out);
  const failed = prev !== undefined && !prev.success;
  const reflect = failed
    ? "The previous attempt FAILED — don't retry it unchanged; state what its result tells you, then change the tool or its arguments. "
    : "";
  let base: string;
  if (tool === "search" || tool === "find" || tool === "ls") {
    base = empty
      ? `That '${tool}' returned nothing useful and will again — BROADEN it (a looser pattern, a parent directory, or a different tool such as ${tool === "search" ? "find" : "search"}), or call done if this lookup isn't needed.`
      : `That '${tool}' already returned results — open one of the hits with read, or move on; re-running it changes nothing.`;
  } else if (tool === "read") {
    base = `You already read that and its content is unchanged — use what you read, or read a DIFFERENT file.`;
  } else if (tool === "bash") {
    base = `That command already ran with the same output — change the command, or call done.`;
  } else {
    base = `That call's result is unchanged — take a different action, or call done.`;
  }
  return reflect + base;
}

/** Inputs for the done-verification gate. */
export interface DoneGateInput {
  /** A write/edit succeeded this turn. */
  sawMutation: boolean;
  /** The most recent recognized test/build/typecheck/lint command succeeded. */
  sawVerification: boolean;
  /**
   * A mutation landed AFTER the most recent successful verification — so the
   * passing test/build no longer reflects the current tree. Optional; defaults
   * to false, in which case the gate uses the order-insensitive `sawVerification`.
   */
  verificationStale?: boolean;
  /** The run-command of the most recent still-failing post-turn hook, or null. */
  pendingHookFailure: string | null;
  /**
   * Why the host could not measure a shell call's effect on the workspace this turn (snapshot cap or
   * error), when that happened. Such a call is counted as a possible mutation, so the gate says why
   * instead of claiming files were modified.
   */
  unmeasured?: string;
  /**
   * Paths a shell call's before/after snapshot saw change (`modified a.json; added b.txt`), when the evidence
   * came from a shell bracket. Lets the model and user judge whether the command or an unrelated process wrote them.
   */
  shellChanged?: string;
}

/** Verdict from {@link classifyDoneGate}: whether to bounce `done`, and the message. */
export interface DoneGateVerdict {
  state: Extract<GuardState, "done_ok" | "done_unverified" | "done_stale_verification" | "done_hook_failing">;
  /** When true, completion must remain blocked until the condition is resolved. */
  block: boolean;
  /** Corrective message to push back on `done`; empty when `state === "done_ok"`. */
  message: string;
}

/**
 * Classify whether a `done` should be accepted or bounced.
 *
 * A turn that MUTATED files remains blocked while verification is missing/failed,
 * STALE (a passing run predates the last edit), or a post-turn hook is still failing.
 * The caller bounds corrective retries without converting rejection into success.
 */
export function classifyDoneGate(input: DoneGateInput): DoneGateVerdict {
  const hookFailing = input.pendingHookFailure !== null;
  const stale = input.sawVerification && input.verificationStale === true;
  const block = input.sawMutation && (!input.sawVerification || stale || hookFailing);
  if (!block) return { state: "done_ok", block: false, message: "" };
  // A reply alone never clears this gate: only a passing verification does, or the budget running out.
  const escape = "Only a passing verification command clears this check; if none applies, the answer is returned labelled UNVERIFIED once the correction budget is spent.";
  const changedNote = input.shellChanged
    ? ` Note: around a shell/computer call the host saw these paths change: ${input.shellChanged}. ` +
      `Something other than your commands may have written them (another process, or your own background job). ${escape}`
    : "";
  const unmeasuredNote = changedNote + (input.unmeasured
    ? ` Note: the host could not measure a shell/computer call's effect on the workspace (${input.unmeasured}), so it is counted as a possible file change. ${escape}`
    : "");
  if (hookFailing) {
    return {
      state: "done_hook_failing",
      block: true,
      message:
        `Your latest mutation left the post-turn hook "${input.pendingHookFailure}" FAILING (non-zero exit) — its diagnostics were shown in the tool result above. ` +
        "Fix the reported problems (the hook re-runs on your next mutation), then call done.",
    };
  }
  if (stale) {
    return {
      state: "done_stale_verification",
      block: true,
      message:
        "You verified earlier, but then modified files again — your last passing test/build no longer reflects the current tree. " +
        "Re-run the narrowest verification command against the latest changes (e.g. a standalone bash call such as 'bun test', 'bun run typecheck', 'tsc --noEmit', 'npm test', 'pytest', 'cargo test', or 'go test ./...'), then call done." +
        unmeasuredNote,
    };
  }
  return {
    state: "done_unverified",
    block: true,
    message:
      "You modified files this turn but have no passing verification (no test/build/typecheck command succeeded, or the latest recognized verification failed). " +
      "Run the narrowest command that proves your change works (e.g. a standalone bash call such as 'bun test', 'bun run typecheck', 'tsc --noEmit', 'npm test', 'pytest', 'cargo test', or 'go test ./...'), then call done." +
      unmeasuredNote,
  };
}
