import { createModelManager, type Message as AiMessage } from "../ai";

export type Message = AiMessage;

export interface ChatOptions {
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  signal?: AbortSignal;
  onUsage?: (usage: import("../ai/types").Usage) => void;
  /** Notified before each provider auto-retry backoff wait (e.g. rate limits). */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

const manager = createModelManager();

export async function callLlm(
  messages: Message[],
  options: ChatOptions = {}
): Promise<string> {
  return manager.call(messages, options);
}
