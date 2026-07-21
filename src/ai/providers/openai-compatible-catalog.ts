import type { ProviderName } from "../types";

/**
 * gjc-style data-driven provider catalog. Every entry here is an OpenAI-compatible
 * cloud API (same `/chat/completions` + `/models` wire protocol), so adding a new
 * provider is ONE table row — `register-providers` builds its adapter via
 * `makeOpenAICompatibleAdapter`, and routing / discovery / status / auth all derive
 * their per-provider behavior from this table instead of hardcoded string branches.
 *
 * Constraints kept deliberately uniform so the generic paths stay simple:
 *  - `name` is the routing prefix (`<name>/…`) AND the config/auth key.
 *  - `apiKeyEnv` is `<NAME>_API_KEY` (matches `providerEnvVar`'s convention).
 *  - api-key-only (no OAuth flow); reasoning rides `reasoning_content`/`<think>`.
 */
export interface OpenAICompatProviderDef {
  /** Routing prefix + config/auth key (must be a ProviderName literal). */
  readonly name: ProviderName;
  /** Display name (companyLabel). */
  readonly label: string;
  /** Default API base URL (…/v1) — `${base}/chat/completions` + `${base}/models`. */
  readonly baseUrl: string;
  /** `<NAME>_API_KEY` env var that seeds `config.providers[name]`. */
  readonly apiKeyEnv: string;
  /** Default model id (provider-prefixed) used by `--provider <name>`. */
  readonly defaultModel: string;
  /** Extra well-known model ids (BARE, not provider-prefixed) for the OFFLINE
   *  pick-list fallback shown by `/agents <role> provider <name>` and `--provider`.
   *  Live `/models` discovery supersedes this once the provider is logged in, so
   *  keep only stable/alias-style ids here (a stale id would 404 at inference).
   *  `defaultModel` is always surfaced first regardless of this list. */
  readonly knownModels?: readonly string[];
  /** Wire protocol: "openai" (/chat/completions, default) or "anthropic" (/v1/messages). */
  readonly protocol?: "openai" | "anthropic";
  /** True for subscription/plan products (coding-plan, portal, token-plan, code) rather than
   *  pay-per-token APIs. Surfaced under the `/provider` "OAuth / subscription" onboarding path. */
  readonly subscription?: boolean;
  /** gjc-parity native-reasoning enablement: how this backend turns thinking ON.
   *  "openrouter" → `reasoning:{effort}`; "qwen" → `enable_thinking:true`; "zai" →
   *  `thinking:{type:"enabled"}`. Omitted → OpenAI `reasoning_effort` (o/gpt-5 only). */
  readonly thinkingFormat?: "openai" | "openrouter" | "qwen" | "zai";
}

