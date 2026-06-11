import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { parseConfig } from "./config-schema";

export interface StoredOAuth {
  access: string;
  refresh?: string;
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
  oauth?: {
    anthropic?: string | StoredOAuth;
    openai?: string | StoredOAuth;
    gemini?: string | StoredOAuth;
    antigravity?: string | StoredOAuth;
  };
  ollamaBaseUrl?: string;
  openaiBaseUrl?: string;
  defaultModel: string;
  thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh";
  modelAliases?: { [alias: string]: string };
  retry?: {
    requestMaxRetries?: number;
    streamMaxRetries?: number;
    maxRetries?: number;
    maxDelayMs?: number;
    rateLimitRetries?: number;
    rateLimitMinDelayMs?: number;
  };
  subagents?: { [roleId: string]: { model?: string; maxSteps?: number } };
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
  approved?: boolean;
  status?: string;
  passed?: number;
  total?: number;
}

const DEFAULT_MODEL = "claude-sonnet-4-5";

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

function withEnvOverlay(cfg: Config): Config {
  const envTok = envOAuth();
  const oauth = { ...envTok, ...(cfg.oauth ?? {}) };
  const providers: Config["providers"] = { ...(cfg.providers ?? {}) };
  if (!providers.anthropic && process.env.ANTHROPIC_API_KEY) providers.anthropic = process.env.ANTHROPIC_API_KEY;
  if (!providers.openai && process.env.OPENAI_API_KEY) providers.openai = process.env.OPENAI_API_KEY;
  if (!providers.gemini && process.env.GEMINI_API_KEY) providers.gemini = process.env.GEMINI_API_KEY;
  return {
    ...cfg,
    providers,
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
    defaultModel: process.env.JOC_DEFAULT_MODEL || DEFAULT_MODEL,
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
    return withEnvOverlay(envDefaultConfig());
  }
  const parsed = parseConfig(raw);
  return withEnvOverlay(parsed.config as Config);
}

export async function saveGlobalConfig(config: Config): Promise<void> {
  const dir = globalConfigDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const target = globalConfigPath();
  const tmpPath = target + "." + Math.random().toString(36).slice(2) + ".tmp";
  try {
    await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
    await fs.rename(tmpPath, target);
  } catch (err) {
    try { await fs.unlink(tmpPath); } catch {}
    throw err;
  }
}

export async function readRawGlobalConfig(): Promise<Config> {
  const clean: Config = { providers: {}, defaultModel: DEFAULT_MODEL, thinkingLevel: "medium" };
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
  const statePath = path.join(getLocalJocDir(cwd), "state", skill + "-state.json");
  try {
    const data = await fs.readFile(statePath, "utf-8");
    return JSON.parse(data) as WorkflowState;
  } catch {
    return null;
  }
}

export async function readWorkflowStateStrict(
  skill: "deep-interview" | "ralplan" | "team" | "ultragoal",
  cwd: string = process.cwd()
): Promise<WorkflowState | null> {
  const statePath = path.join(getLocalJocDir(cwd), "state", skill + "-state.json");
  let data: string;
  try {
    data = await fs.readFile(statePath, "utf-8");
  } catch (err) {
    if ((err as any).code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(data) as WorkflowState;
  } catch {
    throw new Error("workflow state " + statePath + " is corrupt (invalid JSON)");
  }
}

export async function writeWorkflowState(
  skill: "deep-interview" | "ralplan" | "team" | "ultragoal",
  state: WorkflowState,
  cwd: string = process.cwd()
): Promise<string> {
  const stateDir = path.join(getLocalJocDir(cwd), "state");
  await fs.mkdir(stateDir, { recursive: true });
  const statePath = path.join(stateDir, skill + "-state.json");
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
  return statePath;
}

export async function clearWorkflowState(
  skill: "deep-interview" | "ralplan" | "team" | "ultragoal",
  cwd: string = process.cwd()
): Promise<void> {
  const statePath = path.join(getLocalJocDir(cwd), "state", skill + "-state.json");
  try {
    await fs.unlink(statePath);
  } catch {}
}

export function isDevMode(): boolean {
  return true;
}
