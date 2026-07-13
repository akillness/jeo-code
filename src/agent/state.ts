import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { parseConfig } from "./config-schema";
import type { AuthProvider } from "../auth/storage";
import { OPENAI_COMPAT_PROVIDERS } from "../ai/providers/openai-compatible-catalog";
import { jeoEnv } from "../util/env";

/** Persisted OAuth credential set (access + refresh + expiry) for a provider. */
export interface StoredOAuth {
  access: string;
  refresh?: string;
  /** Epoch ms after which the access token is considered expired (skew-adjusted at mint time). */
  expires?: number;
  accountId?: string;
  email?: string;
  projectId?: string;
}

export interface HookConfig {
  enabled?: boolean;
  hooks?: Array<{
    event: "pre-tool" | "post-turn" | "post-implementation";
    match?: { tool?: string };
    run: string;
    timeoutMs?: number;
  }>;
}

export interface Config {
  /** Per-provider API keys, keyed by AuthProvider (cloud keys + catalog OpenAI-compatible). */
  providers: Partial<Record<AuthProvider, string>>;
  /**
   * OAuth credentials. `resolveCredential()` returns these before API keys so refresh
   * metadata is not lost, but provider execution/status applies the GJC parity rule:
   * an API key is broader and wins whenever both key + OAuth exist. API-key-only
   * providers never populate OAuth; the key exists for index-compatibility.
   */
  oauth?: Partial<Record<AuthProvider, string | StoredOAuth>>;
  /** Base URL for the local Ollama server (keyless). */
  ollamaBaseUrl?: string;
  /** Ollama context window (`num_ctx`); overrides the server's small default. Env: OLLAMA_NUM_CTX. */
  ollamaNumCtx?: number;
  /** Base URL override for OpenAI-compatible providers (vLLM, llama-cpp-server, ...). */
  openaiBaseUrl?: string;
  /** Base URL for the local LM Studio server (keyless, OpenAI-compatible). */
  lmstudioBaseUrl?: string;
  defaultModel: string;
  /** Root path of the global llm-wiki vault, shared across every session regardless
   *  of project/cwd. A leading `~` is expanded at resolve time; env `JEO_WIKI_ROOT`
   *  overrides. Resolve with `resolveWikiRoot()`. */
  wikiRoot?: string;
  theme?: string;
  /** Terminal-bell notifications (gajae-code 0.7.8 parity). `bell` is the master
   *  toggle; per-event flags refine it. Env `JEO_NOTIFY_BELL=1/0` force-overrides. */
  notify?: {
    bell?: boolean;
    onComplete?: boolean;
    onAsk?: boolean;
  };
  /** Remote subagent visibility/control over Telegram (see `src/agent/notify/`). */
  notifications?: {
    enabled?: boolean;
    /** Session-local default; see `config-schema.ts` for the mutability contract. */
    verbosity?: "lean" | "verbose";
    /** Session-local default; see `config-schema.ts` for the mutability contract. */
    redact?: boolean;
    telegram?: {
      botToken?: string;
      chatId?: string;
      /** Forum-topic thread id (message_thread_id) for daemon pushes. */
      topicId?: number;
      /** Auto-create/manage one forum topic per interactive session instead of
       *  the flat/global `topicId` above. See `TopicRegistry`. */
      perSessionTopics?: boolean;
    };
  };

