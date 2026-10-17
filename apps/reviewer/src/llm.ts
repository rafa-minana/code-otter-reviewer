// The only module that knows which LLM vendor is in use.
export interface Message {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LlmProvider {
  chat(req: { system: string; messages: Message[]; tools?: Tool[] }): Promise<{ text: string; toolCalls: ToolCall[] }>;
}

export const PROVIDERS = ["anthropic", "openai", "gemini"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export function createLlm(env: Record<string, string | undefined> = process.env): LlmProvider {
  const provider = env.LLM_PROVIDER;
  if (!PROVIDERS.includes(provider as ProviderName)) {
    throw new Error(`LLM_PROVIDER must be one of ${PROVIDERS.join(", ")}; got "${provider}"`);
  }
  // v0: implement with the Vercel AI SDK (one adapter for all three providers).
  return {
    async chat() {
      throw new Error(`not implemented: ${provider}`);
    },
  };
}
