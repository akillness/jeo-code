import { findCatalogEntry } from "../ai/model-catalog-compat";
import { CODEX_MODELS } from "../ai/model-catalog";
import { z } from "zod";

/**
 * Runtime validation for `~/.joc/config.json`. Previously the file was
 * `JSON.parse`d and cast straight to `Config` — a wrong-typed field (e.g. a
 * numeric `defaultModel`) slipped through untyped and surfaced as a confusing
 * downstream failure. `parseConfig` turns that into a clear, actionable signal.
 */
const StoredOAuthSchema = z.object({
  access: z.string(),
  refresh: z.string().optional(),
  expires: z.number().optional(),
  accountId: z.string().optional(),
  email: z.string().optional(),
  projectId: z.string().optional(),
});

const OAuthEntry = z.union([z.string(), StoredOAuthSchema]);
const HookConfigSchema = z.object({
  enabled: z.boolean().optional(),
  hooks: z
    .array(
      z.object({
        event: z.enum(["pre-tool", "post-turn", "post-implementation"]),
        match: z
          .object({
            tool: z.string().optional(),
          })
          .optional(),
        run: z.string(),
        timeoutMs: z.number().int().min(1).optional(),
      })
    )
    .optional(),
});


export const ConfigSchema = z
  .object({
    providers: z
      .object({
        anthropic: z.string().optional(),
        openai: z.string().optional(),
        gemini: z.string().optional(),
        antigravity: z.string().optional(),
      })
      .default({}),
    oauth: z
      .object({
        anthropic: OAuthEntry.optional(),
        openai: OAuthEntry.optional(),
        gemini: OAuthEntry.optional(),
        antigravity: OAuthEntry.optional(),
      })
      .optional(),
    ollamaBaseUrl: z.string().optional(),
    openaiBaseUrl: z.string().optional(),
    defaultModel: z.string().min(1),
    thinkingLevel: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
    modelAliases: z.record(z.string()).optional(),
    /** Most-recently-selected models, newest first (drives the default + pickers). */
    recentModels: z.array(z.string()).optional(),
    /**
     * Provider retry budgets (gjc parity). `requestMaxRetries` is used for non-stream
     * calls and stream initial connections; `streamMaxRetries` is used for stream retries.
     * `maxRetries` is the fallback budget when either is unset; `maxDelayMs` caps backoff.
     */
    retry: z
      .object({
        requestMaxRetries: z.number().int().min(0).optional(),
        streamMaxRetries: z.number().int().min(0).optional(),
        maxRetries: z.number().int().min(0).optional(),
        maxDelayMs: z.number().int().min(0).optional(),
        rateLimitRetries: z.number().int().min(0).optional(),
        rateLimitMinDelayMs: z.number().int().min(0).optional(),
      })
      .optional(),
    /**
     * Per-subagent-role overrides (gjc role-agent parity). Keyed by role id
     * (executor / planner / architect / critic); each may pin a model and/or a
     * step budget. Tolerant of unknown keys.
     */
    subagents: z
      .record(
        z.object({
          model: z.string().optional(),
          // Tolerated, informational provider tag (model ids are persisted provider-qualified)
          provider: z.enum(["anthropic", "openai", "gemini", "antigravity", "ollama"]).optional(),
          maxSteps: z.number().int().min(1).optional(),
          /** Per-role reasoning budget; absent = inherit the global thinkingLevel. */
          thinking: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
        }),
      )
      .optional(),
    /** Model role tiers (smol/slow/plan); each falls back to defaultModel. */
    roles: z
      .object({
        smol: z.string().optional(),
        slow: z.string().optional(),
        plan: z.string().optional(),
      })
      .optional(),
    hooks: HookConfigSchema.optional(),
  })
  .passthrough();

export type ValidatedConfig = z.infer<typeof ConfigSchema>;

/** Validate parsed JSON against the config schema. Returns a tagged result, never throws. */
const BUILTIN_ALIASES = new Set(["fast", "local", "sonnet", "opus", "haiku", "gpt", "flash"]);

function normalizeModelId(id: string | undefined, aliases: Record<string, string>): string | undefined {
  if (!id) return id;
  const trimmed = id.trim();
  const lower = trimmed.toLowerCase();

  // 1. 이미 접두사가 있는가? (ollama/, openai/, anthropic/, google/, antigravity/)
  if (
    lower.startsWith("ollama/") ||
    lower.startsWith("openai/") ||
    lower.startsWith("anthropic/") ||
    lower.startsWith("google/") ||
    lower.startsWith("antigravity/")
  ) {
    return trimmed;
  }

  // 2. catalog canonical인가?
  if (findCatalogEntry(trimmed)) {
    return trimmed;
  }

  // 3. CODEX 모델인가?
  if (CODEX_MODELS.includes(trimmed)) {
    return trimmed;
  }

  // 4. alias인가?
  if (trimmed in aliases || BUILTIN_ALIASES.has(trimmed)) {
    return trimmed;
  }

  // 5. 접두사가 없고, :tag를 포함하는가?
  if (trimmed.includes(":")) {
    return `ollama/${trimmed}`;
  }

  return trimmed;
}

export function parseConfig(raw: unknown): { ok: true; config: ValidatedConfig } | { ok: false; message: string } {
  const result = ConfigSchema.safeParse(raw);
  if (result.success) {
    const config = result.data;
    const aliases = config.modelAliases || {};

    if (config.defaultModel) {
      config.defaultModel = normalizeModelId(config.defaultModel, aliases) || config.defaultModel;
    }

    if (config.roles) {
      if (config.roles.smol) {
        config.roles.smol = normalizeModelId(config.roles.smol, aliases);
      }
      if (config.roles.slow) {
        config.roles.slow = normalizeModelId(config.roles.slow, aliases);
      }
      if (config.roles.plan) {
        config.roles.plan = normalizeModelId(config.roles.plan, aliases);
      }
    }

    if (config.subagents) {
      for (const key of Object.keys(config.subagents)) {
        const sub = config.subagents[key];
        if (sub && sub.model) {
          sub.model = normalizeModelId(sub.model, aliases);
        }
      }
    }

    return { ok: true, config };
  }
  const issue = result.error.issues[0];
  const where = issue?.path?.length ? issue.path.join(".") : "config";
  return { ok: false, message: `${where}: ${issue?.message ?? "invalid"}` };
}
