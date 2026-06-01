#!/usr/bin/env bun
/**
 * jeo-ledger — cross-plan append-only ledger for the jeo-line workflow
 * (ledger / review / cleanup) layered over gajae-code.
 *
 * Design (see ../ledger/schema.md):
 *  - Events are appended to .jeo/ledger.jsonl, one JSON object per line.
 *  - State is ALWAYS derived by folding the event log; the log is the source of truth.
 *  - Zero external dependencies: Node/Bun stdlib only.
 *
 * Usage:
 *   bun jeo-ledger.ts init
 *   bun jeo-ledger.ts register <planId> --title "..." [--brief "..."]
 *   bun jeo-ledger.ts review   <planId> --status CLEAR|WATCH|BLOCK --evidence "..."
 *   bun jeo-ledger.ts checkpoint <planId> --goal <goalId> --status complete|failed --evidence "..."
 *   bun jeo-ledger.ts sweep    <planId> --evidence "..."
 *   bun jeo-ledger.ts link     <planId> --pr <url>
 *   bun jeo-ledger.ts status   [--json]
 */

import * as fs from "node:fs";
import * as path from "node:path";

const JEO_DIR = ".jeo";
const LEDGER = path.join(JEO_DIR, "ledger.jsonl");

type EventType =
  | "plan_registered"
  | "plan_reviewed"
  | "goal_checkpointed"
  | "cleanup_swept"
  | "pr_linked";

interface LedgerEvent {
  ts: string;
  type: EventType;
  planId: string;
  [k: string]: unknown;
}

const REVIEW_STATUSES = ["CLEAR", "WATCH", "BLOCK"] as const;
const CHECKPOINT_STATUSES = ["complete", "failed"] as const;

function die(msg: string): never {
  console.error(`jeo: ${msg}`);
  process.exit(1);
}

function ensureInit(): void {
  if (!fs.existsSync(LEDGER)) {
    die(`no ledger found at ${LEDGER} — run: jeo init`);
  }
}

function append(ev: Omit<LedgerEvent, "ts">): LedgerEvent {
  ensureInit();
  const full: LedgerEvent = { ts: new Date().toISOString(), ...ev };
  fs.appendFileSync(LEDGER, JSON.stringify(full) + "\n");
  return full;
}

function readEvents(): LedgerEvent[] {
  if (!fs.existsSync(LEDGER)) return [];
  return fs
    .readFileSync(LEDGER, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l, i) => {
      try {
        return JSON.parse(l) as LedgerEvent;
      } catch {
        die(`corrupt ledger line ${i + 1}`);
      }
    });
}

/** Parse `--flag value` pairs and bare positionals from argv slice. */
function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = "true";
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function requirePlanId(positionals: string[]): string {
  const id = positionals[0];
  if (!id) die("missing <planId>");
  return id;
}

interface PlanState {
  planId: string;
  title: string;
  brief?: string;
  registeredAt?: string;
  review?: { status: string; evidence: string; at: string };
  goals: Record<string, { status: string; evidence: string; at: string }>;
  swept: { evidence: string; at: string }[];
  prs: string[];
}

function deriveState(events: LedgerEvent[]): Record<string, PlanState> {
  const plans: Record<string, PlanState> = {};
  const ensure = (id: string): PlanState => {
    if (!plans[id]) {
      plans[id] = { planId: id, title: id, goals: {}, swept: [], prs: [] };
    }
    return plans[id];
  };
  for (const ev of events) {
    const p = ensure(ev.planId);
    switch (ev.type) {
      case "plan_registered":
        p.title = (ev.title as string) ?? id_fallback(ev.planId);
        if (ev.brief) p.brief = ev.brief as string;
        p.registeredAt = ev.ts;
        break;
      case "plan_reviewed":
        p.review = { status: ev.status as string, evidence: (ev.evidence as string) ?? "", at: ev.ts };
        break;
      case "goal_checkpointed":
        p.goals[ev.goal as string] = {
          status: ev.status as string,
          evidence: (ev.evidence as string) ?? "",
          at: ev.ts,
        };
        break;
      case "cleanup_swept":
        p.swept.push({ evidence: (ev.evidence as string) ?? "", at: ev.ts });
        break;
      case "pr_linked":
        if (ev.pr) p.prs.push(ev.pr as string);
        break;
    }
  }
  return plans;
}

function id_fallback(id: string): string {
  return id;
}

/** A plan is "verified" when reviewed CLEAR, all goals complete, and swept at least once. */
function planVerdict(p: PlanState): string {
  const goalList = Object.values(p.goals);
  const allComplete = goalList.length > 0 && goalList.every((g) => g.status === "complete");
  const reviewClear = p.review?.status === "CLEAR";
  const swept = p.swept.length > 0;
  if (reviewClear && allComplete && swept) return "verified";
  if (p.review?.status === "BLOCK") return "blocked";
  if (goalList.some((g) => g.status === "failed")) return "failed";
  return "in_progress";
}

