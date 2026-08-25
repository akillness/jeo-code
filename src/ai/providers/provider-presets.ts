/**
 * Provider presets — one-flag onboarding for well-known OpenAI/Anthropic-compatible
 * gateways (gjc/gajae-code parity).
 *
 * A preset is a pre-filled {@link CustomProviderConfig}: base URL, wire protocol,
 * credential env var, and (when the endpoint has a fixed catalog) the model ids. It
 * exists so the common case is `jeo provider add --preset litellm --base-url <url>`
 * instead of remembering four flags and an exact URL.
 *
 * Two kinds:
 *  - FIXED presets pin a base URL (the vendor runs the endpoint).
 *  - PARAMETERIZED presets (`parameterized: true`) are proxies/gateways the USER runs,
 *    so `--base-url` is required and the preset only supplies protocol + env var +
 *    discovery expectations.
 *
 * Presets never contain secrets. `apiKeyEnv` names the environment variable to read.
 */
import type { CustomProviderConfig, ProviderCompatibility } from "./custom-providers";

export interface ProviderPreset {
  /** Canonical preset id (what the user types after `--preset`). */
  readonly id: string;
  /** Extra accepted spellings. */
  readonly aliases: readonly string[];
  /** Display name. */
  readonly label: string;
  /** One-line description shown by `/provider presets`. */
  readonly description: string;
  /** Wire protocol. */
  readonly protocol: ProviderCompatibility;
  /** Default provider id created when the user does not pass `--id`. */
  readonly providerId: string;
  /** Fixed base URL. Absent for parameterized presets. */
  readonly baseUrl?: string;
  /** Env var that supplies the API key. */
  readonly apiKeyEnv: string;
  /** Known model ids (BARE). Absent when the endpoint supports live `/models`. */
  readonly models?: readonly string[];
  /** Preferred default model (BARE). */
  readonly defaultModel?: string;
  /** Native-reasoning enablement for this backend. */
  readonly thinkingFormat?: CustomProviderConfig["thinkingFormat"];
  /** True when the user must supply `--base-url` (self-hosted / account-scoped gateway). */
  readonly parameterized?: boolean;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  // --- Self-hosted / user-run gateways (base URL required) --------------------
  {
    id: "openai-compatible-proxy",
    aliases: ["openai-proxy", "compatible-proxy", "custom-proxy", "proxy"],
    label: "OpenAI-Compatible Proxy",
    description: "Generic OpenAI-compatible gateway with live /models discovery (requires --base-url)",
    protocol: "openai",
    providerId: "openai-compatible-proxy",
    apiKeyEnv: "OPENAI_COMPATIBLE_API_KEY",
    parameterized: true,
  },
  {
    id: "anthropic-compatible-proxy",
    aliases: ["anthropic-proxy", "claude-proxy", "messages-proxy"],
    label: "Anthropic-Compatible Proxy",
    description: "Generic Anthropic Messages gateway, /v1/messages wire format (requires --base-url)",
    protocol: "anthropic",
    providerId: "anthropic-compatible-proxy",
    apiKeyEnv: "ANTHROPIC_COMPATIBLE_API_KEY",
    parameterized: true,
  },
  {
    id: "litellm",
    aliases: ["litellm-proxy"],
    label: "LiteLLM Proxy",
    description: "Self-hosted LiteLLM proxy; its catalog is whatever your config.yaml routes (requires --base-url)",
    protocol: "openai",
    providerId: "litellm-proxy",
    apiKeyEnv: "LITELLM_API_KEY",
    parameterized: true,
  },
  {
    id: "vllm",
    aliases: ["vllm-server"],
    label: "vLLM",
    description: "Self-hosted vLLM OpenAI-compatible server (requires --base-url, usually http://host:8000/v1)",
    protocol: "openai",
    providerId: "vllm",
    apiKeyEnv: "VLLM_API_KEY",
    parameterized: true,
  },
  {
    id: "sglang",
    aliases: ["sgl"],
    label: "SGLang",
    description: "Self-hosted SGLang OpenAI-compatible server (requires --base-url, usually http://host:30000/v1)",
    protocol: "openai",
    providerId: "sglang",
    apiKeyEnv: "SGLANG_API_KEY",
    parameterized: true,
  },
  {
    id: "llama-cpp",
    aliases: ["llamacpp", "llama.cpp", "llama-server"],
    label: "llama.cpp server",
    description: "Self-hosted llama.cpp server (requires --base-url, usually http://localhost:8080/v1)",
    protocol: "openai",
    providerId: "llama-cpp",
    apiKeyEnv: "LLAMA_CPP_API_KEY",
    parameterized: true,
  },
  {
    id: "azure-openai",
    aliases: ["azure", "aoai"],
    label: "Azure OpenAI",
    description: "Azure OpenAI deployment served over the OpenAI wire format (requires --base-url with api-version)",
    protocol: "openai",
    providerId: "azure-openai",
    apiKeyEnv: "AZURE_OPENAI_API_KEY",
    parameterized: true,
  },
  {
    id: "vercel-ai-gateway",
    aliases: ["vercel", "ai-gateway"],
    label: "Vercel AI Gateway",
    description: "Vercel AI Gateway OpenAI-compatible endpoint (requires --base-url for your gateway)",
    protocol: "openai",
    providerId: "vercel-ai-gateway",
    apiKeyEnv: "AI_GATEWAY_API_KEY",
    parameterized: true,
  },
  {
    id: "cloudflare-ai-gateway",
    aliases: ["cloudflare", "cf-gateway"],
    label: "Cloudflare AI Gateway",
    description: "Cloudflare AI Gateway OpenAI-compatible endpoint (requires --base-url for your account/gateway)",
    protocol: "openai",
    providerId: "cloudflare-ai-gateway",
    apiKeyEnv: "CLOUDFLARE_AI_GATEWAY_API_KEY",
    parameterized: true,
  },

