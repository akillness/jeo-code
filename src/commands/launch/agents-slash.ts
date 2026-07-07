/**
 * `/agents`, `/roles`, `/fast`, and `/thinking` slash-command handlers
 * extracted from launch.ts.
 *
 * These four commands share mutable REPL state with each other and with the
 * already-extracted `/model` (model-slash.ts): `/agents` and `/roles` read
 * and write `lastPickIndex`; `/fast` and `/thinking` read and write
 * `sessionThinking` (which `/model thinking <level>` also writes). The
 * caller threads the current values in via an explicit context object and
 * reads back a result object instead of these functions closing over REPL
 * state directly.
 */

import { readGlobalConfig, saveConfigPatch } from "../../agent/state";
import {
  describeModel,
  describeAllProviders,
  thinkingMaxTokens,
  flattenModels,
  resolveSelection,
  resolveRoleModel,
  catalogByProvider,
  qualifyModelId,
} from "../../ai";
import type { ProviderModelsResult, PickEntry, ProviderName, ThinkLevel } from "../../ai";
import {
  allSubagentRoles,
  getSubagentRole,
  resolveSubagentModel,
  resolveSubagentMaxSteps,
  resolveSubagentThinking,
  parseMaxSteps,
  withSubagentSetting,
  clearSubagentSetting,
} from "../../agent/subagents";
import {
  formatModelLine,
  liveModelKnown,
  formatPickListWithCapabilities,
  formatAgentsPanel,
  formatAgentDetail,
} from "../../tui/components/config-panel";
import type { SelectItem } from "../../tui/components/select-list";
import { openaiCompatDef } from "../../ai/providers/openai-compatible-catalog";
import { isProviderName, fastThinkingLevelForModel } from "./flags";

// Per-provider starting model for provider pinning. Catalog OpenAI-compatible
// providers supply their own default; built-ins use this map.
// Pure data — mirrors the identically-named REPL-local const in launch.ts.
const STATIC_PROVIDER_DEFAULT: Partial<Record<ProviderName, string>> = { anthropic: "sonnet", openai: "gpt-5.5", gemini: "flash", antigravity: "antigravity/gemini-3-pro-high", ollama: "fast", lmstudio: "lmstudio/local-model", xai: "grok-4.3", kimi: "kimi-k2-0711-preview" };

// Pure function — mirrors the identically-named REPL-local const in launch.ts.
function providerDefaultModel(p: ProviderName): string {
  return openaiCompatDef(p)?.defaultModel ?? STATIC_PROVIDER_DEFAULT[p] ?? "";
}

// Pick-list entries for ONE provider, with static fallbacks so the list is
// never empty. Pure function — mirrors launch.ts's exported `providerPickEntries`
// (duplicated here rather than imported to avoid a launch.ts <-> launch/*.ts cycle).
function providerPickEntries(live: ProviderModelsResult[], want: ProviderName): PickEntry[] {
  const fromLive = flattenModels(live.filter(r => r.provider === want));
  if (fromLive.length) return fromLive;
  const catalog = catalogByProvider(want);
  if (catalog.length) {
    return catalog.map((m, i) => ({ index: i + 1, provider: want, model: qualifyModelId(m.providerModel, want) }));
  }
  const def = openaiCompatDef(want);
  if (def) {
    const ids = [def.defaultModel, ...(def.knownModels ?? [])].map(m => qualifyModelId(m, want));
    const seen = new Set<string>();
    const entries: PickEntry[] = [];
    for (const model of ids) {
      if (seen.has(model)) continue;
      seen.add(model);
      entries.push({ index: entries.length + 1, provider: want, model });
    }
    if (entries.length) return entries;
  }
  const fallback = providerDefaultModel(want);
  return fallback ? [{ index: 1, provider: want, model: qualifyModelId(fallback, want) }] : [];
}

// Antigravity with ANY Google OAuth (own login or the gemini-cli fallback) stays
// SELECTABLE in pickers even when not call-ready: picking the model is how users
// reach the flow, and the auth layer gives actionable login guidance on the first
// call if the fallback token is rejected (403). Refusing selection was a dead end.
// Pure predicate — mirrors the identically-named REPL-local const in launch.ts.
const selectableThoughNotReady = (st?: { name: string; kind: string }): boolean =>
  !!st && st.name === "antigravity" && st.kind === "oauth";

