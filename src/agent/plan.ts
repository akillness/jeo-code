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
}).passthrough();

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
