/**
 * Shared plan-document schema + minimal YAML parser for jeo workflow plans.
 * Used by both `jeo team` (execution) and `jeo ralplan` (plan generation/validation).
 */
import { z } from "zod";

/** Dependency-shaped keys the SERIAL executor cannot honor: `jeo team` runs steps
 *  in array order, so a plan that EXPRESSES ordering constraints must fail loudly
 *  instead of silently creating the illusion they are enforced (round-10 LOW). */
const UNSUPPORTED_DEP_KEYS = ["depends_on", "dependsOn", "after", "needs", "requires", "dependencies"] as const;

export const StepSchema = z.object({
  name: z.string(),
  /** Optional subagent role for this step (executor/planner/architect/critic). */
  role: z.string().optional(),
  /** Optional opt-in marker for a CONTIGUOUS run of steps `jeo team` may execute
   *  concurrently (git-worktree isolated) instead of strictly serially. Steps
   *  sharing the same non-empty value must be mutually consecutive — validated
   *  on `PlanSchema` below, since contiguity is a plan-wide property. */
  parallel_group: z.string().optional(),
}).passthrough().superRefine((step, ctx) => {
  for (const key of UNSUPPORTED_DEP_KEYS) {
    if (key in step) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `step "${String((step as Record<string, unknown>).name ?? "?")}" declares "${key}", but jeo team executes steps strictly in array order and does NOT honor dependency metadata — reorder the steps array instead and remove "${key}".`,
      });
    }
  }
});

export const PlanSchema = z.object({
  name: z.string().optional(),
  steps: z.array(StepSchema).min(1),
}).passthrough().superRefine((plan, ctx) => {
  // `parallel_group` steps must form a CONTIGUOUS run: once a group value is
  // seen and then interrupted by a different (or absent) group, that value must
  // never reappear later — `jeo team` dispatches a group as one concurrent batch
  // located at a single position in the array, so a split group has no coherent
  // execution position.
  const closedGroups = new Set<string>();
  let prevGroup: string | undefined;
  for (const step of plan.steps) {
    const group = step.parallel_group?.trim() || undefined;
    if (group && group !== prevGroup && closedGroups.has(group)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `plan step "${step.name}" reuses parallel_group "${group}" after a non-"${group}" step interrupted it — parallel_group steps must be contiguous.`,
      });
    }
    if (prevGroup !== undefined && prevGroup !== group) {
      closedGroups.add(prevGroup);
    }
    prevGroup = group;
  }

  // Maker -> verifier ORDERING (not mere presence): a plan containing any
  // mutating work must have a DEDICATED architect/critic step AFTER the last
  // such mutation, or `jeo team` never runs an independent, evidence-grounded
  // gate over what was actually changed (team.ts's parseRoleGateVerdict is
  // fail-closed and genuinely reads real files — but only fires for a step
  // that HAS an architect/critic role in the right position; nothing before
  // this rule required the plan to include one at all, or forbade a verifier
  // sitting BEFORE the mutations it's supposed to check). Roles read-only by
  // the SUBAGENT_ROLES registry (planner/architect/critic) never mutate;
  // architect/critic ALSO carry a verdict contract team.ts enforces — planner
  // does not, so it can't discharge this gate. `executor` (or an unset/unknown
  // role, which resolves to executor's default) mutates. Grouped
  // (`parallel_group`) steps are evaluated as ONE atomic unit: concurrent
  // steps cannot verify each other (they run in isolated worktrees with no
  // visibility into siblings' STILL-IN-FLIGHT changes), so a critic/architect
  // inside the SAME group as a mutating sibling does not clear the gate —
  // only a later, separate unit does.
  // Local literal, not imported from subagents.ts — `plan.ts` stays a pure,
  // dependency-free schema module (mirrors subagents.ts's own DEFAULT_ROLE_ID).
  const DEFAULT_STEP_ROLE = "executor";
  const READONLY_ROLES: Record<string, true> = { planner: true, architect: true, critic: true };
  const VERIFIER_ROLES: Record<string, true> = { architect: true, critic: true };
  type Unit = { steps: typeof plan.steps; label: string };
  const units: Unit[] = [];
  for (const step of plan.steps) {
    const group = step.parallel_group?.trim() || undefined;
    const last = units[units.length - 1];
    if (group && last && last.label === group) {
      last.steps.push(step);
    } else {
      units.push({ steps: [step], label: group ?? `#solo:${step.name}` });
    }
  }
  let pendingUnverifiedMutation: string | undefined;
  for (const unit of units) {
    const roleIds = unit.steps.map(s => (s.role?.trim() || DEFAULT_STEP_ROLE));
    const unitMutates = roleIds.some(r => READONLY_ROLES[r] !== true);
    const unitVerifies = roleIds.some(r => VERIFIER_ROLES[r] === true);
    if (unitMutates) {
      pendingUnverifiedMutation = unit.steps[unit.steps.length - 1]!.name;
    } else if (unitVerifies) {
      pendingUnverifiedMutation = undefined;
    }
  }
  if (pendingUnverifiedMutation) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `plan ends with an unverified mutation (last mutating step: "${pendingUnverifiedMutation}") — add an ` +
        `architect or critic step AFTER it (never inside the same parallel_group, which runs concurrently and ` +
        `cannot verify a still-in-flight sibling) so team.ts's evidence-grounded role gate actually runs over the ` +
        `real changes before the plan is considered complete.`,
    });
  }
});

