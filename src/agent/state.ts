import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { parseConfig } from "./config-schema";
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
  providers: {
    anthropic?: string;
    openai?: string;
    gemini?: string;
    antigravity?: string;
  };
  /**
   * OAuth credentials. `resolveCredential()` returns these before API keys so refresh
   * metadata is not lost, but provider execution/status applies the GJC parity rule:
   * an API key is broader and wins whenever both key + OAuth exist.
   */
  oauth?: {
    anthropic?: string | StoredOAuth;
    openai?: string | StoredOAuth;
    gemini?: string | StoredOAuth;
    antigravity?: string | StoredOAuth;
  };
  /** Base URL for the local Ollama server (keyless). */
  ollamaBaseUrl?: string;
  /** Base URL override for OpenAI-compatible providers (LM Studio, vLLM, llama-cpp-server, ...). */
  openaiBaseUrl?: string;
  defaultModel: string;
  theme?: string;
  thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh";
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
      thinking?: "minimal" | "low" | "medium" | "high" | "xhigh";
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
  roles?: { smol?: string; slow?: string; plan?: string };
  hooks?: HookConfig;
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
const DEFAULT_MODEL = "claude-sonnet-4-5";

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
  return {
    ...cfg,
    providers,
    oauth,
    defaultModel: jeoEnv("DEFAULT_MODEL") || cfg.defaultModel,
    ollamaBaseUrl: cfg.ollamaBaseUrl || process.env.OLLAMA_HOST || "http://localhost:11434",
    openaiBaseUrl: cfg.openaiBaseUrl || process.env.OPENAI_BASE_URL,
    roles: {
      smol: cfg.roles?.smol || jeoEnv("SMOL_MODEL"),
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

/** Merge a patch onto the RAW on-disk config and persist. The `build` callback
 *  receives the raw config so partial updates (subagents/roles maps) are derived
 *  from on-disk state, never from the env-overlaid runtime config. */
export async function saveConfigPatch(build: (raw: Config) => Partial<Config>): Promise<Config> {
  const raw = await readRawGlobalConfig();
  const next = { ...raw, ...build(raw) };
  await saveGlobalConfig(next);
  return next;
}

export function getLocalJeoDir(cwd: string = process.cwd()): string {
  return path.join(cwd, ".jeo");
}

export async function readWorkflowState(
  skill: "deep-interview" | "ralplan" | "team" | "ultragoal",
  cwd: string = process.cwd()
): Promise<WorkflowState | null> {
  const statePath = path.join(getLocalJeoDir(cwd), "state", `${skill}-state.json`);
  try {
    const data = await fs.readFile(statePath, "utf-8");
    return JSON.parse(data) as WorkflowState;
  } catch {
    return null;
  }
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
  let data: string;
  try {
    data = await fs.readFile(statePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(data) as WorkflowState;
  } catch {
    throw new Error(`workflow state ${statePath} is corrupt (invalid JSON)`);
  }
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
}

/**
 * Cross-process run lock for a workflow engine (round-8, architect ref
 * 7-Round7Workflow): two concurrent `jeo team` processes would read-modify-write
 * team-state.json last-writer-wins — tasks executed twice, completions lost.
 * O_EXCL lockfile carrying the holder's pid; a DEAD holder's stale lock is taken
 * over once, a LIVE holder refuses with an actionable error. Returns a release fn.
 */
export async function acquireWorkflowRunLock(
  skill: "team" | "ultragoal",
  cwd: string = process.cwd(),
): Promise<() => Promise<void>> {
  const stateDir = path.join(getLocalJeoDir(cwd), "state");
  await fs.mkdir(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, `${skill}.lock`);
  const payload = JSON.stringify({ pid: process.pid, at: Date.now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(lockPath, payload, { flag: "wx" });
      return async () => {
        await fs.unlink(lockPath).catch(() => {});
      };
    } catch {
      let holder: { pid?: number } = {};
      try {
        holder = JSON.parse(await fs.readFile(lockPath, "utf-8")) as { pid?: number };
      } catch { /* unreadable/torn lock → treat as stale */ }
      const alive = typeof holder.pid === "number" && holder.pid > 0 && (() => {
        try {
          process.kill(holder.pid!, 0);
          return true;
        } catch {
          return false;
        }
      })();
      if (alive) {
        throw new Error(
          `another 'jeo ${skill}' run (pid ${holder.pid}) holds ${lockPath} — wait for it to finish, or delete the lock file if that process is gone.`,
        );
      }
      await fs.unlink(lockPath).catch(() => {}); // stale (dead/unreadable) → take over once
    }
  }
  throw new Error(`could not acquire ${lockPath} even after stale-lock takeover.`);
}

/** Returns true if the agent is running in development mode (enables self-improvement). */
export function isDevMode(): boolean {
  return jeoEnv("DEV_MODE") === "1" || process.env.NODE_ENV === "development";
}