  thinkingLevel?: "low" | "medium" | "high" | "xhigh";
  /** Friendly model aliases, e.g. { fast: "ollama/qwen2.5:0.5b" }. Override built-ins. */
  modelAliases?: { [alias: string]: string };
  /** Most-recently-selected models, newest first (MRU; head == defaultModel). */
  recentModels?: string[];
  /**
   * Provider retry budgets (gjc parity). `requestMaxRetries` is the number of
   * retries (excluding the initial request) for a provider request; `maxDelayMs`
   * caps exponential backoff. `maxRetries`/`streamMaxRetries` are accepted for
   * gjc-config compatibility.
   */
  retry?: {
    requestMaxRetries?: number;
    streamMaxRetries?: number;
    maxRetries?: number;
    maxDelayMs?: number;
    /** Retries (excluding the initial request) specifically for 429 rate limits. */
    rateLimitRetries?: number;
    /** Minimum backoff (ms) for a 429 when the server sends no Retry-After. */
    rateLimitMinDelayMs?: number;
    /** Opt-in ceiling (ms) on a 429's server-directed Retry-After: a delay beyond it fails
     *  fast instead of sleeping. Unset (the default) honors any server-directed delay in
     *  full, however long — a generic rate limit is retried forever, not treated as fatal
     *  past some budget. Set this only if unbounded rate-limit waits are undesirable. */
    rateLimitMaxServerDelayMs?: number;
    /** HTTP statuses to treat as NON-retryable even when defaultRetryable would
     *  retry them (e.g. pin 503 to fail fast instead of riding the backoff ladder). */
    failFastStatuses?: number[];
    /** Case-insensitive substrings; an error whose message matches any of these
     *  fails fast (non-retryable) even when the chosen predicate would retry it. */
    failFastPatterns?: string[];
  };
  /**
   * Per-subagent-role overrides (gjc role-agent parity), keyed by role id.
   * Bundled ids (executor / planner / architect / critic) take model / maxSteps /
   * thinking pins. A NON-bundled id that declares `title`, `description`, or
   * `prompt` becomes a config-defined CUSTOM ROLE (system-driven registry —
   * see rolesFromConfig). Custom roles are read-only unless `readOnly: false`.
   */
  subagents?: {
    [roleId: string]: {
      model?: string;
      maxSteps?: number;
      thinking?: "low" | "medium" | "high" | "xhigh";
      title?: string;
      description?: string;
      prompt?: string;
      readOnly?: boolean;
    };
  };
  /**
   * Model role tiers (gjc `--smol`/`--slow`/`--plan` parity). Each falls back to
   * `defaultModel`. Env `JEO_SMOL_MODEL`/`JEO_SLOW_MODEL`/`JEO_PLAN_MODEL` fill gaps.
   */
  roles?: {
    smol?: string;
    medium?: string;
    high?: string;
    xhigh?: string;
    slow?: string;
    plan?: string;
  };
  /** Prompt-content-based per-turn model routing (PromptRouter) — see prompt-router.ts.
   *  Opt-in (undefined/false = off). Never affects subagent/role-tier model resolution. */
  routing?: {
    enabled?: boolean;
    confidenceThreshold?: number;
    tiers?: {
      trivial?: { model?: string; thinking?: "low" | "medium" | "high" | "xhigh" };
      standard?: { model?: string; thinking?: "low" | "medium" | "high" | "xhigh" };
      /** A single borderline-complex signal (see prompt-router.ts's `classifyPromptHeuristically`)
       *  — routes to `roles.high` by default instead of jumping straight to `complex`/xhigh. */
      high?: { model?: string; thinking?: "low" | "medium" | "high" | "xhigh" };
      complex?: { model?: string; thinking?: "low" | "medium" | "high" | "xhigh" };
    };
    /** Opt-in (default off): for `standard`/`high` tiers left unconfigured (no
     *  `routing.tiers.*.model`, no `roles.medium`/`roles.high`), pick a SESSION-STABLE
     *  model from the cross-provider equivalence pool (`tierModelPool`/`selectFromPool`)
     *  instead of falling straight to `defaultModel` — spreads different sessions across
     *  every credentialed provider's comparable-tier model so jeo actually captures each
     *  provider's respective strengths on comparably-priced work, rather than every
     *  session converging on one provider. */
    crossProviderPool?: boolean;
  };
  gitAutoCommit?: boolean;
  hooks?: HookConfig;
  computer?: {
    enabled?: boolean;
  };
}

export interface WorkflowTopologyComponent {
  id: string;
  name: string;
  description: string;
  status: "active" | "deferred";
  evidence?: string[];
}

export interface WorkflowTopologyState {
  status: "pending" | "confirmed" | "legacy_missing";
  confirmed_at?: string | null;
  components: WorkflowTopologyComponent[];
  deferrals?: Array<{ component_id: string; reason: string; confirmed_at: string }>;
  last_targeted_component_id?: string | null;
}

