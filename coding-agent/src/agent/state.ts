import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

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
   * OAuth credentials (take precedence over API keys for the same provider).
   * A bare string is a legacy/manually-pasted bearer with no refresh metadata;
   * a {@link StoredOAuth} object carries refresh token + expiry for auto-refresh.
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
  thinkingLevel?: "low" | "medium" | "high";
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
  seed_path?: string;
  plan_path?: string;
  completed_tasks?: string[];
  pending_tasks?: string[];
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
    ollamaBaseUrl: cfg.ollamaBaseUrl || process.env.OLLAMA_HOST || "http://localhost:11434",
    openaiBaseUrl: cfg.openaiBaseUrl || process.env.OPENAI_BASE_URL,
  };
}

export async function readGlobalConfig(): Promise<Config> {
  try {
    const data = await fs.readFile(globalConfigPath(), "utf-8");
    return withEnvOverlay(JSON.parse(data) as Config);
  } catch {
    // Fallback to environment variables
    return withEnvOverlay({
      providers: {
        anthropic: process.env.ANTHROPIC_API_KEY,
        openai: process.env.OPENAI_API_KEY,
        gemini: process.env.GEMINI_API_KEY,
      },
      defaultModel: process.env.JOC_DEFAULT_MODEL || "claude-3-5-sonnet",
      thinkingLevel: "medium",
    });
  }
}

export async function saveGlobalConfig(config: Config): Promise<void> {
  await fs.mkdir(globalConfigDir(), { recursive: true });
  await fs.writeFile(globalConfigPath(), JSON.stringify(config, null, 2), "utf-8");
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