  // --- Vendor-hosted endpoints (fixed base URL) -------------------------------
  {
    id: "glm",
    aliases: ["zai-openai", "z-ai-openai", "bigmodel"],
    label: "GLM / z.ai (OpenAI wire)",
    description: "z.ai / BigModel GLM served over the OpenAI wire format",
    protocol: "openai",
    providerId: "glm-proxy",
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnv: "ZAI_API_KEY",
    models: ["glm-5.2", "glm-5.1", "glm-5", "glm-4.6"],
    defaultModel: "glm-5.2",
    thinkingFormat: "zai",
  },
  {
    id: "alibaba-token-plan",
    aliases: ["alibaba", "token-plan", "dashscope-token-plan"],
    label: "Alibaba Token Plan",
    description: "Alibaba Token Plan OpenAI-compatible endpoint (Qwen / GLM / DeepSeek)",
    protocol: "openai",
    providerId: "alibaba-token-plan",
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "ALIBABA_TOKEN_PLAN_API_KEY",
    models: ["qwen3.8-max-preview", "qwen3.8-max", "glm-5.2", "deepseek-v4-pro"],
    defaultModel: "qwen3.8-max",
    thinkingFormat: "qwen",
  },
  {
    id: "cline-pass",
    aliases: ["clinepass", "cline"],
    label: "ClinePass",
    description: "ClinePass subscription endpoint with live /models discovery",
    protocol: "openai",
    providerId: "cline-pass",
    baseUrl: "https://api.cline.bot/api/v1",
    apiKeyEnv: "CLINE_API_KEY",
  },
  {
    id: "commandcode-goat",
    aliases: ["commandcode", "command-code", "goat"],
    label: "Command Code GOAT",
    description: "Command Code GOAT coding-plan endpoint with live /models discovery",
    protocol: "openai",
    providerId: "commandcode-goat",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    apiKeyEnv: "CMD_API_KEY",
  },
  {
    id: "ollama-cloud",
    aliases: ["ollama-turbo"],
    label: "Ollama Cloud",
    description: "Ollama's hosted OpenAI-compatible endpoint (separate from a local ollama server)",
    protocol: "openai",
    providerId: "ollama-cloud",
    baseUrl: "https://ollama.com/v1",
    apiKeyEnv: "OLLAMA_API_KEY",
  },
  {
    id: "github-copilot",
    aliases: ["copilot", "gh-copilot"],
    label: "GitHub Copilot",
    description: "GitHub Copilot OpenAI-compatible endpoint (needs a Copilot token in the env var)",
    protocol: "openai",
    providerId: "github-copilot",
    baseUrl: "https://api.githubcopilot.com",
    apiKeyEnv: "GITHUB_COPILOT_TOKEN",
  },
] as const;

