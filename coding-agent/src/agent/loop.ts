import { createModelManager, type Message as AiMessage } from "../ai";

export type Message = AiMessage;

export interface ChatOptions {
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

const manager = createModelManager();

export async function callLlm(
  messages: Message[],
  options: ChatOptions = {}
): Promise<string> {
  return manager.call(messages, options);
}
