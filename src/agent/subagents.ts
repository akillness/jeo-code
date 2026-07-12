/**
 * Subagent role registry (gjc role-agent parity: executor / planner / architect /
 * critic). A "subagent" is the executor tool-loop driven with a role-specific
 * system prompt, model, step budget, and toolset. The registry is pure data so
 * it can be listed in the TUI (`/agents`) and consumed by `jeo team` without
 * importing any provider or I/O code.
 *
 * Read-only roles (planner/architect/critic) get a mutation-free toolset so a
 * review/plan lane physically cannot edit the repo, mirroring gjc's read-only
 * role agents.
 */
import { DEFAULT_TOOLS, TOOL_PROTOCOL, READONLY_TOOL_PROTOCOL, WORKING_DISCIPLINE, type ToolHandler } from "./engine";
import type { Config } from "./state";
import type { CatalogModel } from "../ai/model-catalog";
import architectPrompt from "../prompts/agents/architect.md" with { type: "text" };
import criticPrompt from "../prompts/agents/critic.md" with { type: "text" };
import executorPrompt from "../prompts/agents/executor.md" with { type: "text" };
import plannerPrompt from "../prompts/agents/planner.md" with { type: "text" };
import { strongestCredentialed, cheapestCredentialed, type PromptTier } from "./prompt-router";

const PROMPT_ROUTE_TIERS = ["trivial", "standard", "high", "complex"] as const satisfies readonly PromptTier[];

export interface SubagentRole {
  /** Stable id used in config + `/agents <id>`. */
  id: string;
  /** Human title shown in listings. */
  title: string;
  /** One-line purpose. */
  description: string;
  /** Read-only roles must not mutate the repo (no write/edit tools). */
  readOnly: boolean;
  /** Default tool-loop step budget for this role. */
  defaultMaxSteps: number;
  /** Role-specific prompt template. */
  prompt: string;
  /** Required markers that must appear in done.reason. */
  requiredDoneMarkers?: string[];
  /** When set on a MUTATING role, bash is wrapped so EVERY shell segment must
   *  start with one of these prefixes (after stripping leading env-assignments /
   *  `sudo`); anything else is rejected. The registry definition IS the runtime
   *  constraint — no config plumbing. Undefined = unconstrained bash. Read-only
   *  roles drop bash entirely regardless. (plan/gjc-inheritance.md cycle 10, B5) */
  bashAllowedPrefixes?: string[];
}

/** The four bundled subagent roles. `executor` is the only mutating role. */
export const SUBAGENT_ROLES: readonly SubagentRole[] = [
  {
    id: "executor",
    title: "Executor",
    description: "Bounded implementation, refactors, fixes, and verification-ready edits.",
    readOnly: false,
    defaultMaxSteps: 15,
    prompt: executorPrompt,
    requiredDoneMarkers: ["Summary:", "Changed Files:", "Verification:"],
  },
  {
    id: "planner",
    title: "Planner",
    description: "Read-only sequencing, acceptance criteria, risks, and handoff shape.",
    readOnly: true,
    defaultMaxSteps: 10,
    prompt: plannerPrompt,
    requiredDoneMarkers: [
      "Summary:",
      "In Scope:",
      "Out of Scope:",
      "File-level Changes:",
      "Sequencing:",
      "Acceptance Criteria:",
      "Verification:",
      "Risks:",
    ],
  },
  {
    id: "architect",
    title: "Architect",
    description: "Read-only architecture and code review with severity-rated findings.",
    readOnly: true,
    defaultMaxSteps: 10,
    prompt: architectPrompt,
    requiredDoneMarkers: [
      "Summary:",
      "Findings:",
      "Recommendations:",
      "Architectural Status:",
      "Code Review Recommendation:",
    ],
  },
  {
    id: "critic",
    title: "Critic",
    description: "Read-only plan critic; approves only actionable, verifiable plans.",
    readOnly: true,
    defaultMaxSteps: 8,
    prompt: criticPrompt,
    requiredDoneMarkers: ["Justification:"],
  },
];

const DEFAULT_ROLE_ID = "executor";

/** Generic prompt template for CONFIG-DECLARED custom roles (no per-role .md
 *  bundled). Uses the same {{…}} variables as the bundled templates, so the
 *  whole role pipeline stays template-driven rather than hardcoded. */
const CUSTOM_ROLE_PROMPT = `You are the {{ROLE_TITLE}} subagent: {{ROLE_DESCRIPTION}}

{{TOOL_PROTOCOL}}

Work strictly within your assignment. When finished, reply
{"tool":"done","arguments":{"reason":"Summary: <what you found/did>"}}.`;