const BY_KEY = new Map<string, ProviderPreset>();
for (const preset of PROVIDER_PRESETS) {
  BY_KEY.set(preset.id, preset);
  for (const alias of preset.aliases) BY_KEY.set(alias, preset);
}

/** Resolve a preset by id or alias (case-insensitive). */
export function findProviderPreset(value: string | undefined): ProviderPreset | undefined {
  const key = value?.trim().toLowerCase();
  return key ? BY_KEY.get(key) : undefined;
}

/** Every preset id (canonical only) — used by autocomplete and error messages. */
export const PROVIDER_PRESET_IDS: readonly string[] = PROVIDER_PRESETS.map(p => p.id);

/** Rendered preset list for `/provider presets` and unknown-preset errors. */
export function formatProviderPresetList(): string[] {
  return PROVIDER_PRESETS.map(p => {
    const aliases = p.aliases.length ? ` (aliases: ${p.aliases.join(", ")})` : "";
    const param = p.parameterized ? " [needs --base-url]" : "";
    return `  ${p.id}${aliases}${param} — ${p.description}`;
  });
}

export interface PresetExpandInput {
  /** Preset id or alias. */
  preset: string;
  /** Override the provider id (defaults to the preset's `providerId`). */
  id?: string;
  /** Required for parameterized presets; rejected for fixed ones. */
  baseUrl?: string;
  /** Override the credential env var. */
  apiKeyEnv?: string;
  /** Literal key (stored in config, redacted on display). */
  apiKey?: string;
  /** Extra/override model ids. */
  models?: readonly string[];
}

export interface PresetExpansion {
  id: string;
  config: CustomProviderConfig;
  preset: ProviderPreset;
}

/**
 * Expand a preset into a concrete provider id + config, validating the flag
 * combination the way gajae-code's onboarding does (fixed presets reject
 * `--base-url`; parameterized presets require it).
 */
export function expandProviderPreset(input: PresetExpandInput): PresetExpansion {
  const preset = findProviderPreset(input.preset);
  if (!preset) {
    throw new Error(
      `Unknown provider preset '${input.preset}'. Available presets:\n${formatProviderPresetList().join("\n")}`,
    );
  }
  if (preset.parameterized && !input.baseUrl?.trim()) {
    throw new Error(`Preset '${preset.id}' needs your endpoint: pass --base-url <url>.`);
  }
  if (!preset.parameterized && input.baseUrl?.trim() && input.baseUrl.trim() !== preset.baseUrl) {
    throw new Error(
      `Preset '${preset.id}' pins ${preset.baseUrl}; drop --base-url, or register a fully custom provider with --compat ${preset.protocol}.`,
    );
  }
  const baseUrl = input.baseUrl?.trim() || preset.baseUrl;
  if (!baseUrl) throw new Error(`Preset '${preset.id}' has no base URL — pass --base-url <url>.`);
  const models = input.models && input.models.length > 0 ? [...input.models] : preset.models ? [...preset.models] : undefined;
  return {
    id: (input.id?.trim() || preset.providerId).toLowerCase(),
    preset,
    config: {
      label: preset.label,
      baseUrl,
      protocol: preset.protocol,
      apiKeyEnv: input.apiKeyEnv?.trim() || preset.apiKeyEnv,
      apiKey: input.apiKey?.trim() || undefined,
      models,
      defaultModel: preset.defaultModel ?? models?.[0],
      thinkingFormat: preset.thinkingFormat,
      preset: preset.id,
    },
  };
}
