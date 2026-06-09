import { resolveProvider } from "../ai";
import { resolveCredential, type AuthProvider } from "../auth";
import { readGlobalConfig } from "../agent/state";
import type { ToolDefinition, ToolResult } from "./protocol";
import { effectiveCredentialForProvider } from "../ai/model-manager";

const AUTH_PROVIDERS: AuthProvider[] = ["anthropic", "openai", "gemini"];

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

/**
 * The credential kind joc would ACTUALLY use for a provider (the effective credential):
 * an API key wins over OAuth, and an OAuth-only login the bundled adapter can't serve
 * (e.g. Gemini Cloud Code Assist) reports "none". This matches the real call path, unlike
 * the bare resolveCredential() kind.
 */
async function effectiveKind(provider: AuthProvider): Promise<string> {
  const cred = await resolveCredential(provider);
  if (cred.kind === "none") return "none";
  try {
    const cfg = await readGlobalConfig();
    return effectiveCredentialForProvider(provider, cred, cfg, provider).kind;
  } catch {
    return "none"; // OAuth-only but unusable by the bundled adapter
  }
}

export const TOOLS: ToolDefinition[] = [
  {
    name: "joc_resolve_provider",
    description: "Given a model name (e.g. 'claude-3-5-sonnet', 'openai/mock-1', 'gemini-2.0-flash', 'ollama/llama3'), return which provider joc would route the call to.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Model identifier (raw or prefixed)" },
      },
      required: ["model"],
    },
    async handler(args) {
      const model = String(args.model ?? "");
      if (!model) return textResult("error: 'model' is required", true);
      return textResult(resolveProvider(model));
    },
  },
  {
    name: "joc_credential_status",
    description: "Report which auth method is configured for a provider (oauth|api_key|none). Does not reveal the secret.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: AUTH_PROVIDERS, description: "Cloud provider" },
      },
      required: ["provider"],
    },
    async handler(args) {
      const provider = String(args.provider ?? "");
      if (!AUTH_PROVIDERS.includes(provider as AuthProvider)) {
        return textResult(`error: provider must be one of ${AUTH_PROVIDERS.join(", ")}`, true);
      }
      const configured = (await resolveCredential(provider as AuthProvider)).kind;
      const usable = await effectiveKind(provider as AuthProvider);
      return textResult(JSON.stringify({ provider, kind: usable, configured }));
    },
  },
  {
    name: "joc_config_snapshot",
    description: "Return a redacted snapshot of joc's current config: default model, openai/ollama base URLs, and which providers have credentials.",
    inputSchema: { type: "object", properties: {} },
    async handler() {
      const cfg = await readGlobalConfig();
      const snapshot = {
        defaultModel: cfg.defaultModel,
        defaultProvider: resolveProvider(cfg.defaultModel),
        openaiBaseUrl: cfg.openaiBaseUrl ?? null,
        ollamaBaseUrl: cfg.ollamaBaseUrl ?? "http://localhost:11434",
        credentials: {
          anthropic: await effectiveKind("anthropic"),
          openai: await effectiveKind("openai"),
          gemini: await effectiveKind("gemini"),
        },
      };
      return textResult(JSON.stringify(snapshot, null, 2));
    },
  },
  {
    name: "joc_doctor",
    description: "Run joc's health probe and return a structured report of provider connectivity. Same probe used by 'joc doctor' CLI.",
    inputSchema: { type: "object", properties: {} },
    async handler() {
      const { runDoctorCommand } = await import("../commands/doctor");
      const lines: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      };
      try {
        await runDoctorCommand([]);
      } finally {
        console.log = originalLog;
      }
      return textResult(lines.join("\n"));
    },
  },
];

async function captureCommand(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

const PIPELINE_TOOLS: ToolDefinition[] = [
  {
    name: "joc_deep_interview",
    description: "DANGER: WRITES FILES + BURNS LLM CREDITS. Runs Socratic requirements interview. Writes .joc/spec.json. Requires default model credential.",
    inputSchema: {
      type: "object",
      properties: {
        idea: { type: "string", description: "Initial product idea seed" },
      },
      required: ["idea"],
    },
    async handler(args) {
      const idea = String(args.idea ?? "");
      if (!idea) return textResult("error: 'idea' is required", true);
      const { runDeepInterviewCommand } = await import("../commands/deep-interview");
      const out = await captureCommand(() => runDeepInterviewCommand([idea]));
      return textResult(out);
    },
  },
  {
    name: "joc_ralplan",
    description: "DANGER: WRITES FILES + BURNS LLM CREDITS. Reads .joc/spec.json, writes .joc/plan.yaml via Planner/Architect/Critic.",
    inputSchema: { type: "object", properties: {} },
    async handler() {
      const { runRalplanCommand } = await import("../commands/ralplan");
      const out = await captureCommand(() => runRalplanCommand());
      return textResult(out);
    },
  },
  {
    name: "joc_team",
    description: "DANGER: WRITES FILES + EDITS CODE + BURNS LLM CREDITS. Executes .joc/plan.yaml via Executor subagent. Modifies the working tree.",
    inputSchema: { type: "object", properties: {} },
    async handler() {
      const { runTeamCommand } = await import("../commands/team");
      const out = await captureCommand(() => runTeamCommand());
      return textResult(out);
    },
  },
  {
    name: "joc_ultragoal",
    description: "DANGER: BURNS LLM CREDITS. Runs acceptance verification against .joc/spec.json + .joc/plan.yaml.",
    inputSchema: { type: "object", properties: {} },
    async handler() {
      const { runUltragoalCommand } = await import("../commands/ultragoal");
      const out = await captureCommand(() => runUltragoalCommand());
      return textResult(out);
    },
  },
];

if (process.env.JOC_MCP_PIPELINE === "1") {
  TOOLS.push(...PIPELINE_TOOLS);
}