// Pure function — mirrors the identically-named REPL-local const in launch.ts.
const notReadyWarning = (st: { name: string; label: string }): string =>
  `  ! ${st.name} is not call-ready yet (${st.label}) — run /provider login antigravity before the first turn.`;

export interface AgentsSlashCtx {
  sessionModel: string | undefined;
  sessionThinking: ThinkLevel | undefined;
  lastPickIndex: PickEntry[];
  getLiveModels: (force?: boolean) => Promise<ProviderModelsResult[]>;
  /**
   * REPL's interactive live-model picker menu (raw-mode keypress loop +
   * repaint). Not a pure module export — it closes over `runSelectPicker`
   * and `modelPickerAssignments` (which itself reads `sessionModel`), so the
   * caller threads it through like the other REPL hooks.
   */
  pickLiveProviderModel: (
    providerName: string,
    entries: PickEntry[],
    current?: string,
    disabledProviders?: readonly ProviderName[],
  ) => Promise<PickEntry | undefined>;
  /**
   * Sets (or clears) a subagent role's thinking override, printing the
   * confirmation itself. Closes over `readGlobalConfig`/`saveConfigPatch`
   * REPL-local wiring, so the caller threads it through.
   */
  setRoleThinking: (roleId: string, rawLevel: string | undefined) => Promise<boolean>;
  /** Generic arrows+Enter option picker (role / action menus). REPL-local closure. */
  pickFromOptions: (title: string, options: SelectItem<string>[]) => Promise<string | undefined>;
  /** Arrows+Enter thinking-level picker built on `pickFromOptions`. REPL-local closure. */
  pickThinkingLevel: (
    title: string,
    current: ThinkLevel | undefined,
    inheritLabel?: string,
  ) => Promise<ThinkLevel | "inherit" | undefined>;
}

export interface AgentsSlashResult {
  /** Present only when changed. */
  sessionThinking?: ThinkLevel;
  /** Present only when the block builds/refreshes a pick list. */
  lastPickIndex?: PickEntry[];
}

/**
 * Handle `/agents [edit|role] [model|#N|thinking L|maxSteps N|reset]`.
 * Extracted verbatim from launch.ts's inline REPL branch — the caller keeps
 * the `input === "/agents" || input.startsWith("/agents ")` guard and just
 * calls this function.
 */