/**
 * SYSTEM-driven role registry: config.subagents entries that DECLARE a role
 * identity (a \`prompt\`, \`title\`, or \`description\`) under an id that is not
 * bundled become first-class roles — no code change needed to add one. Bare
 * model/steps pins on unknown ids are NOT roles (typo safety). Safety default:
 * a custom role is READ-ONLY unless it explicitly sets \`readOnly: false\`.
 */
export function rolesFromConfig(config: Pick<Config, "subagents">): SubagentRole[] {
  const custom: SubagentRole[] = [];
  for (const [rawId, entry] of Object.entries(config.subagents ?? {})) {
    const id = normalizeRoleId(rawId);
    if (!id || SUBAGENT_ROLES.some(r => r.id === id)) continue;
    if (!entry || (entry.prompt === undefined && entry.title === undefined && entry.description === undefined)) continue;
    const title = entry.title ?? id.charAt(0).toUpperCase() + id.slice(1);
    custom.push({
      id,
      title,
      description: entry.description ?? `Custom role "${id}" (declared in config.subagents).`,
      readOnly: entry.readOnly ?? true,
      defaultMaxSteps: typeof entry.maxSteps === "number" && entry.maxSteps > 0 ? entry.maxSteps : 12,
      prompt: (entry.prompt ?? CUSTOM_ROLE_PROMPT).replaceAll("{{ROLE_DESCRIPTION}}", entry.description ?? title),
    });
  }
  return custom;
}

/** Bundled roles + config-declared custom roles (the full live registry). */
export function allSubagentRoles(config?: Pick<Config, "subagents">): SubagentRole[] {
  return config ? [...SUBAGENT_ROLES, ...rolesFromConfig(config)] : [...SUBAGENT_ROLES];
}

/** Normalize loosely-typed role input (case-insensitive, trimmed). */
export function normalizeRoleId(input: string | undefined | null): string {
  return (input ?? "").trim().toLowerCase();
}

/** Look up a role by id (case-insensitive) across the bundled registry and —
 *  when a config is supplied — config-declared custom roles. */
export function getSubagentRole(id: string | undefined | null, config?: Pick<Config, "subagents">): SubagentRole | undefined {
  const want = normalizeRoleId(id);
  return allSubagentRoles(config).find(r => r.id === want);
}

/** The default role (`executor`) used when none is specified. */
export function defaultSubagentRole(): SubagentRole {
  // Non-null: DEFAULT_ROLE_ID is guaranteed present in SUBAGENT_ROLES.
  return getSubagentRole(DEFAULT_ROLE_ID)!;
}

export type SubagentConfig = NonNullable<Config["subagents"]>;

/** Per-role model override → falls back to the global default model. */
export function resolveSubagentModel(
  roleId: string,
  config: {
    defaultModel: string;
    subagents?: Config["subagents"];
    roles?: Config["roles"];
    providers?: Config["providers"];
    oauth?: Config["oauth"];
  },
): string {
  const normalized = normalizeRoleId(roleId);
  const entry = config.subagents?.[normalized];
  if (entry?.model) return entry.model;

  if (normalized === "executor") {
    return config.roles?.xhigh || config.roles?.slow || strongestCredentialed(config) || config.defaultModel;
  }
  if (normalized === "architect") {
    return config.roles?.xhigh || strongestCredentialed(config, (m: CatalogModel) => m.thinking.includes("xhigh") || m.thinking.includes("high")) || config.defaultModel;
  }
  if (normalized === "planner") {
    return config.roles?.high || strongestCredentialed(config) || config.defaultModel;
  }
  if (normalized === "critic") {
    // Grader role (plan reviewer): prefer an explicit mid/cheap pin, else the
    // live-cheapest credentialed model — a GENERAL search (not 2 hardcoded ids),
    // so critic tracks catalog drift the same way every other role's fallback
    // does instead of silently collapsing to defaultModel when neither o3-mini
    // nor gemini-2.5-flash happens to be credentialed.
    return (
      config.roles?.medium ||
      config.roles?.smol ||
      cheapestCredentialed(config) ||
      config.defaultModel
    );
  }
  return config.defaultModel;
}

/** Per-role step budget → config override, else the role default, else 15. */
export function resolveSubagentMaxSteps(roleId: string, config: Pick<Config, "subagents">): number {
  const entry = config.subagents?.[normalizeRoleId(roleId)];
  if (typeof entry?.maxSteps === "number" && entry.maxSteps > 0) return entry.maxSteps;
  return getSubagentRole(roleId, config)?.defaultMaxSteps ?? 15;
}