function cmdInit(): void {
  fs.mkdirSync(JEO_DIR, { recursive: true });
  if (!fs.existsSync(LEDGER)) {
    fs.writeFileSync(LEDGER, "");
    console.log(`jeo: initialized ${LEDGER}`);
  } else {
    console.log(`jeo: ledger already exists at ${LEDGER}`);
  }
}

function cmdStatus(flags: Record<string, string>): void {
  const plans = deriveState(readEvents());
  const list = Object.values(plans).map((p) => ({
    planId: p.planId,
    title: p.title,
    verdict: planVerdict(p),
    review: p.review?.status ?? "none",
    goals: Object.fromEntries(Object.entries(p.goals).map(([g, v]) => [g, v.status])),
    sweeps: p.swept.length,
    prs: p.prs,
  }));
  if (flags.json === "true") {
    console.log(JSON.stringify({ plans: list }, null, 2));
    return;
  }
  if (list.length === 0) {
    console.log("jeo: no plans registered yet");
    return;
  }
  console.log("jeo ledger status\n");
  for (const p of list) {
    const goalStr =
      Object.keys(p.goals).length === 0
        ? "—"
        : Object.entries(p.goals)
            .map(([g, s]) => `${g}:${s}`)
            .join(" ");
    console.log(`● ${p.planId}  [${p.verdict}]  ${p.title}`);
    console.log(`    review=${p.review}  goals=${goalStr}  sweeps=${p.sweeps}  prs=${p.prs.length}`);
  }
}

function main(): void {
  const [, , cmd, ...rest] = process.argv;
  const { positionals, flags } = parseArgs(rest);

  switch (cmd) {
    case "init":
      cmdInit();
      break;
    case "register": {
      const planId = requirePlanId(positionals);
      const ev = append({
        type: "plan_registered",
        planId,
        title: flags.title ?? planId,
        ...(flags.brief ? { brief: flags.brief } : {}),
      });
      console.log(`jeo: registered ${planId} @ ${ev.ts}`);
      break;
    }
    case "review": {
      const planId = requirePlanId(positionals);
      const status = (flags.status ?? "").toUpperCase();
      if (!REVIEW_STATUSES.includes(status as (typeof REVIEW_STATUSES)[number])) {
        die(`--status must be one of ${REVIEW_STATUSES.join("|")}`);
      }
      if (!flags.evidence) die("review requires --evidence");
      append({ type: "plan_reviewed", planId, status, evidence: flags.evidence });
      console.log(`jeo: reviewed ${planId} = ${status}`);
      break;
    }
    case "checkpoint": {
      const planId = requirePlanId(positionals);
      const status = (flags.status ?? "").toLowerCase();
      if (!CHECKPOINT_STATUSES.includes(status as (typeof CHECKPOINT_STATUSES)[number])) {
        die(`--status must be one of ${CHECKPOINT_STATUSES.join("|")}`);
      }
      if (!flags.goal) die("checkpoint requires --goal");
      if (!flags.evidence) die("checkpoint requires --evidence");
      append({ type: "goal_checkpointed", planId, goal: flags.goal, status, evidence: flags.evidence });
      console.log(`jeo: checkpoint ${planId}/${flags.goal} = ${status}`);
      break;
    }
    case "sweep": {
      const planId = requirePlanId(positionals);
      if (!flags.evidence) die("sweep requires --evidence");
      append({ type: "cleanup_swept", planId, evidence: flags.evidence });
      console.log(`jeo: swept ${planId}`);
      break;
    }
    case "link": {
      const planId = requirePlanId(positionals);
      if (!flags.pr) die("link requires --pr");
      append({ type: "pr_linked", planId, pr: flags.pr });
      console.log(`jeo: linked ${flags.pr} to ${planId}`);
      break;
    }
    case "status":
      cmdStatus(flags);
      break;
    case undefined:
    case "help":
    case "--help":
      console.log(
        [
          "jeo-ledger — cross-plan append-only ledger (ledger/review/cleanup)",
          "",
          "Commands:",
          "  init",
          "  register <planId> --title <t> [--brief <b>]",
          "  review <planId> --status CLEAR|WATCH|BLOCK --evidence <e>",
          "  checkpoint <planId> --goal <id> --status complete|failed --evidence <e>",
          "  sweep <planId> --evidence <e>",
          "  link <planId> --pr <url>",
          "  status [--json]",
        ].join("\n"),
      );
      break;
    default:
      die(`unknown command: ${cmd} (try: help)`);
  }
}

main();
