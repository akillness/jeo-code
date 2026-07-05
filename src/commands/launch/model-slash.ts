/**
 * `/model` slash-command handler extracted from launch.ts.
 *
 * Handles `/model [id|#N|save [id]|thinking <level>|subagent <role> [model|#N]]`
 * (default: interactive live-model picker on a TTY, else prints the current
 * model + a numbered pick list). This block shares mutable REPL state with
 * still-inline commands (`/agents`, `/roles`, `/provider` also read/write
 * `lastPickIndex`; `/thinking` reads/writes `sessionThinking`), so the caller
 * passes the current values in via an explicit context object and reads back
 * a result object instead of this function closing over REPL state directly.
 */

import { readGlobalConfig, saveConfigPatch } from "../../agent/state";
import { rememberModelPatch, recentModelsForDisplay } from "../../agent/model-recency";
import {
  describeModel,
  describeAllProviders,
  thinkingMaxTokens,
  flattenModels,
  resolveSelection,
  catalogMetadata,
  CODEX_MODELS,
  qualifyModelId,
} from "../../ai";
import type { ProviderModelsResult, PickEntry, ProviderName, ThinkLevel } from "../../ai";
import { getSubagentRole, resolveSubagentModel, withSubagentSetting } from "../../agent/subagents";
import { formatModelLine, liveModelKnown, formatPickListWithCapabilities, formatCapabilityLine } from "../../tui/components/config-panel";
import { isThinkingLevel } from "./flags";

// Antigravity with ANY Google OAuth (own login or the gemini-cli fallback) stays
// SELECTABLE in pickers even when not call-ready: picking the model is how users
// reach the flow, and the auth layer gives actionable login guidance on the first
// call if the fallback token is rejected (403). Refusing selection was a dead end.
// Pure predicate — mirrors the identically-named REPL-local const in launch.ts.
const selectableThoughNotReady = (st?: { name: string; kind: string }): boolean =>
  !!st && st.name === "antigravity" && st.kind === "oauth";

export interface ModelSlashCtx {
  sessionModel: string | undefined;
  sessionThinking: ThinkLevel | undefined;
  defaultModel: string;
  lastPickIndex: PickEntry[];
  liveModelsCache: ProviderModelsResult[] | null;
  isTTY: boolean;
  getLiveModels: (force?: boolean) => Promise<ProviderModelsResult[]>;
  applyPickedModelWithTarget: (target: string) => Promise<boolean>;
  persistSessionModel: () => Promise<void>;
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
}

export interface ModelSlashResult {
  /** Present only when changed. */
  sessionModel?: string;
  /** Present only when changed. */
  sessionThinking?: ThinkLevel;
  /** Present only when the block builds/refreshes a pick list. */
  lastPickIndex?: PickEntry[];
}

/**
 * Handle `/model [id|#N|save|thinking <level>|subagent <role> ...]`. Extracted
 * verbatim from launch.ts's inline REPL branch — the caller keeps the
 * `input.startsWith("/model") && (input === "/model" || input[6] === " ")`
 * guard and just calls this function.
 */