/**
 * Tolerate common planning-model deviations so a valid-enough plan still executes:
 * a top-level list of tasks, a `tasks:` alias for `steps:`, bare-string tasks, and
 * step name under `task`/`title`/`description`/`step`.
 */
export function normalizePlanShape(raw: any): any {
  let plan = raw;
  if (Array.isArray(plan)) plan = { steps: plan };
  if (plan && typeof plan === "object" && !Array.isArray(plan)) {
    if (!Array.isArray(plan.steps) && Array.isArray(plan.tasks)) plan = { ...plan, steps: plan.tasks };
    if (Array.isArray(plan.steps)) {
      plan = {
        ...plan,
        steps: plan.steps.map((s: any) =>
          typeof s === "string"
            ? { name: s }
            : s && typeof s === "object" && !s.name
              ? { ...s, name: s.task ?? s.title ?? s.description ?? s.step ?? "" }
              : s,
        ).filter((s: any) => s && typeof s.name === "string" && s.name.trim() !== ""),
      };
    }
  }
  return plan;
}

function parseValue(v: string): any {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (v === "") return "";
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

export function parseYaml(yamlStr: string): any {
  const lines = yamlStr.split(/\r?\n/).map(line => {
    const commentIdx = line.indexOf('#');
    const cleanLine = commentIdx !== -1 ? line.slice(0, commentIdx) : line;
    return {
      trimmed: cleanLine.trim(),
      indent: cleanLine.length - cleanLine.trimStart().length
    };
  }).filter(l => l.trimmed !== '');

  let idx = 0;

  function parseBlock(baseIndent: number): any {
    let result: any = null;
    let isArray = false;

    if (idx < lines.length) {
      if (lines[idx].trimmed.startsWith('-')) {
        isArray = true;
        result = [];
      } else {
        result = {};
      }
    }

    while (idx < lines.length) {
      const line = lines[idx];
      if (line.indent < baseIndent) {
        break;
      }

      if (isArray) {
        if (!line.trimmed.startsWith('-')) {
          if (result.length > 0 && typeof result[result.length - 1] === 'object') {
            const colonIdx = line.trimmed.indexOf(':');
            if (colonIdx !== -1) {
              const k = line.trimmed.slice(0, colonIdx).trim();
              const rawVal = line.trimmed.slice(colonIdx + 1).trim();
              if (rawVal === '') {
                idx++;
                result[result.length - 1][k] = parseBlock(line.indent + 1);
                continue;
              } else {
                result[result.length - 1][k] = parseValue(rawVal);
              }
            } else {
              throw new Error(`Invalid line inside array block: "${line.trimmed}"`);
            }
          } else {
            throw new Error(`Invalid line in array: "${line.trimmed}"`);
          }
          idx++;
          continue;
        }

        const rest = line.trimmed.slice(1).trim();
        if (rest === '') {
          idx++;
          const nested = parseBlock(line.indent + 1);
          result.push(nested);
        } else if (rest.includes(':')) {
          const colonIdx = rest.indexOf(':');
          const k = rest.slice(0, colonIdx).trim();
          const rawVal = rest.slice(colonIdx + 1).trim();
          if (rawVal === '') {
            idx++;
            const nestedObj = { [k]: parseBlock(line.indent + 2) };
            result.push(nestedObj);
          } else {
            const item: any = { [k]: parseValue(rawVal) };
            result.push(item);
            idx++;
            while (idx < lines.length && !lines[idx].trimmed.startsWith('-') && lines[idx].indent >= line.indent + 2) {
              const subLine = lines[idx];
              const subColonIdx = subLine.trimmed.indexOf(':');
              if (subColonIdx !== -1) {
                const subK = subLine.trimmed.slice(0, subColonIdx).trim();
                const rawSubVal = subLine.trimmed.slice(subColonIdx + 1).trim();
                if (rawSubVal === '') {
                  idx++;
                  item[subK] = parseBlock(subLine.indent + 1);
                } else {
                  item[subK] = parseValue(rawSubVal);
                  idx++;
                }
              } else {
                throw new Error(`Invalid sub-line in block mapping: "${subLine.trimmed}"`);
              }
            }
          }
        } else {
          result.push(parseValue(rest));
          idx++;
        }
      } else {
        const colonIdx = line.trimmed.indexOf(':');
        if (colonIdx === -1) {
          throw new Error(`Invalid line: "${line.trimmed}"`);
        }

        const k = line.trimmed.slice(0, colonIdx).trim();
        const rawVal = line.trimmed.slice(colonIdx + 1).trim();

        if (rawVal === '') {
          idx++;
          result[k] = parseBlock(line.indent + 1);
        } else {
          result[k] = parseValue(rawVal);
          idx++;
        }
      }
    }

    return result;
  }

  return parseBlock(0);
}