export interface WorkflowState {
  active: boolean;
  current_phase: string;
  skill: "deep-interview" | "ralplan" | "team" | "ultragoal";
  interview_id?: string;
  slug?: string;
  initial_idea?: string;
  current_ambiguity?: number;
  threshold?: number;
  threshold_source?: string;
  type?: "greenfield" | "brownfield";
  seed_path?: string;
  topology?: WorkflowTopologyState;
  codebase_context?: string;
  language?: string;
  plan_path?: string;
  completed_tasks?: string[];
  pending_tasks?: string[];
  /** team: the task the previous run failed on — surfaces a partial-edits
   *  warning on resume (round-8). Cleared when the run resumes past it. */
  failed_task?: string;
  /** ralplan: persisted consensus-critic verdict ("okay" | "iterate" | "reject" |
   *  "unverified") — `jeo approve` requires "okay" (round-11 real consensus). */
  consensus?: string;
  /** ralplan: the critic's justification (bounded excerpt) for auditability. */
  consensus_detail?: string;
  /** ralplan: hash of the exact plan content the consensus critic gated (round-13).
   *  `jeo approve` recomputes the on-disk plan's hash and refuses if it differs, so a
   *  schema-valid edit made AFTER the [OKAY] verdict cannot be silently approved. */
  consensus_hash?: string;
  approved?: boolean;
  /** ultragoal terminal outcome. */
  status?: string;
  passed?: number;
  total?: number;
  /** ultragoal: whether the global verification suite was green (round-7 honest
   *  contract — criteria are recorded, not individually claimed as passed). */
  suite_green?: boolean;
}

/** The built-in default model when neither disk config nor JEO_DEFAULT_MODEL provides one.
 *  Shared by envDefaultConfig (runtime) and readRawGlobalConfig (persistence base) so a
 *  fresh-install saveConfigPatch never bakes a DIFFERENT default than the runtime resolves. */
const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * Resolve the global config directory at call time (not import time) so that a
 * `JEO_CONFIG_DIR` override or a runtime `HOME` change is always honored.
 * `JEO_CONFIG_DIR` takes precedence; otherwise `~/.jeo`.
 */
function globalConfigDir(): string {
  return jeoEnv("CONFIG_DIR") || path.join(os.homedir(), ".jeo");
}
function globalConfigPath(): string {
  return path.join(globalConfigDir(), "config.json");
}

/**
 * Expand and absolutize a wiki-root path: a leading `~` becomes the home directory
 * and the result is `path.resolve`d so tools/hooks never see an un-expanded `~` or a
 * relative path. Returns undefined for blank input.
 */
export function normalizeWikiRoot(raw: string | undefined): string | undefined {
  const v = (raw || "").trim();
  if (!v) return undefined;
  const expanded = v === "~" || v.startsWith("~/") ? path.join(os.homedir(), v.slice(1)) : v;
  return path.resolve(expanded);
}

/**
 * Resolve the global llm-wiki vault root. Precedence: explicit `JEO_WIKI_ROOT` env
 * override → `config.wikiRoot` → undefined (no global wiki configured). The result is
 * `~`-expanded and absolutized via `normalizeWikiRoot`.
 */
export function resolveWikiRoot(cfg: Pick<Config, "wikiRoot">): string | undefined {
  // A blank/whitespace env var must not mask a configured root, so trim before the OR.
  const envRoot = (jeoEnv("WIKI_ROOT") || "").trim();
  return normalizeWikiRoot(envRoot || cfg.wikiRoot);
}

function envOAuth(): NonNullable<Config["oauth"]> {
  return {
    anthropic: process.env.ANTHROPIC_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN,
    openai: process.env.OPENAI_OAUTH_TOKEN,
    gemini: process.env.GEMINI_OAUTH_TOKEN,
  };
}

/** Merge env-provided credentials / base URLs over a config (env fills gaps only;
 *  on-disk values always win). Previously the providers API-key map was NOT overlaid
 *  when a config file existed, so a provider whose key lived only in the environment
 *  (e.g. GEMINI_API_KEY) resolved to "no credential" — breaking provider/model
 *  selection (including per-role subagent overrides) despite the key being present. */