export async function runAgentsSlash(input: string, ctx: AgentsSlashCtx): Promise<AgentsSlashResult> {
  const { getLiveModels, pickLiveProviderModel, setRoleThinking, pickFromOptions, pickThinkingLevel } = ctx;
  let lastPickIndex = ctx.lastPickIndex;
  let lastPickIndexChanged = false;

  const result = (): AgentsSlashResult => ({
    ...(lastPickIndexChanged ? { lastPickIndex } : {}),
  });

  const agentsCommand = "/agents";
  const tokens = input.substring(agentsCommand.length).trim().split(/\s+/).filter(Boolean);
  const roleArg = tokens[0];
  const modelArg = tokens[1];
  const cfgNow = await readGlobalConfig();
  const subcommand = roleArg?.toLowerCase();
  const printRoster = () => {
    console.log("Subagent roles (used by 'jeo team'):");
    for (const line of formatAgentsPanel(allSubagentRoles(cfgNow), r => ({
      model: resolveSubagentModel(r.id, cfgNow),
      maxSteps: resolveSubagentMaxSteps(r.id, cfgNow),
      thinking: resolveSubagentThinking(r.id, cfgNow),
    }))) console.log(line);
    console.log("Detail: /agents <role>  ·  set model: /agents <role> <model|#N>  ·  provider: /agents <role> provider <name> [model]  ·  thinking: /agents <role> thinking <level|inherit>  ·  steps: /agents <role> maxSteps <N>  ·  picker: /agents edit");
    console.log("Tip: primary model flow: /model → pick model → choose default or subagent role → choose thinking level");
    console.log(`Available: ${allSubagentRoles(cfgNow).map(r => r.id).join(", ")} (declare custom roles in config.subagents)`);
    console.log("Subcommands: edit, <role> <model|#N>, <role> thinking <level|inherit>, <role> provider <name> [model], <role> maxSteps <N>, <role> reset");
  };
  if (!roleArg || roleArg === "/" || roleArg === "?" || subcommand === "help") {
    printRoster();
    return result();
  }
  if (subcommand === "edit" || subcommand === "picker") {
    printRoster();
    // Interactive editor (TTY): role picker → action picker → live model /
    // thinking / reset — the arrows+Enter way to CHANGE an existing setting.
    const rolePick = await pickFromOptions(
      "Edit a subagent role (ESC to skip)",
      allSubagentRoles(cfgNow).map(r => ({
        value: r.id,
        label: `${r.id} — ${r.title}`,
        hint: `${resolveSubagentModel(r.id, cfgNow)} · ${resolveSubagentMaxSteps(r.id, cfgNow)} steps${cfgNow.subagents?.[r.id]?.model ? "" : " (default)"}`,
      })),
    );
    const editRole = rolePick ? getSubagentRole(rolePick, cfgNow) : undefined;
    if (!editRole) return result();
    const action = await pickFromOptions(`${editRole.title} — choose action`, [
      { value: "model", label: "change model", hint: resolveSubagentModel(editRole.id, cfgNow) },
      { value: "thinking", label: "change thinking", hint: resolveSubagentThinking(editRole.id, cfgNow) ?? `inherit (${cfgNow.thinkingLevel ?? "medium"})` },
      { value: "reset", label: "reset to defaults", hint: "clears model + maxSteps + thinking override" },
    ]);
    if (action === "reset") {
      await saveConfigPatch(raw => ({ subagents: clearSubagentSetting(raw, editRole.id) }));
      console.log(`${editRole.title} settings reset to defaults → ~/.jeo/config.json`);
    } else if (action === "model") {
      const live = await getLiveModels();
      const entries = flattenModels(live);
      const picked = await pickLiveProviderModel(`${editRole.id}`, entries, resolveSubagentModel(editRole.id, cfgNow));
      if (picked) {
        const pinned = qualifyModelId(picked.model, picked.provider);
        await saveConfigPatch(raw => ({ subagents: withSubagentSetting(raw, editRole.id, { model: pinned }) }));
        console.log(`Subagent '${editRole.id}' model set to ${pinned} → ~/.jeo/config.json`);
      }
    } else if (action === "thinking") {
      const lvl = await pickThinkingLevel(
        `Reasoning for ${editRole.title}`,
        cfgNow.subagents?.[editRole.id]?.thinking,
        `inherit — follow default (${cfgNow.thinkingLevel ?? "medium"})`,
      );
      if (lvl) await setRoleThinking(editRole.id, lvl);
    }
    return result();
  }
  const role = getSubagentRole(roleArg, cfgNow);
  if (!role) {
    console.log(`Unknown role '${roleArg}'. Known: ${allSubagentRoles(cfgNow).map(r => r.id).join(", ")}.`);
    return result();
  }
  if (modelArg?.toLowerCase() === "reset") {
    await saveConfigPatch(raw => ({ subagents: clearSubagentSetting(raw, role.id) }));
    console.log(`${role.title} settings reset to defaults → ~/.jeo/config.json`);
    return result();
  }
  if (modelArg?.toLowerCase() === "maxsteps" || modelArg?.toLowerCase() === "steps") {
    const maxSteps = parseMaxSteps(tokens[2]);
    if (!maxSteps) {
      console.log(`Usage: /agents ${role.id} maxSteps <positive-number>`);
      return result();
    }
    await saveConfigPatch(raw => ({ subagents: withSubagentSetting(raw, role.id, { maxSteps }) }));
    console.log(`${role.title} maxSteps set to ${maxSteps} → ~/.jeo/config.json`);
    return result();
  }
  if (modelArg?.toLowerCase() === "thinking" || modelArg?.toLowerCase() === "think") {
    await setRoleThinking(role.id, tokens[2]);
    return result();
  }
  if (modelArg?.toLowerCase() === "provider") {
    const want = (tokens[2] ?? "").toLowerCase();
    if (!isProviderName(want)) {
      console.log(`Usage: /agents ${role.id} provider <name> [model|#N] — e.g. anthropic, openai, gemini, groq, deepseek, openrouter (any configured provider)`);
      return result();
    }
    const st = (await describeAllProviders()).find(s => s.name === want);
    if (st && !st.ready) {
      if (selectableThoughNotReady(st)) {
        console.log(notReadyWarning(st));
      } else {
        console.log(`Cannot pin ${role.title} to ${want}: not ready (${st.label}). Set ${st.envVar ?? "the provider key"} first.`);
        return result();
      }
    }
    const live = await getLiveModels();
    const forProvider = providerPickEntries(live, want);
    const liveForProvider = live.some(r => r.ok && r.provider === want && r.models.length > 0);
    const explicit = tokens[3];
    let chosenModel: string;
    if (explicit && forProvider.length) {
      const sel = resolveSelection(forProvider, explicit);
      if (sel.kind === "index" || sel.kind === "match") chosenModel = qualifyModelId(sel.entry.model, want);
      else if (sel.kind === "ambiguous") {
        console.log(`'${explicit}' matches ${sel.matches.length} ${want} models — be more specific:`);
        for (const e of sel.matches.slice(0, 12)) console.log(`  #${e.index}  ${e.model}`);
        return result();
      } else if (sel.kind === "out-of-range") {
        console.log(`#${explicit.slice(1)} is out of range for ${want} (1-${sel.max}).`);
        return result();
      } else {
        chosenModel = qualifyModelId(explicit, want);
      }
    } else if (explicit) {
      chosenModel = qualifyModelId(explicit, want);
    } else if (forProvider.length) {
      // No model given → the provider's first known model, provider-qualified.
      chosenModel = qualifyModelId(forProvider[0]!.model, want);
    } else {
      chosenModel = providerDefaultModel(want);
    }
    await saveConfigPatch(raw => ({ subagents: withSubagentSetting(raw, role.id, { model: chosenModel }) }));
    console.log(`${role.title} pinned to ${want} via model ${chosenModel} — saved to ~/.jeo/config.json`);
    if (forProvider.length) {
      lastPickIndex = forProvider;
      lastPickIndexChanged = true;
      const sourceNote = liveForProvider ? "Live" : "Catalog";
      const tail = liveForProvider ? "" : " (log in to list live models)";
      console.log(`${sourceNote} ${want} models — refine with /agents ${role.id} #N:${tail}`);
      for (const line of formatPickListWithCapabilities(lastPickIndex, { current: chosenModel, cap: 12 })) console.log(line);
    }
    return result();
  }
  if (modelArg) {
    let chosenModel = modelArg;
    let entries = lastPickIndex;
    if (modelArg.startsWith("#") && entries.length === 0) {
      const live = await getLiveModels();
      entries = flattenModels(live);
    }
    if (entries.length) {
      const sel = resolveSelection(entries, modelArg);
      if (sel.kind === "index" || sel.kind === "match") {
        chosenModel = qualifyModelId(sel.entry.model, sel.entry.provider);
        const bad = (await describeAllProviders()).find(s => s.name === sel.entry.provider && !s.ready);
        if (bad) {
          if (selectableThoughNotReady(bad)) {
            console.log(notReadyWarning(bad));
          } else {
            console.log(`Cannot pin ${sel.entry.model}: ${sel.entry.provider} is not ready (${bad.label}). Set ${bad.envVar ?? "the provider key"} first.`);
            return result();
          }
        }
      } else if (sel.kind === "ambiguous") {
        console.log(`'${modelArg}' matches ${sel.matches.length} live models — be more specific:`);
        for (const e of sel.matches.slice(0, 12)) console.log(`  #${e.index}  ${e.model} (${e.provider})`);
        return result();
      } else if (sel.kind === "out-of-range") {
        console.log(`#${modelArg.slice(1)} is out of range (1-${sel.max}). Use /model first.`);
        return result();
      }
    } else if (modelArg.startsWith("#")) {
      console.log("Use /model first to build the numbered live model list.");
      return result();
    }
    // Persist a per-role model override to ~/.jeo/config.json (consumed by 'jeo team').
    await saveConfigPatch(raw => ({ subagents: withSubagentSetting(raw, role.id, { model: chosenModel }) }));
    const { provider } = await describeModel(chosenModel);
    console.log(`${role.title} model set to ${chosenModel} (${provider}) — saved to ~/.jeo/config.json`);
    const live = await getLiveModels();
    if (!liveModelKnown(live, chosenModel)) {
      console.log(`  (note: '${chosenModel}' is not in any live model list — verify it is valid for ${provider})`);
    }
    return result();
  }
  for (const line of formatAgentDetail(role, {
    model: resolveSubagentModel(role.id, cfgNow),
    maxSteps: resolveSubagentMaxSteps(role.id, cfgNow),
    thinking: resolveSubagentThinking(role.id, cfgNow),
  })) console.log(line);
  const live = await getLiveModels();
  const agentPick = flattenModels(live);
  if (agentPick.length) {
    lastPickIndex = agentPick;
    lastPickIndexChanged = true;
    console.log(`Live models for ${role.title} — pin with /agents ${role.id} #N:`);
    for (const line of formatPickListWithCapabilities(lastPickIndex, { current: resolveSubagentModel(role.id, cfgNow), cap: 20 })) console.log(line);
  }
  return result();
}