function renderRolePrompt(template: string, role: SubagentRole): string {
  return template
    .replaceAll("{{TOOL_PROTOCOL}}", `${TOOL_PROTOCOL}\n\n${WORKING_DISCIPLINE}`)
    .replaceAll("{{READONLY_TOOL_PROTOCOL}}", READONLY_TOOL_PROTOCOL)
    .replaceAll("{{ROLE_TITLE}}", role.title)
    .trim();
}

/** True when `marker` is present in `text` AND the span between it and the next
 *  required marker (or end of text) carries non-whitespace content. A label-only
 *  section ("Summary:" with an empty body) is not a real report, so it fails. */
function markerHasContent(text: string, marker: string, allMarkers: string[]): boolean {
  const start = text.indexOf(marker);
  if (start < 0) return false;
  const after = start + marker.length;
  let end = text.length;
  for (const other of allMarkers) {
    if (other === marker) continue;
    const j = text.indexOf(other, after);
    if (j >= 0 && j < end) end = j;
  }
  return text.slice(after, end).trim().length > 0;
}

export function validateSubagentDoneReason(role: SubagentRole, reason: string | undefined): { ok: boolean; missing?: string[] } {
  const trimmed = (reason ?? "").trim();
  if (!trimmed) return { ok: false, missing: ["done.reason"] };
  const markers = role.requiredDoneMarkers ?? [];
  // Each required section must be PRESENT and carry non-empty content — a report of
  // bare labels (no prose) is rejected, which the substring-presence check let pass.
  const sectionMissing = markers.filter(m => !markerHasContent(trimmed, m, markers));
  if (role.id === "critic") {
    const verdicts = ["[OKAY]", "[ITERATE]", "[REJECT]"];
    const hasVerdict = verdicts.some(marker => trimmed.startsWith(marker));
    const missing = [
      ...(hasVerdict ? [] : ["[OKAY]|[ITERATE]|[REJECT]"]),
      ...sectionMissing,
    ];
    return { ok: missing.length === 0, missing };
  }
  return { ok: sectionMissing.length === 0, missing: sectionMissing };
}

/** Build a role-specific system prompt from its dedicated template. */
export function subagentSystemPrompt(role: SubagentRole): string {
  return renderRolePrompt(role.prompt, role);
}

/**
 * True when EVERY shell segment of `command` starts with one of `prefixes`
 * (after stripping leading env-assignments and a leading `sudo`). Splitting on
 * `; && || |` means a chained `… && rm -rf` cannot smuggle an un-vetted command
 * past a single allowed head. Command substitution (`$(…)`, backticks) can't be
 * statically vetted, so it is rejected outright. Empty allowlist = unconstrained.
 */
