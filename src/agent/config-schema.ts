import { findCatalogEntry } from "../ai/model-catalog-compat";
import { OPENAI_COMPAT_PROVIDERS } from "../ai/providers/openai-compatible-catalog";
import { CODEX_MODELS } from "../ai/model-catalog";
import { z } from "zod";

/**
 * Runtime validation for `~/.jeo/config.json`. Previously the file was
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
// Catalog-driven OpenAI-compatible providers contribute their own apiKey + oauth-slot
// schema keys (incl. hyphenated names like `alibaba-coding-plan`), so config-file keys
// are validated/kept rather than stripped. Adding a provider = one catalog row.
const compatKeySchema = Object.fromEntries(OPENAI_COMPAT_PROVIDERS.map(p => [p.name, z.string().optional()]));
const compatOAuthSchema = Object.fromEntries(OPENAI_COMPAT_PROVIDERS.map(p => [p.name, OAuthEntry.optional()]));
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
        xai: z.string().optional(),
        kimi: z.string().optional(),
        ...compatKeySchema,
      })
      .default({}),
    oauth: z
      .object({
        anthropic: OAuthEntry.optional(),
        openai: OAuthEntry.optional(),
        gemini: OAuthEntry.optional(),
        antigravity: OAuthEntry.optional(),
        xai: OAuthEntry.optional(),
        kimi: OAuthEntry.optional(),
        ...compatOAuthSchema,
      })
      .optional(),
    ollamaBaseUrl: z.string().optional(),
    ollamaNumCtx: z.number().int().positive().optional(),
    openaiBaseUrl: z.string().optional(),
    lmstudioBaseUrl: z.string().optional(),
    defaultModel: z.string().min(1),
    theme: z.string().optional(),
    /** Terminal-bell notifications (gajae-code 0.7.8 parity): emit an ASCII BEL
     *  (\x07) at notable interaction points so a backgrounded session pings the
     *  user. Off by default; `bell` is the master toggle, per-event flags refine it.
     *  Env `JEO_NOTIFY_BELL=1/0` force-overrides the master toggle. */
    notify: z
      .object({
        bell: z.boolean().optional(),
        onComplete: z.boolean().optional(),
        onAsk: z.boolean().optional(),
      })
      .optional(),
    /** Remote subagent visibility/control over Telegram (gjc Telegram-daemon
     *  parity, scoped to subagents — see `src/agent/notify/`). `enabled` is the
     *  master toggle; a session only starts publishing its loopback endpoint
     *  when this is true, and `jeo notify-daemon-run` refuses to poll Telegram
     *  without a stored botToken + chatId. */
    notifications: z
      .object({
        enabled: z.boolean().optional(),
        /** Session-local default notification verbosity; a running session's
         *  in-memory value (mutable via a `/verbosity` config_command from
         *  Telegram) starts from this and reverts here on restart. */
        verbosity: z.enum(["lean", "verbose"]).optional(),
        /** Session-local default redaction of mirrored turn/context text sent
         *  to Telegram; same session-local-only mutability as `verbosity`. */
        redact: z.boolean().optional(),
        telegram: z
          .object({
            botToken: z.string().optional(),
            chatId: z.string().optional(),
            /** Forum-topic thread id (message_thread_id) for supergroups with
             *  topics enabled — daemon pushes go into this topic. Ignored for a
             *  session-owned topic when `perSessionTopics` is true. */
            topicId: z.number().optional(),
            /** Auto-create and manage ONE forum topic per interactive session
             *  (gjc per-session-thread parity), instead of the single flat/global
             *  `topicId` above. Requires the paired chat to be a supergroup with
             *  Topics enabled AND private (fail-closed — see `TopicRegistry`).
             *  Off by default; existing flat-topic/no-topic setups are unaffected. */
            perSessionTopics: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),

    /** Root path of the global llm-wiki vault, shared across every session
     *  regardless of project/cwd. A leading `~` is expanded; env `JEO_WIKI_ROOT`
     *  overrides. Consumed by `resolveWikiRoot` and injected into the prompt. */
    wikiRoot: z.string().optional(),
    thinkingLevel: z.enum(["low", "medium", "high", "xhigh"]).optional(),
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
        rateLimitMaxServerDelayMs: z.number().int().min(0).optional(),
        /** HTTP statuses to treat as NON-retryable even when defaultRetryable would
         *  retry them (e.g. pin 503 to fail fast instead of riding the backoff ladder).
         *  Bug fix: this field (and failFastPatterns below) existed on Config.retry in
         *  state.ts and was actively read by model-manager.ts, but was never declared
         *  on THIS nested z.object — since only the OUTER ConfigSchema calls
         *  `.passthrough()`, Zod's default strip-unknown-keys behavior silently dropped
         *  both fields on every config read/write that round-tripped through this
         *  schema, even though the user's config.json faithfully stored them on disk. */
        failFastStatuses: z.array(z.number().int()).optional(),
        /** Case-insensitive substrings; an error whose message matches any of these
         *  fails fast (non-retryable) even when the chosen predicate would retry it. */
        failFastPatterns: z.array(z.string()).optional(),
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
          thinking: z.enum(["low", "medium", "high", "xhigh"]).optional(),
          // ─── Custom-role declaration (SYSTEM-driven registry) ───
          // An entry under a NON-bundled id that sets any of these becomes a
          // first-class subagent role at runtime — no code change required.
          /** Human title shown in /agents listings. */
          title: z.string().optional(),
          /** One-line purpose (also fed into the default prompt template). */
          description: z.string().optional(),
          /** Role prompt template ({{TOOL_PROTOCOL}}/{{ROLE_TITLE}}/{{ROLE_DESCRIPTION}} supported). */
          prompt: z.string().optional(),
          /** Custom roles default to READ-ONLY; set false to allow edits. */
          readOnly: z.boolean().optional(),
        }),
      )
      .optional(),
    /** Model role tiers (smol/slow/plan); each falls back to defaultModel. */
    roles: z
      .object({
        smol: z.string().optional(),
        medium: z.string().optional(),
        high: z.string().optional(),
        xhigh: z.string().optional(),
        slow: z.string().optional(),
        plan: z.string().optional(),
      })
      .optional(),
    /** Prompt-content-based per-turn model routing (PromptRouter). Opt-in — off unless
     *  `enabled: true`. Applies ONLY to the main interactive turn loop (never to
     *  subagents/`task`, which keep their own `subagents.*`/role-tier resolution
     *  untouched), and ONLY when the user has not manually pinned a session model
     *  via `/model` (explicit user choice always wins). */
    routing: z
      .object({
        enabled: z.boolean().optional(),
        confidenceThreshold: z.number().min(0).max(1).optional(),
        tiers: z
          .object({
            trivial: z.object({ model: z.string().optional(), thinking: z.enum(["low", "medium", "high", "xhigh"]).optional() }).optional(),
            standard: z.object({ model: z.string().optional(), thinking: z.enum(["low", "medium", "high", "xhigh"]).optional() }).optional(),
            high: z.object({ model: z.string().optional(), thinking: z.enum(["low", "medium", "high", "xhigh"]).optional() }).optional(),
            complex: z.object({ model: z.string().optional(), thinking: z.enum(["low", "medium", "high", "xhigh"]).optional() }).optional(),
          })
          .optional(),
        crossProviderPool: z.boolean().optional(),
      })
      .optional(),
    gitAutoCommit: z.boolean().optional(),
    hooks: HookConfigSchema.optional(),
    computer: z
      .object({
        enabled: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough();

export type ValidatedConfig = z.infer<typeof ConfigSchema>;

/** Validate parsed JSON against the config schema. Returns a tagged result, never throws. */
const BUILTIN_ALIASES = new Set(["fast", "local", "sonnet", "opus", "gpt", "flash"]);

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

/** Migrate the retired "minimal" thinking level to "low" on every field that could carry
 *  it, BEFORE schema validation. Without this, a config.json persisted while "minimal"
 *  was still valid (thinkingLevel, any subagents.*.thinking, any routing.tiers.*.thinking)
 *  would fail the tightened enum and readGlobalConfig's schema-invalid path resets the
 *  ENTIRE config to defaults (modelAliases/subagents/routing/retry/hooks/notifications
 *  all silently lost, not just the one bad field) — see state.ts's salvageCredentials doc
 *  comment for why only oauth/providers survive that path. Mutates a shallow-cloned
 *  object only where needed; non-object/malformed input passes through untouched so the
 *  schema's own validation still reports the real error. */
function migrateMinimalThinking(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const cfg = raw as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = { ...cfg };
  if (out.thinkingLevel === "minimal") { out.thinkingLevel = "low"; changed = true; }
  if (out.subagents && typeof out.subagents === "object") {
    const subs = out.subagents as Record<string, unknown>;
    const nextSubs: Record<string, unknown> = { ...subs };
    for (const [roleId, role] of Object.entries(subs)) {
      if (role && typeof role === "object" && (role as Record<string, unknown>).thinking === "minimal") {
        nextSubs[roleId] = { ...(role as Record<string, unknown>), thinking: "low" };
        changed = true;
      }
    }
    if (changed) out.subagents = nextSubs;
  }
  if (out.routing && typeof out.routing === "object") {
    const routing = out.routing as Record<string, unknown>;
    if (routing.tiers && typeof routing.tiers === "object") {
      const tiers = routing.tiers as Record<string, unknown>;
      const nextTiers: Record<string, unknown> = { ...tiers };
      let tiersChanged = false;
      for (const [tierId, tier] of Object.entries(tiers)) {
        if (tier && typeof tier === "object" && (tier as Record<string, unknown>).thinking === "minimal") {
          nextTiers[tierId] = { ...(tier as Record<string, unknown>), thinking: "low" };
          tiersChanged = true;
        }
      }
      if (tiersChanged) { out.routing = { ...routing, tiers: nextTiers }; changed = true; }
    }
  }
  return changed ? out : raw;
}

export function parseConfig(raw: unknown): { ok: true; config: ValidatedConfig } | { ok: false; message: string } {
  const result = ConfigSchema.safeParse(migrateMinimalThinking(raw));
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
      if (config.roles.medium) {
        config.roles.medium = normalizeModelId(config.roles.medium, aliases);
      }
      if (config.roles.high) {
        config.roles.high = normalizeModelId(config.roles.high, aliases);
      }
      if (config.roles.xhigh) {
        config.roles.xhigh = normalizeModelId(config.roles.xhigh, aliases);
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