const ROLE_TIERS = ["smol", "slow", "plan"] as const;

/**
 * Handle `/roles [tier model]`. Extracted verbatim from launch.ts's inline
 * REPL branch — the caller keeps the `input.startsWith("/roles") &&
 * (input === "/roles" || input[6] === " ")` guard and just calls this
 * function.
 */
export async function runRolesSlash(input: string, ctx: AgentsSlashCtx): Promise<AgentsSlashResult> {
  const { getLiveModels } = ctx;
  let lastPickIndex = ctx.lastPickIndex;
  let lastPickIndexChanged = false;

  const result = (): AgentsSlashResult => ({
    ...(lastPickIndexChanged ? { lastPickIndex } : {}),
  });

  const tokens = input.substring(6).trim().split(/\s+/).filter(Boolean);
  const cfgNow = await readGlobalConfig();
  if (tokens.length >= 2 && (ROLE_TIERS as readonly string[]).includes(tokens[0])) {
    const tier = tokens[0] as (typeof ROLE_TIERS)[number];
    let chosenModel = tokens[1]!;
    let entries = lastPickIndex;
    if (chosenModel.startsWith("#") && entries.length === 0) {
      const live = await getLiveModels();
      entries = flattenModels(live);
    }
    if (entries.length) {
      const sel = resolveSelection(entries, chosenModel);
      if (sel.kind === "index" || sel.kind === "match") {
        chosenModel = qualifyModelId(sel.entry.model, sel.entry.provider);
        const bad = (await describeAllProviders()).find(s => s.name === sel.entry.provider && !s.ready);
        if (bad) {
          console.log(`Cannot set role ${tier} to ${sel.entry.model}: ${sel.entry.provider} is not ready (${bad.label}). Set ${bad.envVar ?? "the provider key"} first.`);
          return result();
        }
      } else if (sel.kind === "ambiguous") {
        console.log(`'${chosenModel}' matches ${sel.matches.length} live models — be more specific:`);
        for (const e of sel.matches.slice(0, 12)) console.log(`  #${e.index}  ${e.model} (${e.provider})`);
        return result();
      } else if (sel.kind === "out-of-range") {
        console.log(`#${chosenModel.slice(1)} is out of range (1-${sel.max}). Use /model first.`);
        return result();
      }
    } else if (chosenModel.startsWith("#")) {
      console.log("Use /model first to build the numbered live model list.");
      return result();
    }
    await saveConfigPatch(raw => ({ roles: { ...(raw.roles ?? {}), [tier]: chosenModel } }));
    console.log(`Role '${tier}' model set to ${chosenModel} → ~/.jeo/config.json`);
    return result();
  }
  console.log("Model role tiers (fall back to the default model):");
  for (const tier of ROLE_TIERS) {
    const { provider } = await describeModel(resolveRoleModel(tier, cfgNow));
    console.log(`  ${tier.padEnd(5)} ${resolveRoleModel(tier, cfgNow)} (${provider})`);
  }
  console.log("Set a tier: /roles <smol|slow|plan> <model>");
  const live = await getLiveModels();
  const rolePick = flattenModels(live);
  if (rolePick.length) {
    lastPickIndex = rolePick;
    lastPickIndexChanged = true;
    console.log("Live models for role tiers — set with /roles <tier> #N:");
    for (const line of formatPickListWithCapabilities(lastPickIndex, { cap: 15 })) console.log(line);
  }
  return result();
}