export function bashCommandAllowed(command: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) return true;
  if (/[`]|\$\(/.test(command)) return false; // un-vettable command substitution
  const matches = (seg: string, p: string) =>
    seg === p || seg.startsWith(p + " ") || seg.startsWith(p + "\t");
  for (const raw of command.split(/(?:&&|\|\||[;|])/)) {
    let seg = raw.trim();
    if (seg === "") continue;
    seg = seg
      .replace(/^(?:\w+=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, "") // FOO=bar BAZ=qux cmd
      .replace(/^sudo\s+/, "")
      .trim();
    if (seg === "" || !prefixes.some(p => matches(seg, p))) return false;
  }
  return true;
}

/**
 * Toolset for a role:
 *  - Read-only roles drop ALL mutating tools (write/edit AND bash) so a
 *    review/plan lane physically cannot change the repo.
 *  - A mutating role with `bashAllowedPrefixes` gets bash replaced by a
 *    prefix-checking wrapper (registry definition = runtime constraint).
 *  - Otherwise the full default toolset (unconstrained bash) is returned.
 */
export function subagentToolset(role: SubagentRole): Record<string, ToolHandler> {
  if (role.readOnly) {
    const MUTATING = new Set(["write", "edit", "bash", "mkdir", "delete", "ast_edit", "computer", "lsp_rename", "debug", "browser"]);
    const ro: Record<string, ToolHandler> = {};
    for (const [name, handler] of Object.entries(DEFAULT_TOOLS)) {
      if (MUTATING.has(name)) continue;
      ro[name] = handler;
    }
    return ro;
  }
  const prefixes = role.bashAllowedPrefixes;
  if (prefixes && prefixes.length > 0) {
    const inner = DEFAULT_TOOLS.bash;
    const guarded: Record<string, ToolHandler> = { ...DEFAULT_TOOLS };
    guarded.bash = async (a, cwd) => {
      const command = String(a.command ?? a.cmd ?? "");
      if (!bashCommandAllowed(command, prefixes)) {
        return {
          success: false,
          output: "",
          error:
            `bash rejected for role '${role.id}': every command segment must start with one of [${prefixes.join(", ")}]. ` +
            `Received: ${command.trim().slice(0, 120)}`,
        };
      }
      return inner(a, cwd);
    };
    return guarded;
  }
  return DEFAULT_TOOLS;
}

/** All role ids — bundled + config-declared (for autocomplete + validation). */
export function subagentRoleIds(config?: Pick<Config, "subagents">): string[] {
  return allSubagentRoles(config).map(r => r.id);
}

/** Parse a `/agents <role> maxSteps <n>` value → positive int, else undefined. */
export function parseMaxSteps(input: string | undefined): number | undefined {
  const n = parseInt((input ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Return a new `subagents` map with a role's settings patched (model and/or
 * maxSteps). Pure — does not mutate `config`. Unknown roles are rejected by the
 * caller via `getSubagentRole`; this helper trusts the id it is given.
 */
export type ThinkLevelValue = "low" | "medium" | "high" | "xhigh";

/** Per-role reasoning level → explicit role override, else undefined (= INHERIT
 *  the global thinkingLevel at call time — gjc's "(inherit)" semantics). */
export function resolveSubagentThinking(
  roleId: string,
  config: Pick<Config, "subagents">,
): ThinkLevelValue | undefined {
  return config.subagents?.[normalizeRoleId(roleId)]?.thinking;
}

export function withSubagentSetting(
  config: Pick<Config, "subagents">,
  roleId: string,
  patch: { model?: string; maxSteps?: number; thinking?: ThinkLevelValue },
): SubagentConfig {
  const id = normalizeRoleId(roleId);
  const subs: SubagentConfig = { ...(config.subagents ?? {}) };
  subs[id] = { ...subs[id], ...patch };
  return subs;
}

/** Return a new `subagents` map with a role's override removed (reset to defaults). */
export function clearSubagentSetting(config: Pick<Config, "subagents">, roleId: string): SubagentConfig {
  const id = normalizeRoleId(roleId);
  const subs: SubagentConfig = { ...(config.subagents ?? {}) };
  delete subs[id];
  return subs;
}

/** One pickable apply-target: the global default, a prompt-routing tier, or a subagent role. */
export interface ApplyTargetChoice {
  /** "default", "routing:<tier>", or a subagent role id. */
  value: string;
  label: string;
  /** Right-aligned hint: the target's CURRENT model (so the picker doubles as a viewer). */
  hint: string;
}

/**
 * Choices for the "apply picked model to…" picker shown after an interactive
 * model selection (gjc parity: picking a model also lets you pick WHO uses it).
 * The hint shows each target's current model, so the same picker doubles as a
 * read-and-change panel for existing role assignments. Pure — testable.
 */
export function applyTargetChoices(
  config: Pick<Config, "defaultModel" | "subagents" | "thinkingLevel" | "routing" | "roles"> &
    Partial<Pick<Config, "providers" | "oauth" | "openaiBaseUrl">>,
): ApplyTargetChoice[] {
  const roleThink = (id: string): string => {
    const t = resolveSubagentThinking(id, config);
    return t ? ` (${t})` : " (inherit)";
  };
  const routeThink = (tier: PromptTier): string => {
    const t = config.routing?.tiers?.[tier]?.thinking;
    return t ? ` (${t})` : " (auto thinking)";
  };
  // Lazy load keeps the existing subagents→prompt-router dependency from
  // becoming an eager module cycle; resolveSubagentModel uses the same pattern.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { resolveTierModel } = require("./prompt-router");
  return [
    {
      value: "default",
      label: "default — every session",
      hint: `${config.defaultModel} (${config.thinkingLevel ?? "medium"})`,
    },
    ...PROMPT_ROUTE_TIERS.map(tier => ({
      value: `routing:${tier}`,
      label: `route ${tier} — PromptRouter tier`,
      hint: `${config.routing?.tiers?.[tier]?.model ?? resolveTierModel(tier, config)}${config.routing?.tiers?.[tier]?.model ? "" : " (auto)"}${routeThink(tier)}`,
    })),
    ...allSubagentRoles(config).map(role => ({
      value: role.id,
      label: `subagent ${role.id} — ${role.title}`,
      hint: resolveSubagentModel(role.id, config) + (config.subagents?.[role.id]?.model ? "" : " (default)") + roleThink(role.id),
    })),
  ];
}
