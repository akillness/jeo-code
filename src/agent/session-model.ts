/**
 * Session-start model resolution against the models jeo is actually logged in to.
 *
 * A session opens on the configured default model. That default is honored only
 * when the stored login can serve it; otherwise the first turn would fail with
 * "No credential for provider …" even though another logged-in model works. In that
 * case the session starts on the first authenticated candidate (recents, then role
 * tiers) and says so. The saved config is never rewritten here: the fallback is
 * session-local, so the configured default is untouched.
 *
 * Fail-open: a probe that throws keeps the configured default.
 */
import { describeModel, modelServableWithConfig } from "../ai/model-manager";
import { describeProvider } from "../ai/provider-status";
import { customProviderDef } from "../ai/providers/custom-providers";
import type { Config } from "./state";

export type ModelAuthCheck = (model: string, cfg: Config) => Promise<boolean>;

export interface StartupModel {
  /** The model the session should treat as its default. */
  model: string;
  /** The configured default this replaced, when no login could serve it. */
  fellBackFrom?: string;
  /** One-line explanation for the user, present only when a fallback happened. */
  notice?: string;
}

/**
 * Whether jeo's stored credentials can serve `model` right now. Same two gates
 * routing uses: the provider has a live credential, and, for built-in providers,
 * that credential serves this specific model (ChatGPT OAuth serves only Codex ids).
 * agy runs as an external CLI session and custom providers resolve their own key,
 * so for those only provider readiness applies. Local providers are keyless.
 */
export const isModelAuthenticated: ModelAuthCheck = async (model, cfg) => {
  const { resolved, provider } = await describeModel(model, cfg);
  const status = await describeProvider(provider, cfg);
  if (!status.ready) return false;
  if (provider === "agy" || customProviderDef(provider)) return true;
  return modelServableWithConfig(provider, resolved, cfg);
};

const FALLBACK_ROLES = ["medium", "high", "smol", "xhigh", "slow", "plan"] as const;

/** Fallback order: the user's recently picked models, then their configured role tiers. */
function fallbackCandidates(cfg: Config): string[] {
  const ordered = [...(cfg.recentModels ?? []), ...FALLBACK_ROLES.map(role => cfg.roles?.[role])];
  const seen = new Set<string>([cfg.defaultModel]);
  const out: string[] = [];
  for (const model of ordered) {
    if (typeof model !== "string" || !model.trim() || seen.has(model)) continue;
    seen.add(model);
    out.push(model);
  }
  return out;
}

/**
 * Resolve the model a new session should open on: the configured default when the
 * login serves it, else the first authenticated fallback, else the configured
 * default unchanged (the first turn then reports the real credential error).
 */
export async function resolveStartupDefaultModel(cfg: Config, check: ModelAuthCheck = isModelAuthenticated): Promise<StartupModel> {
  const configured = cfg.defaultModel;
  try {
    if (await check(configured, cfg)) return { model: configured };
  } catch {
    return { model: configured };
  }
  for (const candidate of fallbackCandidates(cfg)) {
    let ok = false;
    try { ok = await check(candidate, cfg); } catch { ok = false; }
    if (!ok) continue;
    let provider = "its provider";
    try { provider = (await describeModel(configured, cfg)).provider; } catch { /* keep the generic wording */ }
    return {
      model: candidate,
      fellBackFrom: configured,
      notice: `[model] default '${configured}' has no usable ${provider} login; this session starts on authenticated '${candidate}'. Run 'jeo auth login ${provider}' to restore it, or /model to pick another.`,
    };
  }
  return { model: configured };
}
