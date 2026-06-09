import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { parseConfig } from "./config-schema";

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

export interface Config {
  providers: {
    anthropic?: string;
    openai?: string;
    gemini?: string;
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
  };
  /** Base URL for the local Ollama server (keyless). */
  ollamaBaseUrl?: string;
  /** Base URL override for OpenAI-compatible providers (LM Studio, vLLM, llama-cpp-server, ...). */
  openaiBaseUrl?: string;
  defaultModel: string;
  thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Friendly model aliases, e.g. { fast: "ollama/qwen2.5:0.5b" }. Override built-ins. */
  modelAliases?: { [alias: string]: string };
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
  };
  /**
   * Per-subagent-role overrides (gjc role-agent parity). Keyed by role id
   * (executor / planner / architect / critic); each may pin a model and/or a
   * tool-loop step budget.
   */
  subagents?: { [roleId: string]: { model?: string; maxSteps?: number } };
  /**
   * Model role tiers (gjc `--smol`/`--slow`/`--plan` parity). Each falls back to
   * `defaultModel`. Env `JOC_SMOL_MODEL`/`JOC_SLOW_MODEL`/`JOC_PLAN_MODEL` fill gaps.
   */
  roles?: { smol?: string; slow?: string; plan?: string };
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
  seed_path?: string;
  plan_path?: string;
  completed_tasks?: string[];
  pending_tasks?: string[];
  approved?: boolean;
  /** ultragoal terminal outcome. */
  status?: string;
  passed?: number;
  total?: number;
}

/**
 * Resolve the global config directory at call time (not import time) so that a
 * `JOC_CONFIG_DIR` override or a runtime `HOME` change is always honored.
 * `JOC_CONFIG_DIR` takes precedence; otherwise `~/.joc`.
 */
function globalConfigDir(): string {
  return process.env.JOC_CONFIG_DIR || path.join(os.homedir(), ".joc");
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

/** Merge env-provided OAuth tokens / Ollama base over a config (env fills gaps only). */
function withEnvOverlay(cfg: Config): Config {
  const envTok = envOAuth();
  const oauth = { ...envTok, ...(cfg.oauth ?? {}) };
  return {
    ...cfg,
    oauth,
    defaultModel: process.env.JOC_DEFAULT_MODEL || cfg.defaultModel,
    ollamaBaseUrl: cfg.ollamaBaseUrl || process.env.OLLAMA_HOST || "http://localhost:11434",
    openaiBaseUrl: cfg.openaiBaseUrl || process.env.OPENAI_BASE_URL,
    roles: {
      smol: cfg.roles?.smol || process.env.JOC_SMOL_MODEL,
      slow: cfg.roles?.slow || process.env.JOC_SLOW_MODEL,
      plan: cfg.roles?.plan || process.env.JOC_PLAN_MODEL,
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
    defaultModel: process.env.JOC_DEFAULT_MODEL || "claude-sonnet-4-5",
    thinkingLevel: "medium",
  };
}

export async function readGlobalConfig(): Promise<Config> {
  let data: string;
  try {
    data = await fs.readFile(globalConfigPath(), "utf-8");
  } catch {
    return withEnvOverlay(envDefaultConfig());
  }

  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    process.stderr.write(`[joc] ${globalConfigPath()} is not valid JSON; using environment defaults.\n`);
    return withEnvOverlay(envDefaultConfig());
  }

  const parsed = parseConfig(raw);
  if (!parsed.ok) {
    process.stderr.write(`[joc] ${globalConfigPath()} is invalid (${parsed.message}); using environment defaults.\n`);
    return withEnvOverlay(envDefaultConfig());
  }
  return withEnvOverlay(parsed.config as Config);
}

export async function saveGlobalConfig(config: Config): Promise<void> {
  await fs.mkdir(globalConfigDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(globalConfigPath(), JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(globalConfigPath(), 0o600).catch(() => {}); // ensure mode even if file pre-existed
}

/** Read the on-disk config WITHOUT the env overlay. Used as the base for
 *  persistence so env-only values (OAuth bearer tokens, JOC_DEFAULT_MODEL,
 *  JOC_*_MODEL role tiers, OLLAMA_HOST/OPENAI_BASE_URL) are never baked into
 *  ~/.joc/config.json by an unrelated `/agents`/`/roles`/`/model save`. */
export async function readRawGlobalConfig(): Promise<Config> {
  const clean: Config = { providers: {}, defaultModel: "claude-3-5-sonnet", thinkingLevel: "medium" };
  let data: string;
  try {
    data = await fs.readFile(globalConfigPath(), "utf-8");
  } catch {
    return clean;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return clean;
  }
  const parsed = parseConfig(raw);
  return parsed.ok ? (parsed.config as Config) : clean;
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

export function getLocalJocDir(cwd: string = process.cwd()): string {
  return path.join(cwd, ".joc");
}

export async function readWorkflowState(
  skill: "deep-interview" | "ralplan" | "team" | "ultragoal",
  cwd: string = process.cwd()
): Promise<WorkflowState | null> {
  const statePath = path.join(getLocalJocDir(cwd), "state", `${skill}-state.json`);
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
  const statePath = path.join(getLocalJocDir(cwd), "state", `${skill}-state.json`);
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
  const stateDir = path.join(getLocalJocDir(cwd), "state");
  await fs.mkdir(stateDir, { recursive: true });
  const statePath = path.join(stateDir, `${skill}-state.json`);
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
  return statePath;
}

export async function clearWorkflowState(
  skill: "deep-interview" | "ralplan" | "team" | "ultragoal",
  cwd: string = process.cwd()
): Promise<void> {
  const statePath = path.join(getLocalJocDir(cwd), "state", `${skill}-state.json`);
  try {
    await fs.unlink(statePath);
  } catch {}
}
