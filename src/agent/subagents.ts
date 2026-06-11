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
import { DEFAULT_TOOLS, TOOL_PROTOCOL, READONLY_TOOL_PROTOCOL, type ToolHandler } from "./engine";
import type { Config } from "./state";
import architectPrompt from "../prompts/agents/architect.md" with { type: "text" };
import criticPrompt from "../prompts/agents/critic.md" with { type: "text" };
import executorPrompt from "../prompts/agents/executor.md" with { type: "text" };
import plannerPrompt from "../prompts/agents/planner.md" with { type: "text" };

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

/** Normalize loosely-typed role input (case-insensitive, trimmed). */
export function normalizeRoleId(input: string | undefined | null): string {
  return (input ?? "").trim().toLowerCase();
}

/** Look up a role by id (case-insensitive). Returns undefined when unknown. */
export function getSubagentRole(id: string | undefined | null): SubagentRole | undefined {
  const want = normalizeRoleId(id);
  return SUBAGENT_ROLES.find(r => r.id === want);
}

/** The default role (`executor`) used when none is specified. */
export function defaultSubagentRole(): SubagentRole {
  // Non-null: DEFAULT_ROLE_ID is guaranteed present in SUBAGENT_ROLES.
  return getSubagentRole(DEFAULT_ROLE_ID)!;
}

export type SubagentConfig = NonNullable<Config["subagents"]>;

/** Per-role model override → falls back to the global default model. */
export function resolveSubagentModel(roleId: string, config: Pick<Config, "defaultModel" | "subagents">): string {
  const entry = config.subagents?.[normalizeRoleId(roleId)];
  return entry?.model || config.defaultModel;
}

/** Per-role step budget → config override, else the role default, else 15. */
export function resolveSubagentMaxSteps(roleId: string, config: Pick<Config, "subagents">): number {
  const entry = config.subagents?.[normalizeRoleId(roleId)];
  if (typeof entry?.maxSteps === "number" && entry.maxSteps > 0) return entry.maxSteps;
  return getSubagentRole(roleId)?.defaultMaxSteps ?? 15;
}

function renderRolePrompt(template: string, role: SubagentRole): string {
  return template
    .replaceAll("{{TOOL_PROTOCOL}}", TOOL_PROTOCOL)
    .replaceAll("{{READONLY_TOOL_PROTOCOL}}", READONLY_TOOL_PROTOCOL)
    .replaceAll("{{ROLE_TITLE}}", role.title)
    .trim();
}

export function validateSubagentDoneReason(role: SubagentRole, reason: string | undefined): { ok: boolean; missing?: string[] } {
  const trimmed = (reason ?? "").trim();
  if (!trimmed) return { ok: false, missing: ["done.reason"] };
  if (role.id === "critic") {
    const verdicts = ["[OKAY]", "[ITERATE]", "[REJECT]"];
    const hasVerdict = verdicts.some(marker => trimmed.startsWith(marker));
    const missing = [
      ...(hasVerdict ? [] : ["[OKAY]|[ITERATE]|[REJECT]"]),
      ...((role.requiredDoneMarkers ?? []).filter(marker => !trimmed.includes(marker))),
    ];
    return { ok: missing.length === 0, missing };
  }
  const missing = (role.requiredDoneMarkers ?? []).filter(marker => !trimmed.includes(marker));
  return { ok: missing.length === 0, missing };
}

/** Build a role-specific system prompt from its dedicated template. */
export function subagentSystemPrompt(role: SubagentRole): string {
  return renderRolePrompt(role.prompt, role);
}

/**
 * Toolset for a role: read-only roles drop ALL mutating tools (write/edit and
 * bash) so a review/plan lane physically cannot change the repo — bash can run
 * arbitrary mutating shell, so it is excluded for read-only roles too.
 */
export function subagentToolset(role: SubagentRole): Record<string, ToolHandler> {
  if (!role.readOnly) return DEFAULT_TOOLS;
  const MUTATING = new Set(["write", "edit", "bash"]);
  const ro: Record<string, ToolHandler> = {};
  for (const [name, handler] of Object.entries(DEFAULT_TOOLS)) {
    if (MUTATING.has(name)) continue;
    ro[name] = handler;
  }
  return ro;
}

/** All role ids (for `/agents` autocomplete + validation). */
export function subagentRoleIds(): string[] {
  return SUBAGENT_ROLES.map(r => r.id);
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
export function withSubagentSetting(
  config: Pick<Config, "subagents">,
  roleId: string,
  patch: { model?: string; maxSteps?: number },
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

/** One pickable apply-target: the global default or a subagent role. */
export interface ApplyTargetChoice {
  /** "default" or a subagent role id. */
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
  config: Pick<Config, "defaultModel" | "subagents">,
): ApplyTargetChoice[] {
  return [
    {
      value: "default",
      label: "default — every session",
      hint: config.defaultModel,
    },
    ...SUBAGENT_ROLES.map(role => ({
      value: role.id,
      label: `subagent ${role.id} — ${role.title}`,
      hint: resolveSubagentModel(role.id, config) + (config.subagents?.[role.id]?.model ? "" : " (default)"),
    })),
  ];
}