function withEnvOverlay(cfg: Config): Config {
  const envTok = envOAuth();
  const oauth = { ...envTok, ...(cfg.oauth ?? {}) };
  // Disk wins when it is a real key; env fills missing/blank gaps. A hand-edited
  // empty string should not mask a valid environment credential.
  const providers: Config["providers"] = { ...(cfg.providers ?? {}) };
  if (!providers.anthropic && process.env.ANTHROPIC_API_KEY) providers.anthropic = process.env.ANTHROPIC_API_KEY;
  if (!providers.openai && process.env.OPENAI_API_KEY) providers.openai = process.env.OPENAI_API_KEY;
  if (!providers.gemini && process.env.GEMINI_API_KEY) providers.gemini = process.env.GEMINI_API_KEY;
  if (!providers.xai && process.env.XAI_API_KEY) providers.xai = process.env.XAI_API_KEY;
  // Catalog-driven OpenAI-compatible providers: each provider's own `apiKeyEnv`
  // (e.g. GROQ_API_KEY, HF_TOKEN, NANO_GPT_API_KEY) fills config.providers[name].
  for (const def of OPENAI_COMPAT_PROVIDERS) {
    const key = def.name as AuthProvider; // every catalog name is an AuthProvider
    if (!providers[key] && process.env[def.apiKeyEnv]) providers[key] = process.env[def.apiKeyEnv];
  }
  return {
    ...cfg,
    providers,
    oauth,
    defaultModel: jeoEnv("DEFAULT_MODEL") || cfg.defaultModel,
    ollamaBaseUrl: cfg.ollamaBaseUrl || process.env.OLLAMA_HOST || "http://localhost:11434",
    openaiBaseUrl: cfg.openaiBaseUrl || process.env.OPENAI_BASE_URL,
    lmstudioBaseUrl: cfg.lmstudioBaseUrl || process.env.LMSTUDIO_BASE_URL || "http://localhost:1234/v1",
    roles: {
      smol: cfg.roles?.smol || jeoEnv("SMOL_MODEL"),
      medium: cfg.roles?.medium || jeoEnv("MEDIUM_MODEL"),
      high: cfg.roles?.high || jeoEnv("HIGH_MODEL"),
      xhigh: cfg.roles?.xhigh || jeoEnv("XHIGH_MODEL"),
      slow: cfg.roles?.slow || jeoEnv("SLOW_MODEL"),
      plan: cfg.roles?.plan || jeoEnv("PLAN_MODEL"),
    },
  };
}

function envDefaultConfig(): Config {
  return {
    providers: {
      anthropic: process.env.ANTHROPIC_API_KEY,
      openai: process.env.OPENAI_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
      xai: process.env.XAI_API_KEY,
    },
    defaultModel: jeoEnv("DEFAULT_MODEL") || DEFAULT_MODEL,
    thinkingLevel: "medium",
  };
}

/**
 * Parsed-config read cache keyed by path and validated by stat (mtimeMs + size).
 * `readGlobalConfig`/`readRawGlobalConfig` run on EVERY model call (resolveCall,
 * credential resolution, per-turn config reads), so an uncached read paid a disk
 * read + JSON.parse + zod validation per agent-loop step. The cache is bounded
 * (≤8 paths — one per JEO_CONFIG_DIR seen) and invalidated by `saveGlobalConfig`;
 * any external write changes mtime/size, so a stale entry is never served. Reads
 * return a structuredClone so callers can never poison the cached object.
 */
type ParsedFile =
  | { kind: "ok"; config: Config }
  | { kind: "missing" }
  | { kind: "bad-json"; warned: boolean }
  | { kind: "invalid"; message: string; warned: boolean; rawObject?: unknown };
const configReadCache = new Map<string, { mtimeMs: number; size: number; parsed: ParsedFile }>();
const CONFIG_CACHE_CAP = 8;

/** Drop all cached config reads (tests / explicit invalidation). */
export function clearConfigReadCache(): void {
  configReadCache.clear();
}

async function readParsedConfigFile(): Promise<ParsedFile> {
  const p = globalConfigPath();
  let st: { mtimeMs: number; size: number };
  try {
    st = await fs.stat(p);
  } catch {
    configReadCache.delete(p);
    return { kind: "missing" };
  }
  const hit = configReadCache.get(p);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.parsed;
  let parsed: ParsedFile;
  try {
    const raw = JSON.parse(await fs.readFile(p, "utf-8"));
    const result = parseConfig(raw);
    parsed = result.ok
      ? { kind: "ok", config: result.config as Config }
      // Keep the raw JSON object on a schema-invalid (but JSON-valid) config so
      // readRawGlobalConfig can salvage the credential blocks instead of dropping them.
      : { kind: "invalid", message: result.message, warned: false, rawObject: raw };
  } catch {
    parsed = { kind: "bad-json", warned: false };
  }
  if (configReadCache.size >= CONFIG_CACHE_CAP && !configReadCache.has(p)) {
    const oldest = configReadCache.keys().next().value;
    if (oldest !== undefined) configReadCache.delete(oldest);
  }
  configReadCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, parsed });
  return parsed;
}

