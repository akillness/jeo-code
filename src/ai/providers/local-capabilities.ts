/**
 * Local Backend Capability Probing, 3-Tier Tool-Calling Memory, and
 * Constrained Decoding Builders (JSON Schema + llama.cpp GBNF Grammar).
 *
 * Pure TypeScript, zero native dependencies.
 */

import type { NativeToolSchema } from "../types";

export type LocalBackendKind = "llama-cpp" | "ollama" | "lmstudio" | "openai-compat";

/**
 * 3-tier adaptive tool-calling hierarchy for local/open-weight models:
 *  1. "native"     — OpenAI/Ollama native `tools` array (`tool_calls` on the wire)
 *  2. "structured" — Grammar / JSON Schema constrained envelope (`grammar` GBNF or `json_schema`)
 *  3. "prose"      — Canonical JSON-in-prose (`extractJsonObjectWithSpan` + reasoning recovery)
 */
export type ToolCallingTier = "native" | "structured" | "prose";

export interface LocalBackendCapabilities {
  backend: LocalBackendKind;
  baseUrl: string;
  reachable: boolean;
  contextWindow?: number;
  supportsNativeTools: boolean;
  supportsGrammar: boolean;
  supportsJsonSchema: boolean;
  recommendedTier: ToolCallingTier;
  modelId?: string;
  probedAt: number;
}

export interface ProbeLocalCapabilitiesOptions {
  modelId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  forceRefresh?: boolean;
  apiKey?: string;
}

export const CAPABILITY_CACHE_TTL_MS = 60_000;

interface CachedCapability {
  value: LocalBackendCapabilities;
  expiresAt: number;
}

const capabilityCache = new Map<string, CachedCapability>();
const toolTierMemory = new Map<string, ToolCallingTier>();

export type TierDemotionListener = (event: {
  endpointKey: string;
  from: ToolCallingTier;
  to: ToolCallingTier;
  reason?: string;
}) => void;

const demotionListeners = new Set<TierDemotionListener>();

export function onTierDemotion(listener: TierDemotionListener): () => void {
  demotionListeners.add(listener);
  return () => demotionListeners.delete(listener);
}

function normalizeEndpointUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

function stripV1Suffix(url: string): string {
  return url.replace(/\/v1$/i, "");
}

export function endpointTierKey(
  provider: string,
  baseUrl: string | undefined,
  model: string,
): string {
  const normUrl = baseUrl ? normalizeEndpointUrl(baseUrl) : "default";
  const normModel = model.trim().toLowerCase();
  return `${provider.toLowerCase()}\0${normUrl}\0${normModel}`;
}

export function getEffectiveToolTier(
  endpointKey: string,
  initialTier: ToolCallingTier = "native",
): ToolCallingTier {
  return toolTierMemory.get(endpointKey) ?? initialTier;
}

export function nextFallbackToolTier(tier: ToolCallingTier): ToolCallingTier {
  if (tier === "native") return "structured";
  if (tier === "structured") return "prose";
  return "prose";
}

export function demoteToolTier(
  endpointKey: string,
  currentTier?: ToolCallingTier,
  reason?: string,
): ToolCallingTier {
  const from = currentTier ?? toolTierMemory.get(endpointKey) ?? "native";
  const to = nextFallbackToolTier(from);
  toolTierMemory.set(endpointKey, to);
  if (from !== to) {
    for (const listener of demotionListeners) {
      try {
        listener({ endpointKey, from, to, reason });
      } catch {
        // Listener failures must never affect inference calls.
      }
    }
  }
  return to;
}

export function clearToolTierMemory(): void {
  toolTierMemory.clear();
}

export function clearCapabilityCache(): void {
  capabilityCache.clear();
}

function defaultFailOpenCapabilities(
  backend: LocalBackendKind,
  baseUrl: string,
  modelId: string | undefined,
  reachable: boolean,
): LocalBackendCapabilities {
  if (backend === "llama-cpp") {
    return {
      backend,
      baseUrl,
      reachable,
      supportsNativeTools: true,
      supportsGrammar: true,
      supportsJsonSchema: true,
      recommendedTier: "native",
      modelId,
      probedAt: Date.now(),
    };
  }
  if (backend === "ollama") {
    return {
      backend,
      baseUrl,
      reachable,
      supportsNativeTools: false,
      supportsGrammar: false,
      supportsJsonSchema: true,
      recommendedTier: "structured",
      modelId,
      probedAt: Date.now(),
    };
  }
  return {
    backend,
    baseUrl,
    reachable,
    supportsNativeTools: true,
    supportsGrammar: false,
    supportsJsonSchema: true,
    recommendedTier: "native",
    modelId,
    probedAt: Date.now(),
  };
}