export async function runModelSlash(input: string, ctx: ModelSlashCtx): Promise<ModelSlashResult> {
  const { defaultModel, isTTY, getLiveModels, applyPickedModelWithTarget, persistSessionModel, pickLiveProviderModel } = ctx;
  let sessionModel = ctx.sessionModel;
  let sessionModelChanged = false;
  let sessionThinking = ctx.sessionThinking;
  let sessionThinkingChanged = false;
  let lastPickIndex = ctx.lastPickIndex;
  let lastPickIndexChanged = false;
  const liveModelsCache = ctx.liveModelsCache;

  const result = (): ModelSlashResult => ({
    ...(sessionModelChanged ? { sessionModel } : {}),
    ...(sessionThinkingChanged ? { sessionThinking } : {}),
    ...(lastPickIndexChanged ? { lastPickIndex } : {}),
  });

  let arg = input.substring(6).trim();
  // `/model save [id]` → persist the (session or given) model as the config default.
  if (arg === "save" || arg.startsWith("save ")) {
    let toSave = arg.slice(4).trim();
    // Resolve `#N`/fuzzy through the same pick-list logic as `/model #N`, so we never
    // persist a literal token like "#2" as defaultModel (which then fails to route).
    if (toSave && lastPickIndex.length) {
      const sel = resolveSelection(lastPickIndex, toSave);
      if (sel.kind === "index" || sel.kind === "match") toSave = qualifyModelId(sel.entry.model, sel.entry.provider);
      else if (sel.kind === "ambiguous") {
        console.log(`'${toSave}' matches ${sel.matches.length} models — be more specific:`);
        for (const e of sel.matches.slice(0, 12)) console.log(`  #${e.index}  ${e.model} (${e.provider})`);
        return result();
      } else if (sel.kind === "out-of-range") {
        console.log(`#${toSave.slice(1)} is out of range (1-${sel.max}). Use /model first.`);
        return result();
      }
      // kind "none" → treat `toSave` as a literal model id/alias.
    } else if (toSave.startsWith("#")) {
      console.log("Use /model first to build the numbered list.");
      return result();
    }
    // Fall back to the FRESH on-disk default (not the stale session-start snapshot) so a
    // bare `/model save` after a prior `/model save <id>` never reverts the saved default.
    const finalSave = toSave || sessionModel || (await readGlobalConfig()).defaultModel;
    await saveConfigPatch(raw => rememberModelPatch(raw, finalSave));
    const { resolved, provider } = await describeModel(finalSave);
    console.log(`Default model saved: ${formatModelLine({ label: finalSave, resolved, provider })} → ~/.jeo/config.json`);
    return result();
  }
  const modelThinking = /^(?:thinking|think)(?:\s+(\S+))?$/i.exec(arg);
  if (modelThinking) {
    const level = (modelThinking[1] ?? "").toLowerCase();
    if (!isThinkingLevel(level)) {
      console.log("Usage: /model thinking <minimal|low|medium|high|xhigh>");
      return result();
    }
    sessionThinking = level;
    sessionThinkingChanged = true;
    await saveConfigPatch(() => ({ thinkingLevel: level }));
    console.log(`Default thinking set to ${level} (~${thinkingMaxTokens(level)} max tokens/step) → ~/.jeo/config.json`);
    return result();
  }
  const statuses = await describeAllProviders();
  const disabledModelProviders = statuses.filter(s => !s.ready && !selectableThoughNotReady(s)).map(s => s.name);
  const roleMatch = /^(subagent|role)\s+(\S+)(?:\s+(.+))?$/i.exec(arg);
  if (roleMatch) {
    const role = getSubagentRole(roleMatch[2] ?? "", await readGlobalConfig());
    if (!role) {
      console.log("Usage: /model subagent <executor|planner|architect|critic> [model|#N]");
      return result();
    }
    let roleModelArg = (roleMatch[3] ?? "").trim();
    const roleThinking = /^(?:thinking|think)(?:\s+(\S+))?$/i.exec(roleModelArg);
    if (roleThinking) {
      console.log(`Subagent thinking is set via /agents — try: /agents ${role.id} thinking ${roleThinking[1] ?? "<level|inherit>"}  (or /agents edit). /model only sets the default thinking.`);
      return result();
    }

    if (!roleModelArg && isTTY) {
      const live = await getLiveModels();
      lastPickIndex = flattenModels(live);
      lastPickIndexChanged = true;
      if (lastPickIndex.length) {
        const currentResolved = (await describeModel(resolveSubagentModel(role.id, await readGlobalConfig()))).resolved;
        const picked = await pickLiveProviderModel(role.id, lastPickIndex, currentResolved, disabledModelProviders);
        if (!picked) {
          console.log("(cancelled)");
          return result();
        }
        roleModelArg = qualifyModelId(picked.model, picked.provider);

      }
    }
    if (roleModelArg && lastPickIndex.length) {
      const sel = resolveSelection(lastPickIndex, roleModelArg);
      if (sel.kind === "index" || sel.kind === "match") {
        if (disabledModelProviders.includes(sel.entry.provider)) {
          const bad = statuses.find(s => s.name === sel.entry.provider);
          console.log(`Cannot select ${sel.entry.model}: ${sel.entry.provider} is not ready (${bad?.label ?? "not ready"}). Set ${bad?.envVar ?? "the provider key"} first.`);
          return result();
        }
        roleModelArg = qualifyModelId(sel.entry.model, sel.entry.provider);

      } else if (sel.kind === "ambiguous") {
        console.log(`'${roleModelArg}' matches ${sel.matches.length} models — be more specific:`);
        for (const e of sel.matches.slice(0, 12)) console.log(`  #${e.index}  ${e.model} (${e.provider})`);
        return result();
      } else if (sel.kind === "out-of-range") {
        console.log(`#${roleModelArg.slice(1)} is out of range (1-${sel.max}). Use /model first.`);
        return result();
      }
    } else if (roleModelArg.startsWith("#")) {
      console.log("Use /model first to build the numbered list.");
      return result();
    }
    if (roleModelArg) {
      await saveConfigPatch(raw => ({ subagents: withSubagentSetting(raw, role.id, { model: roleModelArg }) }));
      const { provider } = await describeModel(roleModelArg);
      console.log(`${role.title} model set to ${roleModelArg} (${provider}) — saved to ~/.jeo/config.json. Set its thinking via /agents ${role.id} thinking <level> (or /agents edit).`);
    } else {
      const current = resolveSubagentModel(role.id, await readGlobalConfig());
      const { resolved, provider } = await describeModel(current);
      console.log(`${role.title} model: ${formatModelLine({ label: current, resolved, provider })}`);
      const live = await getLiveModels();
      lastPickIndex = flattenModels(live);
      lastPickIndexChanged = true;
      if (lastPickIndex.length) {
        console.log(`Live models for ${role.title} — set with /model subagent ${role.id} #N:`);
        for (const line of formatPickListWithCapabilities(lastPickIndex, { current: resolved, cap: 20 })) console.log(line);
      }
    }
    return result();
  }
  let modelPickedFromSelector = false;
  if (!arg && isTTY) {
    const live = await getLiveModels();
    lastPickIndex = flattenModels(live);
    lastPickIndexChanged = true;
    if (lastPickIndex.length) {
      const currentResolved = (await describeModel(sessionModel || defaultModel)).resolved;
      const picked = await pickLiveProviderModel("live", lastPickIndex, currentResolved, disabledModelProviders);
      if (!picked) {
        console.log("(cancelled)");
        return result();
      }
      arg = qualifyModelId(picked.model, picked.provider);
      modelPickedFromSelector = true;
    }
  }
  // Selection from the last numbered pick list (`#N`) or a fuzzy substring.
  if (arg && lastPickIndex.length) {
    const sel = resolveSelection(lastPickIndex, arg);
    if (sel.kind === "index" || sel.kind === "match") {
      if (disabledModelProviders.includes(sel.entry.provider)) {
        const bad = statuses.find(s => s.name === sel.entry.provider);
        console.log(`Cannot select ${sel.entry.model}: ${sel.entry.provider} is not ready (${bad?.label ?? "not ready"}). Set ${bad?.envVar ?? "the provider key"} first.`);
        return result();
      }
      arg = qualifyModelId(sel.entry.model, sel.entry.provider);
      modelPickedFromSelector = true;
    } else if (sel.kind === "ambiguous") {
      console.log(`'${arg}' matches ${sel.matches.length} models — be more specific:`);
      for (const e of sel.matches.slice(0, 12)) console.log(`  #${e.index}  ${e.model} (${e.provider})`);
      return result();
    } else if (sel.kind === "out-of-range") {
      console.log(`#${arg.slice(1)} is out of range (1-${sel.max}). Use /model first.`);
      return result();
    }
    // kind "none" → fall through and treat `arg` as a literal model id/alias.
  } else if (arg.startsWith("#")) {
    console.log("Use /model first to build the numbered list.");
    return result();
  }
  const label = arg || (sessionModel || defaultModel);
  if (arg && modelPickedFromSelector && await applyPickedModelWithTarget(arg)) {
    return result();
  }
  if (arg) {
    sessionModel = arg;
    sessionModelChanged = true;
    // MRU persistence: picking a model IS saving it — the newest pick wins
    // as the global default; recents keep the rotation for every session.
    await saveConfigPatch(raw => rememberModelPatch(raw, arg));
    await persistSessionModel();
  }
  const { resolved, provider } = await describeModel(label);
  const st = statuses.find(s => s.name === provider);
  console.log(`${arg ? "Model set to" : "Current model"}: ${formatModelLine({ label, resolved, provider, ready: st?.ready })}${arg ? " — saved as default" : ""}`);
  if (st && !st.ready) console.log(`  ! ${provider} is not ready (${st.label}) — set ${st.envVar ?? "the provider key"} or run 'jeo setup'.`);
  // ChatGPT OAuth only serves the Codex models; warn before the turn fails if the user
  // pins a non-Codex id with no local base URL to fall back to (gjc-parity readiness guard).
  if (arg && provider === "openai" && st?.kind === "oauth" && !CODEX_MODELS.includes(resolved)) {
    const hasLocalBase = !!((await readGlobalConfig()).openaiBaseUrl || process.env.OPENAI_BASE_URL);
    if (!hasLocalBase) {
      console.log(`  ! ChatGPT OAuth serves only Codex models (${CODEX_MODELS.join(", ")}); '${resolved}' will be rejected at runtime — pick one of those, or set OPENAI_API_KEY / OPENAI_BASE_URL.`);
    }
  }
  if (arg && liveModelsCache && resolved === label && !liveModelKnown(liveModelsCache, resolved)) {
    console.log(`  (note: '${resolved}' is not in the live ${provider} catalog — use /model to pick a valid id)`);
  }
  const meta = catalogMetadata(resolved);
  if (meta) console.log(`  ${formatCapabilityLine(meta)}`);
  if (!arg) {
    const recents = recentModelsForDisplay(await readGlobalConfig());
    if (recents.length > 1) {
      console.log("Recent models (newest first):");
      recents.slice(0, 5).forEach((m, i) => console.log(`  ${i + 1}. ${m}${i === 0 ? "  ◀ default" : ""}`));
    }
    const live = await getLiveModels();
    lastPickIndex = flattenModels(live);
    lastPickIndexChanged = true;
    console.log("Live models (logged-in providers) — set with /model #N:");
    for (const line of formatPickListWithCapabilities(lastPickIndex, { current: resolved, cap: 20 })) console.log(line);
  }
  console.log("  (model picks persist automatically — newest selection is the default everywhere)");
  return result();
}
