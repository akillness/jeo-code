/**
 * Subagent role registry (gjc role-agent parity: executor / planner / architect /
 * critic). A "subagent" is the executor tool-loop driven with a role-specific
 * system prompt, model, step budget, and toolset. The registry is pure data so
 * it can be listed in the TUI (`/agents`) and consumed by `joc team` without
 * importing any provider or I/O code.
 *
 * Read-only roles (planner/architect/critic) get a mutation-free toolset so a
 * review/plan lane physically cannot edit the repo, mirroring gjc's read-only
 * role agents.
 */
import { DEFAULT_TOOLS, executorSystemPrompt, type ToolHandler } from "./engine";
import type { Config } from "./state";

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
}

/** The four bundled subagent roles. `executor` is the only mutating role. */
export const SUBAGENT_ROLES: readonly SubagentRole[] = [
  {
    id: "executor",
    title: "Executor",
    description: "Bounded implementation, refactors, fixes, and verification-ready edits.",
    readOnly: false,
    defaultMaxSteps: 15,
  },
  {
    id: "planner",
    title: "Planner",
    description: "Read-only sequencing, acceptance criteria, risks, and handoff shape.",
    readOnly: true,
    defaultMaxSteps: 10,
  },
  {
    id: "architect",
    title: "Architect",
    description: "Read-only architecture and code review with severity-rated findings.",
    readOnly: true,
    defaultMaxSteps: 10,
  },
  {
    id: "critic",
    title: "Critic",
    description: "Read-only plan critic; approves only actionable, verifiable plans.",
    readOnly: true,
    defaultMaxSteps: 8,
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
  return entry?.model ?? config.defaultModel;
}

/** Per-role step budget → config override, else the role default, else 15. */
export function resolveSubagentMaxSteps(roleId: string, config: Pick<Config, "subagents">): number {
  const entry = config.subagents?.[normalizeRoleId(roleId)];
  if (typeof entry?.maxSteps === "number" && entry.maxSteps > 0) return entry.maxSteps;
  return getSubagentRole(roleId)?.defaultMaxSteps ?? 15;
}

/** Build a role-specific executor system prompt; read-only roles get a no-mutation directive. */
export function subagentSystemPrompt(role: SubagentRole): string {
  const base = executorSystemPrompt(`${role.title} subagent — ${role.description}`);
  if (!role.readOnly) return base;
  return (
    base +
    `\n\nYou are a READ-ONLY ${role.title}. Do not create or modify files; ` +
    `use read / find / search (and read-only bash) only, then report your findings via done.`
  );
}

/** Toolset for a role: read-only roles drop the mutating tools (write/edit). */
export function subagentToolset(role: SubagentRole): Record<string, ToolHandler> {
  if (!role.readOnly) return DEFAULT_TOOLS;
  const ro: Record<string, ToolHandler> = {};
  for (const [name, handler] of Object.entries(DEFAULT_TOOLS)) {
    if (name === "write" || name === "edit") continue;
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
