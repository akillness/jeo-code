import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export interface Config {
  providers: {
    anthropic?: string;
    openai?: string;
    gemini?: string;
  };
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

const GLOBAL_CONFIG_DIR = path.join(os.homedir(), ".joc");
const GLOBAL_CONFIG_PATH = path.join(GLOBAL_CONFIG_DIR, "config.json");

export async function readGlobalConfig(): Promise<Config> {
  try {
    const data = await fs.readFile(GLOBAL_CONFIG_PATH, "utf-8");
    return JSON.parse(data) as Config;
  } catch {
    // Fallback to environment variables
    return {
      providers: {
        anthropic: process.env.ANTHROPIC_API_KEY,
        openai: process.env.OPENAI_API_KEY,
        gemini: process.env.GEMINI_API_KEY,
      },
      defaultModel: process.env.JOC_DEFAULT_MODEL || "claude-3-5-sonnet",
      thinkingLevel: "medium",
    };
  }
}

export async function saveGlobalConfig(config: Config): Promise<void> {
  await fs.mkdir(GLOBAL_CONFIG_DIR, { recursive: true });
  await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
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
