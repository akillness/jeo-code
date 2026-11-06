/**
 * Intermediate-judgment guards for the agent loop — the mid-run "should this turn
 * continue, correct itself, or stop" decisions that run between model calls.
 *
 * gjc keeps this concern in its own layer: `gjc-runtime/ultragoal-guard.ts` computes a
 * named `UltragoalGuardState` discriminated union PURELY, and the runtime merely acts on
 * the verdict. jeo previously inlined the same logic inside `engine.ts`'s `while` loop as
 * scattered booleans and message strings. This module gives jeo the same classification:
 * a named `GuardState` taxonomy plus pure, independently-testable classifier functions.
 * `engine.ts` still owns the control flow (history mutation, `step++`, `continue`,
 * `return finish(...)`) — only the JUDGMENT moves here, so behavior is unchanged.
 */

/**
 * Named taxonomy of the loop's intermediate judgments — jeo's descendant of gjc's
 * `UltragoalGuardState`. Each member names one decision the loop can reach mid-turn.
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
export const GUARD_LIMITS = Object.freeze({
  /** Identical step repeats tolerated before a consolidated stop (with corrections en route). */
  MAX_REPEAT: 4,
  /** Consecutive different-but-failing steps before the turn stops. */
  MAX_FAILURES: 5,
  /** Rejected completion attempts that may request a correction before stopping incomplete. */
  MAX_DONE_CORRECTIONS: 3,
  /** Context-mutating refusal-ladder rungs (resend → reset → guidance strip) before
   *  recovery switches to unbounded backoff resends (gjc parity: never terminal). */
  MAX_REFUSAL_RETRIES: 3,
  /** First post-ladder refusal backoff wait (ms); doubles per attempt (gjc retry.baseDelayMs). */
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
 */
export const VERIFY_SIGNAL_RE = /^(?:(?:bun|npm|pnpm|yarn)\s+(?:(?:run|exec|x|dlx)\s+)?(?:test|tests|typecheck|lint|build|check|spec|tsc|eslint|vitest|jest)(?::[\w-]+)?|(?:npx|bunx)\s+(?:tsc|eslint|vitest|jest|pytest)|(?:tsc|eslint|vitest|jest|pytest)|(?:python(?:3(?:\.\d+)?)?|uv)\s+(?:(?:-m\s+)?pytest|-m\s+(?:unittest|py_compile|mypy|flake8|ruff\s+check))|node\s+(?:--test|--check|-c)|deno\s+(?:test|check|lint)|cargo\s+(?:test|check|build|clippy)|go\s+(?:test|vet|build)|(?:make|just)\s+(?:test|check|lint|build|typecheck))(?:\s+[A-Za-z0-9_./:@+*?,=-]+)*$/i;
const NONEXECUTING_VERIFY_FLAG_RE = /(?:^|\s)(?:--help|-h|--version|-version|--list(?:-tests|Tests)?|-list|--collect-only|--co|--show-?config|--init|--dry-run|--no-run|--passWithNoTests|--if-present)(?=$|\s|=)/i;
const MUTATING_VERIFY_FLAG_RE = /(?:^|\s)(?:--fix|--write|--update|-u|--update[-_]snapshots?|--updateSnapshots?|--snapshot[-_]updates?)(?=$|\s|=)/i;
const MUTATING_VERIFY_SCRIPT_RE = /^(?:bun|npm|pnpm|yarn)\s+(?:(?:run|exec|x|dlx)\s+)?[\w-]+:[^\s]*(?:fix|update|write|deploy|publish)[^\s]*/i;

// ── Verifier command grammar ──────────────────────────────────────────────────
// command    := segment ( "&&" segment )*   after removing every standalone `2>&1` token
// segment[0] := cdSeg | verifierSeg         cdSeg only as the first segment, and only when >=1 segment follows
// segment[i] := verifierSeg                 (i >= 1)
// verifierSeg:= prefix* core                prefixes: `NAME=VALUE`, `env [-u NAME]... [NAME=VALUE]...`,
//                                           `timeout N[s|m]`, `uv|poetry|pipenv run`, `rtk [test]`
// core       := first `/`-bearing token replaced by its basename, then VERIFY_SIGNAL_RE with no
//               non-executing / mutating flag, no mutating script, and no short no-op form.
// Only plain tokens are accepted: `$`, backticks, quotes and parentheses never match the token classes
// and are rejected by the global metacharacter check. Every prefix propagates the verifier's exit code.
const STDERR_MERGE_RE = /(^|\s)2>&1(?=\s|$)/g;
const ASSIGN_PREFIX_RE = /^([A-Za-z_][A-Za-z0-9_]*)=[A-Za-z0-9_./:@+,=%-]*\s+/;
const ENV_PREFIX_RE = /^env(?:\s+-u\s+[A-Za-z_][A-Za-z0-9_]*)*(?:\s+([A-Za-z_][A-Za-z0-9_]*)=[A-Za-z0-9_./:@+,=%-]*)*\s+/;
const TIMEOUT_PREFIX_RE = /^timeout\s+\d+[sm]?\s+/;
const RUNNER_PREFIX_RE = /^(?:uv|poetry|pipenv)\s+run\s+/;
const RTK_PREFIX_RE = /^rtk\s+(?:test\s+)?/;
const CD_SEGMENT_RE = /^cd\s+[A-Za-z0-9_./:@+,=~-]+$/;
const BINARY_PATH_RE = /^([A-Za-z0-9_.@+-]*\/[A-Za-z0-9_./@+-]*)(?=\s|$)/;
/** Env names that are the env-form of an update/snapshot flag (parity with MUTATING_VERIFY_FLAG_RE). */
const MUTATING_VERIFY_ENV_RE = /UPDATE|SNAPSHOT|GOLDEN/i;
const ENV_ASSIGNMENT_NAME_RE = /([A-Za-z_][A-Za-z0-9_]*)=/g;