/** Overlay the `oauth` + `providers` credential blocks from a schema-invalid (but
 *  JSON-valid) config's raw object onto `base`. A single bad scalar field (e.g. a
 *  non-string defaultModel) must never cost the user their stored credentials — neither
 *  when resolving them at runtime (readGlobalConfig) nor when persisting (readRawGlobalConfig). */
function salvageCredentials(base: Config, parsed: ParsedFile): Config {
  if (parsed.kind !== "invalid" || !parsed.rawObject || typeof parsed.rawObject !== "object") return base;
  const ro = parsed.rawObject as Record<string, unknown>;
  if (ro.oauth && typeof ro.oauth === "object") base.oauth = structuredClone(ro.oauth) as Config["oauth"];
  if (ro.providers && typeof ro.providers === "object") {
    base.providers = { ...base.providers, ...(structuredClone(ro.providers) as Config["providers"]) };
  }
  return base;
}

export async function readGlobalConfig(): Promise<Config> {
  const parsed = await readParsedConfigFile();
  if (parsed.kind === "bad-json" || parsed.kind === "invalid") {
    // Warn once per file VERSION (mtime/size change resets the entry), not per read.
    if (!parsed.warned) {
      parsed.warned = true;
      const detail = parsed.kind === "invalid" ? ` is invalid (${parsed.message})` : " is not valid JSON";
      process.stderr.write(`[jeo] ${globalConfigPath()}${detail}; using environment defaults.\n`);
    }
    // Credential salvage: keep oauth/providers from a JSON-valid-but-schema-invalid
    // config so the runtime stays authenticated (and a later write repairs the file).
    return withEnvOverlay(salvageCredentials(envDefaultConfig(), parsed));
  }
  if (parsed.kind === "missing") return withEnvOverlay(envDefaultConfig());
  return withEnvOverlay(structuredClone(parsed.config));
}

