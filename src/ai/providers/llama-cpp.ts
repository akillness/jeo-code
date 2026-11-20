/**
 * Dedicated `llama.cpp` (`llama-server`) Provider Adapter.
 *
 * Implements the 3-tier adaptive tool-calling cascade:
 *   1. "native"     - OpenAI `/v1/chat/completions` with `tools`
 *   2. "structured" - Constrained GBNF `grammar` / `json_schema` envelope
 *   3. "prose"      - Canonical JSON-in-prose + reasoning recovery
 */

import type { Credential } from "../../auth";
import type { CallOptions, Message, ProviderAdapter } from "../types";
import { ProviderHttpError, relabelProviderError } from "./errors";
import { openaiAdapter, isUnsupportedToolsError } from "./openai";
import {
  buildToolCallGbnfGrammar,
  buildToolCallJsonSchema,
  demoteToolTier,
  endpointTierKey,
  getEffectiveToolTier,
  type ToolCallingTier,
} from "./local-capabilities";

export const DEFAULT_LLAMA_CPP_BASE_URL = "http://localhost:8080/v1";

export function normalizeLlamaCppBaseUrl(baseUrl?: string): string {
  const raw = (baseUrl ?? process.env.LLAMA_CPP_BASE_URL ?? DEFAULT_LLAMA_CPP_BASE_URL).trim();
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const parsed = new URL(withScheme);
    const cleanPath = parsed.pathname.replace(/\/+$/, "");
    const finalPath = cleanPath === "" ? "/v1" : cleanPath;
    return `${parsed.origin}${finalPath}${parsed.search}`;
  } catch {
    const trimmed = withScheme.replace(/\/+$/, "");
    return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
  }
}

export function stripLlamaCppPrefix(model: string): string {
  return model.startsWith("llama-cpp/") ? model.slice("llama-cpp/".length) : model;
}

function isStructuredTierRejection(err: unknown): boolean {
  if (!(err instanceof ProviderHttpError)) return false;
  if (err.status !== 400 && err.status !== 422) return false;
  return /grammar|json_schema|response_format|schema|template|tool|function|unsupported|invalid/i.test(
    err.message,
  );
}

function isNativeTierRejection(err: unknown): boolean {
  if (!(err instanceof ProviderHttpError)) return false;
  if (err.status !== 400 && err.status !== 422 && err.status !== 501) return false;
  return (
    isUnsupportedToolsError('{"tools":[{"name":"x"}]}', err.message) ||
    /jinja|template|tool|function|not supported|unsupported/i.test(err.message)
  );
}

function buildTierOptions(
  options: CallOptions,
  baseUrl: string,
  bareModel: string,
  tier: ToolCallingTier,
): CallOptions {
  if (!options.tools?.length) {
    return {
      ...options,
      model: bareModel,
      baseUrl,
      toolCallingTier: tier,
    };
  }

  if (tier === "native") {
    return {
      ...options,
      model: bareModel,
      baseUrl,
      toolCallingTier: "native",
    };
  }

  if (tier === "structured") {
    const grammar = options.grammar ?? buildToolCallGbnfGrammar(options.tools);
    const jsonSchema = options.jsonSchema ?? buildToolCallJsonSchema(options.tools);
    return {
      ...options,
      model: bareModel,
      baseUrl,
      tools: undefined,
      grammar,
      jsonSchema,
      toolCallingTier: "structured",
    };
  }

  return {
    ...options,
    model: bareModel,
    baseUrl,
    tools: undefined,
    grammar: undefined,
    jsonSchema: undefined,
    jsonMode: false,
    toolCallingTier: "prose",
  };
}

function effectiveCredential(credential: Credential): Credential {
  if (credential.kind === "api_key" && credential.token) return credential;
  const envKey = process.env.LLAMA_CPP_API_KEY?.trim();
  if (envKey) {
    return { kind: "api_key", provider: "openai", token: envKey };
  }
  return { kind: "none", provider: "openai" };
}

export const llamaCppAdapter: ProviderAdapter = {
  name: "llama-cpp",
  supportsNativeTools: true,

  async call(messages: Message[], options: CallOptions, credential: Credential): Promise<string> {
    const baseUrl = normalizeLlamaCppBaseUrl(options.baseUrl);
    const bareModel = stripLlamaCppPrefix(options.model);
    const cred = effectiveCredential(credential);
    const tierKey = endpointTierKey("llama-cpp", baseUrl, bareModel);

    if (!options.tools?.length && !options.grammar && !options.jsonSchema) {
      try {
        return await openaiAdapter.call(
          messages,
          { ...options, model: bareModel, baseUrl },
          cred,
        );
      } catch (err) {
        throw relabelProviderError(err, "llama.cpp");
      }
    }

    let activeTier: ToolCallingTier =
      options.toolCallingTier ?? getEffectiveToolTier(tierKey, "native");

    while (true) {
      const attemptOpts = buildTierOptions(options, baseUrl, bareModel, activeTier);
      try {
        return await openaiAdapter.call(messages, attemptOpts, cred);
      } catch (err) {
        if (options.signal?.aborted) throw relabelProviderError(err, "llama.cpp");

        if (activeTier === "native" && isNativeTierRejection(err)) {
          activeTier = demoteToolTier(tierKey, "native", (err as Error).message);
          continue;
        }
        if (activeTier === "structured" && isStructuredTierRejection(err)) {
          activeTier = demoteToolTier(tierKey, "structured", (err as Error).message);
          continue;
        }
        throw relabelProviderError(err, "llama.cpp");
      }
    }
  },

  async *stream(
    messages: Message[],
    options: CallOptions,
    credential: Credential,
  ): AsyncIterable<string> {
    const baseUrl = normalizeLlamaCppBaseUrl(options.baseUrl);
    const bareModel = stripLlamaCppPrefix(options.model);
    const cred = effectiveCredential(credential);
    const tierKey = endpointTierKey("llama-cpp", baseUrl, bareModel);

    if (!options.tools?.length && !options.grammar && !options.jsonSchema) {
      try {
        yield* openaiAdapter.stream!(
          messages,
          { ...options, model: bareModel, baseUrl },
          cred,
        );
        return;
      } catch (err) {
        throw relabelProviderError(err, "llama.cpp");
      }
    }

    let activeTier: ToolCallingTier =
      options.toolCallingTier ?? getEffectiveToolTier(tierKey, "native");

    while (true) {
      const attemptOpts = buildTierOptions(options, baseUrl, bareModel, activeTier);
      let yielded = false;
      try {
        for await (const chunk of openaiAdapter.stream!(messages, attemptOpts, cred)) {
          yielded = true;
          yield chunk;
        }
        return;
      } catch (err) {
        if (yielded || options.signal?.aborted) {
          throw relabelProviderError(err, "llama.cpp");
        }
        if (activeTier === "native" && isNativeTierRejection(err)) {
          activeTier = demoteToolTier(tierKey, "native", (err as Error).message);
          continue;
        }
        if (activeTier === "structured" && isStructuredTierRejection(err)) {
          activeTier = demoteToolTier(tierKey, "structured", (err as Error).message);
          continue;
        }
        throw relabelProviderError(err, "llama.cpp");
      }
    }
  },
};