/**
 * Normalized verifier invocations (cores) of a command, or null when the command is not a
 * pure recognized verification. Wrapper prefixes and a leading `cd <path> &&` are stripped,
 * so flag/script exclusions are judged on the verifier itself, never on the wrappers.
 */
export function verifierCores(cmd: string): string[] | null {
  const command = cmd.trim().replace(STDERR_MERGE_RE, "$1").trim();
  if (!command) return null;
  // Pipes, `;`, `||`, redirections, substitution, grouping and multi-line scripts.
  if (/[;&|<>`$(){}\n\r]/.test(command.replace(/&&/g, " "))) return null;
  const segments = command.split("&&").map(s => s.trim());
  if (segments.some(s => !s)) return null;
  const start = segments.length > 1 && CD_SEGMENT_RE.test(segments[0]) ? 1 : 0;
  const cores: string[] = [];
  for (const segment of segments.slice(start)) {
    const core = verifierCore(segment);
    if (!core) return null;
    cores.push(core);
  }
  return cores.length ? cores : null;
}

function verifierCore(segment: string): string | null {
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
    const other = TIMEOUT_PREFIX_RE.exec(rest) ?? RUNNER_PREFIX_RE.exec(rest) ?? RTK_PREFIX_RE.exec(rest);
    if (other) {
      rest = rest.slice(other[0].length);
      continue;
    }
    break;
  }
  const bin = BINARY_PATH_RE.exec(rest);
  if (bin) rest = bin[1].slice(bin[1].lastIndexOf("/") + 1) + rest.slice(bin[1].length);
  const shortNoOp = /^(?:(?:npx|bunx|bun|npm|pnpm|yarn)\s+(?:(?:run|exec|x|dlx)\s+)?)?tsc\b.*(?:^|\s)-[vV](?=\s|$)/.test(rest)
    || /^(?:make|just|go)\s+.*(?:^|\s)-n(?=\s|$)/.test(rest);
  return !shortNoOp && VERIFY_SIGNAL_RE.test(rest) && !NONEXECUTING_VERIFY_FLAG_RE.test(rest)
    && !MUTATING_VERIFY_FLAG_RE.test(rest) && !MUTATING_VERIFY_SCRIPT_RE.test(rest) ? rest : null;
}

/**
 * True only when the command itself is a recognized verifier invocation (or a pure `&&`
 * chain of them, optionally led by `cd <path> &&` and wrapped in exit-code-propagating
 * prefixes — see {@link verifierCores}). Output is never evidence: arbitrary commands can
 * print words such as "tests passed".
 */
export function isVerificationSignal(cmd: string): boolean {
  return verifierCores(cmd) !== null;
}

/**
 * Require test-run evidence for Go and Cargo's recognized text output. Judged on the
 * verifier cores, so a wrapped `timeout 60 go test ./...` or `cd x && cargo test` still
 * needs real test evidence.
 */
export function verificationProducedEvidence(cmd: string, output: string): boolean {
  const cores = verifierCores(cmd) ?? [cmd.trim()];
  if (cores.some(c => /^go\s+test(?:\s|$)/.test(c))) {
    const summaries = output.split(/\r?\n/).filter(line => /^(?:ok|\?)\s+/.test(line));
    if (!summaries.some(line => !/\[no tests to run\]|\[no test files\]/i.test(line))) return false;
  }
  if (cores.some(c => /^cargo\s+test(?:\s|$)/.test(c))
    && ![...output.matchAll(/test result: ok\.\s+(\d+) passed/g)].some(match => Number(match[1]) > 0)) return false;
  return true;
}

/** Marker that prefixes a candidate answer the completion gate never accepted. */
export const UNVERIFIED_MARKER = "UNVERIFIED";

/**
 * Result text when completion was rejected GUARD_LIMITS.MAX_DONE_CORRECTIONS times. Keeps the
 * model's last candidate answer, never presents it as accepted, and keeps the gate reason.
 */
export function formatRejectedCompletion(candidate: string, corrections: number, rejection: string): string {
  const stop = `Stopped: completion rejected after ${corrections} corrections. ${rejection}`;
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

/** Inputs for the done-verification gate (jeo's descendant of gjc's ultragoal-guard). */
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
 * Classify whether a `done` should be accepted or bounced — the direct descendant of
 * gjc's `ultragoal-guard` completion gate (plan/gjc-inheritance.md B4).
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
  const unmeasuredNote = input.unmeasured
    ? ` Note: the host could not measure a shell call's effect on the workspace (${input.unmeasured}), so it is counted as a possible file change; ` +
      "if every command you ran was read-only, say so in your reply."
    : "";
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