/**
 * Handle `/fast [on|off|status]`. Extracted verbatim from launch.ts's inline
 * REPL branch — the caller keeps the `input.startsWith("/fast") && (input
 * === "/fast" || input[5] === " ")` guard and just calls this function.
 */
export async function runFastSlash(input: string, ctx: AgentsSlashCtx): Promise<AgentsSlashResult> {
  let sessionThinking = ctx.sessionThinking;
  let sessionThinkingChanged = false;

  const result = (): AgentsSlashResult => ({
    ...(sessionThinkingChanged ? { sessionThinking } : {}),
  });

  const arg = input.substring(5).trim().toLowerCase() || "status";
  const cfgNow = await readGlobalConfig();
  const currentModel = ctx.sessionModel || cfgNow.defaultModel;
  const { resolved, provider } = await describeModel(currentModel);
  const fastLevel = fastThinkingLevelForModel(resolved);
  const currentThinking = sessionThinking ?? cfgNow.thinkingLevel ?? "medium";
  const status = fastLevel && currentThinking === fastLevel ? "on" : "off";
  if (arg === "status") {
    const support = fastLevel ? `supported (thinking ${fastLevel})` : "unsupported";
    console.log(`Fast mode: ${status} · ${support} · ${formatModelLine({ label: currentModel, resolved, provider })} · current thinking ${currentThinking}`);
    return result();
  }
  if (arg === "on") {
    if (!fastLevel) {
      console.log(`Fast mode is not advertised for ${formatModelLine({ label: currentModel, resolved, provider })}; pick a thinking-capable model with /model.`);
      return result();
    }
    sessionThinking = fastLevel;
    sessionThinkingChanged = true;
    console.log(`Fast mode on: ${formatModelLine({ label: currentModel, resolved, provider })} · thinking ${fastLevel} (~${thinkingMaxTokens(fastLevel)} max tokens/step)`);
    return result();
  }
  if (arg === "off") {
    sessionThinking = cfgNow.thinkingLevel ?? "medium";
    sessionThinkingChanged = true;
    console.log(`Fast mode off: restored thinking ${sessionThinking} (~${thinkingMaxTokens(sessionThinking)} max tokens/step)`);
    return result();
  }
  console.log("Usage: /fast [on|off|status]");
  return result();
}

/**
 * Handle `/thinking [level]`. Extracted verbatim from launch.ts's inline
 * REPL branch — the caller keeps the `input.startsWith("/thinking") &&
 * (input === "/thinking" || input[9] === " ")` guard and just calls this
 * function.
 */
export async function runThinkingSlash(input: string, ctx: AgentsSlashCtx): Promise<AgentsSlashResult> {
  let sessionThinking = ctx.sessionThinking;
  let sessionThinkingChanged = false;

  const result = (): AgentsSlashResult => ({
    ...(sessionThinkingChanged ? { sessionThinking } : {}),
  });

  const arg = input.substring(9).trim().toLowerCase();
  if (!arg) {
    console.log(`Thinking level: ${sessionThinking ?? "medium"} (~${thinkingMaxTokens(sessionThinking)} max tokens/step)`);
    return result();
  }
  if (arg === "low" || arg === "medium" || arg === "high" || arg === "xhigh") {
    sessionThinking = arg;
    sessionThinkingChanged = true;
    console.log(`Thinking set to ${arg} (~${thinkingMaxTokens(arg)} max tokens/step)`);
  } else {
    console.log(`Invalid level '${arg}'. Use: low | medium | high | xhigh.`);
  }
  return result();
}