export async function saveGlobalConfig(config: Config): Promise<void> {
  const dir = globalConfigDir();
  // Hermeticity guard: under `bun test` (Bun sets NODE_ENV=test, inherited by
  // spawned CLI subprocesses via env spreads) a config WRITE may only target an
  // explicitly sandboxed JEO_CONFIG_DIR — never the real ~/.jeo. A leaky test
  // once overwrote the user's real providers.anthropic with the routing suite's
  // "test-anthropic-key" fixture (~/.jeo/config.json.bak.test-clobber-20260702),
  // silently killing every real Anthropic call afterwards. Reads stay unguarded
  // (harmless); only the destructive path hard-fails, so a leak is caught in CI
  // as a loud test error instead of corrupting the developer's machine.
  if (process.env.NODE_ENV === "test" && !jeoEnv("CONFIG_DIR")) {
    throw new Error(
      "saveGlobalConfig: refusing to write the real ~/.jeo config under bun test — set JEO_CONFIG_DIR to a temp dir in the test (see test/config-save.test.ts's pattern).",
    );
  }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const target = globalConfigPath();
  const tmpPath = `${target}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
    await fs.chmod(tmpPath, 0o600).catch(() => {});
    await fs.rename(tmpPath, target);
    configReadCache.delete(target); // the next read re-parses the fresh file
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/** Read the on-disk config WITHOUT the env overlay. Used as the base for
 *  persistence so env-only values (OAuth bearer tokens, JEO_DEFAULT_MODEL,
 *  JEO_*_MODEL role tiers, OLLAMA_HOST/OPENAI_BASE_URL) are never baked into
 *  ~/.jeo/config.json by an unrelated `/agents`/`/roles`/`/model save`. */
export async function readRawGlobalConfig(): Promise<Config> {
  const parsed = await readParsedConfigFile();
  if (parsed.kind === "ok") return structuredClone(parsed.config);
  // CREDENTIAL SAFETY: when the on-disk config is JSON-valid but fails schema validation
  // on some unrelated field, salvage the `oauth` + `providers` blocks. Without this, the
  // next saveConfigPatch (e.g. an auto token refresh that patches ONE provider) bases on
  // a clean config and silently wipes every OTHER stored credential — the "OAuth de-authed
  // after a session" bug. The invalid scalar field is dropped (reset to default).
  const clean: Config = { providers: {}, defaultModel: DEFAULT_MODEL, thinkingLevel: "medium" };
  return salvageCredentials(clean, parsed);
}

/**
 * Global config write lock — HIGH-1 lost-update fix (gjc parity: auth-storage.ts
 * SqliteAuthCredentialStore serializes credential writes inside SQLite). jeo keeps
 * everything in one config.json, so EVERY read-modify-write must serialize through one
 * lock file; otherwise two concurrent per-provider OAuth refreshes (e.g. doctor.ts
 * Promise.all) read the same base config and the later write clobbers the earlier one's
 * just-rotated refresh token → silent logout.
 *
 * Semantics mirror src/auth/storage.ts acquireLock (stale-lock detection + bounded wait
 * + single steal at the deadline) but are implemented locally: storage.ts imports
 * state.ts, so importing it back would create a cycle.
 * // ponytail: extract a shared lockfile helper module if a third lockfile user appears.
 */
const CONFIG_LOCK_STALE_MS = 5_000;

function configLockPath(): string {
  return `${globalConfigPath()}.lock`;
}

async function acquireConfigLock(timeoutMs = CONFIG_LOCK_STALE_MS): Promise<void> {
  const lockPath = configLockPath();
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  // `timeoutMs` is the STALENESS threshold for a dead holder's lock file; the
  // acquisition wait itself is bounded at 2× that (same policy as storage.ts).
  const deadline = Date.now() + Math.max(timeoutMs * 2, 1_000);
  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf-8");
      await handle.close();
      return;
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
      try {
        const info = JSON.parse(await fs.readFile(lockPath, "utf-8"));
        if (typeof info.createdAt === "number" && info.createdAt + timeoutMs < Date.now()) {
          await fs.unlink(lockPath).catch(() => {});
        }
      } catch {
        try {
          const stat = await fs.stat(lockPath);
          if (stat.mtimeMs + timeoutMs < Date.now()) {
            await fs.unlink(lockPath).catch(() => {});
          }
        } catch {}
      }
    }
    if (Date.now() >= deadline) {
      // Deadline reached: the holder is dead or wedged. Steal once — the lock guards
      // a short config read-modify-write, so waiting longer only hangs the caller.
      await fs.unlink(lockPath).catch(() => {});
      const handle = await fs.open(lockPath, "wx").catch(() => null);
      if (handle) {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now(), stolen: true }), "utf-8");
        await handle.close();
        return;
      }
      throw new Error(`config lock could not be acquired within ${Math.max(timeoutMs * 2, 1_000)}ms (${lockPath})`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function releaseConfigLock(): Promise<void> {
  await fs.unlink(configLockPath()).catch(() => {});
}

/** Merge a patch onto the RAW on-disk config and persist. The `build` callback
 *  receives the raw config so partial updates (subagents/roles maps) are derived
 *  from on-disk state, never from the env-overlaid runtime config. The whole
 *  read→merge→write cycle holds the global config lock so concurrent patches
 *  (per-provider OAuth refreshes, /model save, doctor sweeps) never lose updates. */
export async function saveConfigPatch(build: (raw: Config) => Partial<Config>): Promise<Config> {
  await acquireConfigLock();
  try {
    const raw = await readRawGlobalConfig();
    const next = { ...raw, ...build(raw) };
    await saveGlobalConfig(next);
    return next;
  } finally {
    await releaseConfigLock();
  }
}

export function getLocalJeoDir(cwd: string = process.cwd()): string {
  return path.join(cwd, ".jeo");
}

/** Ensure `.jeo/` self-ignores in git — memory/skill-lesson writes under `.jeo/`
 *  are agent-local working state, not source; without this a CI routine (`jeo
 *  routine init`, running `jeo -p` then committing via create-pull-request)
 *  ships `.jeo/memory/*`/`.jeo/skills/*` churn into every generated PR. Writes
 *  a bare `*` pattern ONCE on first `.jeo/` creation — idempotent (checked via
 *  a stat, never overwrites a file that already exists, so a user's own
 *  customized `.jeo/.gitignore` is never clobbered). Best-effort: any I/O
 *  failure is swallowed, never thrown (this is a hygiene nicety, not a
 *  correctness requirement — a missing .gitignore degrades gracefully to "no
 *  ignore", not a broken feature). */
export async function ensureJeoGitignore(cwd: string = process.cwd()): Promise<void> {
  const gitignorePath = path.join(getLocalJeoDir(cwd), ".gitignore");
  try {
    await fs.access(gitignorePath);
    return; // already exists — never overwrite (user customization respected)
  } catch {
    // does not exist — fall through to create
  }
  try {
    await fs.mkdir(getLocalJeoDir(cwd), { recursive: true });
    await fs.writeFile(gitignorePath, "*\n", "utf-8");
  } catch {
    // best-effort — a failed write here must never break the caller's real work
  }
}

// mtime+size-validated cache for the small per-skill workflow-state JSON. readWorkflowState
// runs repeatedly (the mutation guard reads before every mutating tool), so re-reading +
// re-parsing each call is wasteful. CROSS-PROCESS-SAFE: a write by another process bumps
// mtime/size → forces a fresh read, so the security-sensitive guard never serves a stale
// lock. Same-process write/clear update or drop the entry directly. LRU-capped.
const workflowStateCache = new Map<string, { mtimeMs: number; size: number; value: WorkflowState | null }>();
const WORKFLOW_STATE_CACHE_CAP = 16;

function cacheWorkflowState(statePath: string, mtimeMs: number, size: number, value: WorkflowState | null): void {
  workflowStateCache.delete(statePath);
  if (workflowStateCache.size >= WORKFLOW_STATE_CACHE_CAP) {
    const oldest = workflowStateCache.keys().next().value;
    if (oldest !== undefined) workflowStateCache.delete(oldest);
  }
  workflowStateCache.set(statePath, { mtimeMs, size, value });
}

async function loadWorkflowStateFile(statePath: string, strict: boolean): Promise<WorkflowState | null> {
  let st: { mtimeMs: number; size: number };
  try {
    st = await fs.stat(statePath);
  } catch (err) {
    workflowStateCache.delete(statePath);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (strict) throw err;
    return null;
  }
  const hit = workflowStateCache.get(statePath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    workflowStateCache.delete(statePath); // LRU refresh
    workflowStateCache.set(statePath, hit);
    return hit.value;
  }
  let data: string;
  try {
    data = await fs.readFile(statePath, "utf-8");
  } catch (err) {
    workflowStateCache.delete(statePath);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (strict) throw err;
    return null;
  }
  try {
    const parsed = JSON.parse(data) as WorkflowState;
    cacheWorkflowState(statePath, st.mtimeMs, st.size, parsed);
    return parsed;
  } catch {
    workflowStateCache.delete(statePath);
    if (strict) throw new Error(`workflow state ${statePath} is corrupt (invalid JSON)`);
    return null;
  }
}

export async function readWorkflowState(
  skill: "deep-interview" | "ralplan" | "team" | "ultragoal",
  cwd: string = process.cwd()
): Promise<WorkflowState | null> {
  const statePath = path.join(getLocalJeoDir(cwd), "state", `${skill}-state.json`);
  return loadWorkflowStateFile(statePath, false);
}

/**
 * Like {@link readWorkflowState} but distinguishes a missing file (→ null) from a
 * corrupt/invalid one (→ throws). Security-sensitive callers (the MutationGuard)
 * use this to fail CLOSED: a corrupt lock state must not be treated as "no lock".
 */
export async function readWorkflowStateStrict(
  skill: "deep-interview" | "ralplan" | "team" | "ultragoal",
  cwd: string = process.cwd()
): Promise<WorkflowState | null> {
  const statePath = path.join(getLocalJeoDir(cwd), "state", `${skill}-state.json`);
  return loadWorkflowStateFile(statePath, true);
}

export async function writeWorkflowState(
  skill: "deep-interview" | "ralplan" | "team" | "ultragoal",
  state: WorkflowState,
  cwd: string = process.cwd()
): Promise<string> {
  const stateDir = path.join(getLocalJeoDir(cwd), "state");
  await fs.mkdir(stateDir, { recursive: true });
  const statePath = path.join(stateDir, `${skill}-state.json`);
  // Atomic temp+rename (zeroclaw crash-durability): workflow state is rewritten
  // repeatedly mid-workflow, and the mutation guard fails CLOSED on corrupt JSON —
  // a torn write would otherwise wedge the agent into a permanent mutation block.
  const tmpPath = `${statePath}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
    await fs.rename(tmpPath, statePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
  // Cache the just-written state keyed on the new file fingerprint so the next read
  // (often the mutation guard milliseconds later) is served from memory.
  try {
    const st = await fs.stat(statePath);
    cacheWorkflowState(statePath, st.mtimeMs, st.size, state);
  } catch {
    workflowStateCache.delete(statePath);
  }
  return statePath;
}

export async function clearWorkflowState(
  skill: "deep-interview" | "ralplan" | "team" | "ultragoal",
  cwd: string = process.cwd()
): Promise<void> {
  const statePath = path.join(getLocalJeoDir(cwd), "state", `${skill}-state.json`);
  try {
    await fs.unlink(statePath);
  } catch {}
  workflowStateCache.delete(statePath);
}

/**
 * Cross-process run lock for a workflow engine (round-8, architect ref
 * 7-Round7Workflow): two concurrent `jeo team` processes would read-modify-write
 * team-state.json last-writer-wins — tasks executed twice, completions lost.
 * O_EXCL lockfile carrying the holder's pid; a DEAD holder's stale lock is taken
 * over once, a LIVE holder refuses with an actionable error. Returns a release fn.
 *
 * Round-13 hardening: `process.kill(pid, 0)` alone cannot detect PID REUSE — a
 * dead `jeo` pid recycled by an unrelated live process would look "alive" forever
 * and starve the lock. The holder now HEARTBEATS the lock's `at` timestamp on an
 * unref'd interval; a contender treats a lock as stale when the pid is dead OR the
 * timestamp is older than the TTL (a live `jeo` run keeps it fresh, a dead/hung one
 * or a reused pid lets it expire). Override the TTL with JEO_RUN_LOCK_TTL_MS.
 */
const RUN_LOCK_TTL_MS = (() => {
  const raw = Number(jeoEnv("RUN_LOCK_TTL_MS"));
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
})();
const RUN_LOCK_HEARTBEAT_MS = Math.max(1_000, Math.floor(RUN_LOCK_TTL_MS / 3));

export async function acquireWorkflowRunLock(
  skill: "team" | "ultragoal",
  cwd: string = process.cwd(),
): Promise<() => Promise<void>> {
  const stateDir = path.join(getLocalJeoDir(cwd), "state");
  await fs.mkdir(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, `${skill}.lock`);
  // Single source of the lock payload: exclusive-create on acquire, plain rewrite on heartbeat.
  const stamp = (flag?: "wx") =>
    fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), flag ? { flag } : {});
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await stamp("wx");
      // Heartbeat: refresh `at` so a live run never looks stale; unref'd so it
      // never keeps the process alive on its own.
      const hb = setInterval(() => { stamp().catch(() => {}); }, RUN_LOCK_HEARTBEAT_MS);
      hb.unref?.();
      return async () => {
        clearInterval(hb);
        await fs.unlink(lockPath).catch(() => {});
      };

    } catch {
      let holder: { pid?: number; at?: number } = {};
      try {
        holder = JSON.parse(await fs.readFile(lockPath, "utf-8")) as { pid?: number; at?: number };
      } catch { /* unreadable/torn lock → treat as stale */ }
      const pidAlive = typeof holder.pid === "number" && holder.pid > 0 && (() => {
        try {
          process.kill(holder.pid!, 0);
          return true;
        } catch {
          return false;
        }
      })();
      const fresh = typeof holder.at === "number" && (Date.now() - holder.at) < RUN_LOCK_TTL_MS;
      if (pidAlive && fresh) {
        throw new Error(
          `another 'jeo ${skill}' run (pid ${holder.pid}) holds ${lockPath} — wait for it to finish, or delete the lock file if that process is gone.`,
        );
      }
      // stale: dead pid, unreadable lock, or a stalled/reused-pid holder whose
      // heartbeat lapsed past the TTL → take over once.
      await fs.unlink(lockPath).catch(() => {});
    }
  }
  throw new Error(`could not acquire ${lockPath} even after stale-lock takeover.`);
}

/** Returns true if the agent is running in development mode (enables self-improvement). */
export function isDevMode(): boolean {
  return jeoEnv("DEV_MODE") === "1" || process.env.NODE_ENV === "development";
}
