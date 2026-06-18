import { makeOpenAICompatibleAdapter } from "./openai-compatible";

/** LM Studio — local, keyless, OpenAI-compatible server (default http://localhost:1234/v1). */
export const lmstudioAdapter = makeOpenAICompatibleAdapter({
  name: "lmstudio",
  baseUrl: "http://localhost:1234/v1",
  keyless: true,
});