export const OPENAI_COMPAT_PROVIDERS: readonly OpenAICompatProviderDef[] = [
  { name: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY", defaultModel: "groq/llama-3.3-70b-versatile", knownModels: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "openai/gpt-oss-120b", "openai/gpt-oss-20b"] },
  { name: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY", defaultModel: "deepseek/deepseek-chat", knownModels: ["deepseek-chat", "deepseek-reasoner"] },
  { name: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", apiKeyEnv: "MISTRAL_API_KEY", defaultModel: "mistral/mistral-large-latest", knownModels: ["mistral-large-latest", "mistral-small-latest", "codestral-latest", "ministral-8b-latest"] },
  { name: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", defaultModel: "openrouter/openai/gpt-4o-mini", thinkingFormat: "openrouter" },
  { name: "together", label: "Together", baseUrl: "https://api.together.xyz/v1", apiKeyEnv: "TOGETHER_API_KEY", defaultModel: "together/meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  { name: "cerebras", label: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", apiKeyEnv: "CEREBRAS_API_KEY", defaultModel: "cerebras/llama-3.3-70b", knownModels: ["llama-3.3-70b", "llama3.1-8b", "qwen-3-235b-a22b-instruct-2507"] },
  { name: "fireworks", label: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", apiKeyEnv: "FIREWORKS_API_KEY", defaultModel: "fireworks/accounts/fireworks/models/llama-v3p3-70b-instruct" },
  { name: "nvidia", label: "NVIDIA", baseUrl: "https://integrate.api.nvidia.com/v1", apiKeyEnv: "NVIDIA_API_KEY", defaultModel: "nvidia/meta/llama-3.3-70b-instruct" },
  // Additional gjc-parity OpenAI-compatible clouds (authoritative base URLs + env vars).
  { name: "alibaba-coding-plan", label: "Alibaba Coding Plan", baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1", apiKeyEnv: "ALIBABA_CODING_PLAN_API_KEY", defaultModel: "alibaba-coding-plan/qwen3.5-plus", subscription: true, thinkingFormat: "qwen" },
  { name: "huggingface", label: "Hugging Face", baseUrl: "https://router.huggingface.co/v1", apiKeyEnv: "HF_TOKEN", defaultModel: "huggingface/deepseek-ai/DeepSeek-R1" },
  { name: "nanogpt", label: "NanoGPT", baseUrl: "https://nano-gpt.com/api/v1", apiKeyEnv: "NANO_GPT_API_KEY", defaultModel: "nanogpt/openai/gpt-5.4" },
  { name: "qwen-portal", label: "Qwen Portal", baseUrl: "https://portal.qwen.ai/v1", apiKeyEnv: "QWEN_PORTAL_API_KEY", defaultModel: "qwen-portal/coder-model", subscription: true, thinkingFormat: "qwen" },
  { name: "synthetic", label: "Synthetic", baseUrl: "https://api.synthetic.new/openai/v1", apiKeyEnv: "SYNTHETIC_API_KEY", defaultModel: "synthetic/hf:moonshotai/Kimi-K2.5" },
  { name: "venice", label: "Venice", baseUrl: "https://api.venice.ai/api/v1", apiKeyEnv: "VENICE_API_KEY", defaultModel: "venice/llama-3.3-70b" },
  { name: "zenmux", label: "ZenMux", baseUrl: "https://zenmux.ai/api/v1", apiKeyEnv: "ZENMUX_API_KEY", defaultModel: "zenmux/anthropic/claude-opus-4.6" },
  { name: "qianfan", label: "Qianfan", baseUrl: "https://qianfan.baidubce.com/v2", apiKeyEnv: "QIANFAN_API_KEY", defaultModel: "qianfan/deepseek-v3.2" },
  { name: "xiaomi", label: "Xiaomi", baseUrl: "https://api.xiaomimimo.com/v1", apiKeyEnv: "XIAOMI_API_KEY", defaultModel: "xiaomi/mimo-v2-flash" },
  { name: "deepinfra", label: "DeepInfra", baseUrl: "https://api.deepinfra.com/v1/openai", apiKeyEnv: "DEEPINFRA_API_KEY", defaultModel: "deepinfra/deepseek-ai/DeepSeek-V3.2", knownModels: ["deepseek-ai/DeepSeek-V3.2", "deepseek-ai/DeepSeek-R1-0528", "meta-llama/Llama-3.3-70B-Instruct-Turbo", "moonshotai/Kimi-K2.6", "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo", "openai/gpt-oss-120b"] },
  // Self-hosted OpenAI-compatible proxy (LiteLLM) — the model catalog behind it is
  // entirely user-configured (whatever the user's own litellm config.yaml routes to),
  // so unlike every other row here there is no globally-fixed `knownModels` list to
  // offer; `baseUrl` is LiteLLM's own documented local-proxy default and is expected
  // to be overridden via `jeo provider add litellm --base-url <your-proxy-url>`.
  { name: "litellm", label: "LiteLLM", baseUrl: "http://localhost:4000/v1", apiKeyEnv: "LITELLM_API_KEY", defaultModel: "litellm/gpt-4o-mini" },
  { name: "xiaomi-token-plan-ams", label: "Xiaomi Token Plan (Europe)", baseUrl: "https://token-plan-ams.xiaomimimo.com/v1", apiKeyEnv: "XIAOMI_TOKEN_PLAN_AMS_API_KEY", defaultModel: "xiaomi-token-plan-ams/mimo-v2.5", subscription: true },
  { name: "xiaomi-token-plan-cn", label: "Xiaomi Token Plan (China)", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", apiKeyEnv: "XIAOMI_TOKEN_PLAN_CN_API_KEY", defaultModel: "xiaomi-token-plan-cn/mimo-v2.5", subscription: true },
  { name: "xiaomi-token-plan-sgp", label: "Xiaomi Token Plan (Singapore)", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1", apiKeyEnv: "XIAOMI_TOKEN_PLAN_SGP_API_KEY", defaultModel: "xiaomi-token-plan-sgp/mimo-v2.5", subscription: true },
  { name: "minimax-code", label: "MiniMax Code", baseUrl: "https://api.minimax.io/v1", apiKeyEnv: "MINIMAX_CODE_API_KEY", defaultModel: "minimax-code/minimax-m3", subscription: true },
  { name: "minimax-code-cn", label: "MiniMax Code (China)", baseUrl: "https://api.minimaxi.com/v1", apiKeyEnv: "MINIMAX_CODE_CN_API_KEY", defaultModel: "minimax-code-cn/minimax-m3", subscription: true },
  // Anthropic-Messages-protocol providers (served via makeAnthropicCompatibleAdapter).
  { name: "zai", label: "z.ai", baseUrl: "https://api.z.ai/api/anthropic", apiKeyEnv: "ZAI_API_KEY", defaultModel: "zai/glm-5.2", protocol: "anthropic" },
  { name: "minimax", label: "MiniMax", baseUrl: "https://api.minimax.io/anthropic", apiKeyEnv: "MINIMAX_API_KEY", defaultModel: "minimax/minimax-m3", protocol: "anthropic" },
  // Tencent Cloud MaaS (international) serves DeepSeek / MiniMax / Zhipu GLM / Moonshot Kimi / Hunyuan models over the Anthropic Messages wire format at tokenhub-intl; `${base}/v1/messages` is pinned by the adapter. All ids below verified live (2026-06) via /v1/messages probes — each returned either a completion or FREE_QUOTA_EXHAUSTED (both prove the id is recognized); the host has no /v1/models route, so this list is the picker's source of truth for the offline fallback.
  { name: "tencent", label: "Tencent", baseUrl: "https://tokenhub-intl.tencentcloudmaas.com", apiKeyEnv: "TENCENT_API_KEY", defaultModel: "tencent/deepseek-v4-pro", knownModels: ["deepseek-v4-pro", "deepseek-v4-pro-202606", "deepseek-v4-flash", "deepseek-v4-flash-202605", "deepseek-v3.2", "minimax-m3", "minimax-m2.7", "minimax-m2.5", "glm-5.2", "glm-5.1", "glm-5", "glm-5-turbo", "glm-5v-turbo", "kimi-k2.6", "kimi-k2.5", "hy-mt2-plus"], protocol: "anthropic" },

];

const BY_NAME = new Map<string, OpenAICompatProviderDef>(OPENAI_COMPAT_PROVIDERS.map(p => [p.name, p]));

/** All catalog provider names (for PROVIDER_NAMES / AuthProvider unions). */
export const OPENAI_COMPAT_NAMES: readonly ProviderName[] = OPENAI_COMPAT_PROVIDERS.map(p => p.name);

/** Subscription/plan-tier provider names (coding-plan, portal, token-plan, code) — surfaced
 *  under the `/provider` "OAuth / subscription" onboarding path rather than the generic API-key list. */
export const SUBSCRIPTION_PROVIDER_NAMES: readonly ProviderName[] = OPENAI_COMPAT_PROVIDERS.filter(p => p.subscription).map(p => p.name);

/** Catalog entry for a provider name, or undefined when it is not catalog-driven. */
export function openaiCompatDef(name: string): OpenAICompatProviderDef | undefined {
  return BY_NAME.get(name);
}

/** True when `name` is a catalog-driven OpenAI-compatible provider. */
export function isOpenAICompatProvider(name: string): boolean {
  return BY_NAME.has(name);
}