/**
 * Probes a local model server (`/props` for llama.cpp, `/api/show` for Ollama, `/models` for LM Studio / vLLM)
 * with a 60s TTL cache. Always fails open cleanly without throwing.
 */
export async function probeLocalCapabilities(
  backend: LocalBackendKind,
  rawBaseUrl: string,
  opts: ProbeLocalCapabilitiesOptions = {},
): Promise<LocalBackendCapabilities> {
  const baseUrl = normalizeEndpointUrl(rawBaseUrl);
  const cacheKey = `${backend}\0${baseUrl}\0${opts.modelId ?? ""}`;
  const now = Date.now();

  if (!opts.forceRefresh) {
    const hit = capabilityCache.get(cacheKey);
    if (hit && hit.expiresAt > now) {
      return hit.value;
    }
  }

  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 1500;
  const authHeaders: Record<string, string> = opts.apiKey
    ? { Authorization: `Bearer ${opts.apiKey}` }
    : {};

  let result: LocalBackendCapabilities;

  try {
    if (backend === "llama-cpp") {
      const serverRoot = stripV1Suffix(baseUrl);
      const propsResp = await fetchFn(`${serverRoot}/props`, {
        method: "GET",
        headers: authHeaders,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (propsResp.ok) {
        const props = (await propsResp.json()) as {
          default_generation_settings?: { n_ctx?: number };
          chat_template?: string;
          chat_template_tool_use?: string;
          model_path?: string;
        };
        const contextWindow =
          typeof props.default_generation_settings?.n_ctx === "number" &&
          props.default_generation_settings.n_ctx > 0
            ? props.default_generation_settings.n_ctx
            : undefined;
        const hasToolTemplate =
          Boolean(props.chat_template_tool_use) ||
          (typeof props.chat_template === "string"
            ? /tool_call|tools|function/i.test(props.chat_template)
            : true);
        result = {
          backend,
          baseUrl,
          reachable: true,
          contextWindow,
          supportsNativeTools: hasToolTemplate,
          supportsGrammar: true,
          supportsJsonSchema: true,
          recommendedTier: hasToolTemplate ? "native" : "structured",
          modelId: opts.modelId ?? props.model_path,
          probedAt: Date.now(),
        };
      } else {
        const modelsUrl = baseUrl.endsWith("/v1") ? `${baseUrl}/models` : `${serverRoot}/v1/models`;
        const modelsResp = await fetchFn(modelsUrl, {
          method: "GET",
          headers: authHeaders,
          signal: AbortSignal.timeout(timeoutMs),
        });
        result = defaultFailOpenCapabilities(backend, baseUrl, opts.modelId, modelsResp.ok);
      }
    } else if (backend === "ollama") {
      const bareModel = opts.modelId?.replace(/^ollama\//i, "");
      if (bareModel) {
        const showResp = await fetchFn(`${baseUrl}/api/show`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({ name: bareModel }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (showResp.ok) {
          const show = (await showResp.json()) as {
            capabilities?: string[];
            template?: string;
            model_info?: Record<string, unknown>;
          };
          const caps = Array.isArray(show.capabilities) ? show.capabilities : [];
          const supportsNativeTools =
            caps.includes("tools") ||
            (typeof show.template === "string" && /\.Tools\b|tool_call/i.test(show.template));
          let contextWindow: number | undefined;
          if (show.model_info && typeof show.model_info === "object") {
            for (const [k, v] of Object.entries(show.model_info)) {
              if (k.endsWith(".context_length") && typeof v === "number" && v > 0) {
                contextWindow = v;
                break;
              }
            }
          }
          result = {
            backend,
            baseUrl,
            reachable: true,
            contextWindow,
            supportsNativeTools,
            supportsGrammar: false,
            supportsJsonSchema: true,
            recommendedTier: supportsNativeTools ? "native" : "structured",
            modelId: opts.modelId,
            probedAt: Date.now(),
          };
        } else {
          result = defaultFailOpenCapabilities(backend, baseUrl, opts.modelId, false);
        }
      } else {
        const tagsResp = await fetchFn(`${baseUrl}/api/tags`, {
          method: "GET",
          headers: authHeaders,
          signal: AbortSignal.timeout(timeoutMs),
        });
        result = defaultFailOpenCapabilities(backend, baseUrl, opts.modelId, tagsResp.ok);
      }
    } else {
      const modelsUrl = baseUrl.endsWith("/models") ? baseUrl : `${baseUrl}/models`;
      const modelsResp = await fetchFn(modelsUrl, {
        method: "GET",
        headers: authHeaders,
        signal: AbortSignal.timeout(timeoutMs),
      });
      let discoveredModel = opts.modelId;
      if (modelsResp.ok && !discoveredModel) {
        const data = (await modelsResp.json().catch(() => null)) as {
          data?: Array<{ id?: string }>;
        } | null;
        discoveredModel = data?.data?.[0]?.id;
      }
      result = defaultFailOpenCapabilities(backend, baseUrl, discoveredModel, modelsResp.ok);
    }
  } catch {
    result = defaultFailOpenCapabilities(backend, baseUrl, opts.modelId, false);
  }

  capabilityCache.set(cacheKey, {
    value: result,
    expiresAt: Date.now() + CAPABILITY_CACHE_TTL_MS,
  });
  return result;
}

function collectToolNames(tools?: readonly NativeToolSchema[]): string[] {
  const names = new Set<string>();
  if (tools) {
    for (const t of tools) {
      const clean = t.name?.trim();
      if (clean) names.add(clean);
    }
  }
  names.add("done");
  return [...names];
}

/**
 * Builds a JSON Schema matching jeo's canonical tool-call JSON envelope:
 *   Single call: `{ reasoning?: string, tool: "<name>", arguments: { ... } }`
 *   Batch call:  `{ reasoning?: string, tools: [{ tool: "<name>", arguments: { ... } }, ...] }`
 */
export function buildToolCallJsonSchema(
  tools?: readonly NativeToolSchema[],
): Record<string, unknown> {
  const toolNames = collectToolNames(tools);
  const nonDoneNames = toolNames.filter((n) => n !== "done");
  const toolEnum = toolNames.length > 0 ? { type: "string", enum: toolNames } : { type: "string" };
  const batchToolEnum =
    nonDoneNames.length > 0 ? { type: "string", enum: nonDoneNames } : toolEnum;

  const singleBranch: Record<string, unknown> = {
    type: "object",
    properties: {
      reasoning: { type: "string" },
      tool: toolEnum,
      arguments: { type: "object", additionalProperties: true },
    },
    required: ["tool", "arguments"],
    additionalProperties: false,
  };

  const batchBranch: Record<string, unknown> = {
    type: "object",
    properties: {
      reasoning: { type: "string" },
      tools: {
        type: "array",
        minItems: 1,
        maxItems: 6,
        items: {
          type: "object",
          properties: {
            tool: batchToolEnum,
            arguments: { type: "object", additionalProperties: true },
          },
          required: ["tool", "arguments"],
          additionalProperties: false,
        },
      },
    },
    required: ["tools"],
    additionalProperties: false,
  };

  return {
    type: "object",
    anyOf: [singleBranch, batchBranch],
  };
}

function escapeGbnfLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Builds a valid llama.cpp GBNF grammar constraining generation strictly to jeo's
 * canonical single-tool or batched-tool JSON envelope.
 */
export function buildToolCallGbnfGrammar(tools?: readonly NativeToolSchema[]): string {
  const allNames = collectToolNames(tools);
  const nonDoneNames = allNames.filter((n) => n !== "done");

  const toolNameRule = allNames
    .map((n) => `"\\"${escapeGbnfLiteral(n)}\\""`)
    .join(" | ");
  const batchToolNameRule = (nonDoneNames.length > 0 ? nonDoneNames : allNames)
    .map((n) => `"\\"${escapeGbnfLiteral(n)}\\""`)
    .join(" | ");

  return [
    "root ::= ws (single-call | batch-call) ws",
    'single-call ::= "{" ws (reasoning-kv "," ws)? "\\"tool\\"" ws ":" ws tool-name ws "," ws "\\"arguments\\"" ws ":" ws object ws "}"',
    'batch-call ::= "{" ws (reasoning-kv "," ws)? "\\"tools\\"" ws ":" ws "[" ws batch-item (ws "," ws batch-item)* ws "]" ws "}"',
    'batch-item ::= "{" ws "\\"tool\\"" ws ":" ws batch-tool-name ws "," ws "\\"arguments\\"" ws ":" ws object ws "}"',
    'reasoning-kv ::= "\\"reasoning\\"" ws ":" ws string',
    `tool-name ::= ${toolNameRule}`,
    `batch-tool-name ::= ${batchToolNameRule}`,
    'object ::= "{" ws (pair (ws "," ws pair)*)? ws "}"',
    'pair ::= string ws ":" ws value',
    'array ::= "[" ws (value (ws "," ws value)*)? ws "]"',
    'value ::= object | array | string | number | "true" | "false" | "null"',
    'string ::= "\\"" char* "\\""',
    'char ::= [^"\\\\\\x7F\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F]{4})',
    'number ::= "-"? ("0" | [1-9] [0-9]*) ("." [0-9]+)? ([eE] [-+]? [0-9]+)?',
    "ws ::= [ \\t\\n\\r]*",
  ].join("\n");
}
