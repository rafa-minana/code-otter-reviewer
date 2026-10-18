// The only module that knows which LLM vendor is in use.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output, type LanguageModel } from "ai";
import type { z } from "zod";

export interface LlmProvider {
  /** One structured-output call: the result is already validated against `schema`. */
  generate<T>(req: {
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
  }): Promise<T>;
}

export const PROVIDERS = ["anthropic", "openai", "gemini"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export function createLlm(
  env: Record<string, string | undefined> = process.env,
): LlmProvider {
  const provider = env.LLM_PROVIDER;
  if (!PROVIDERS.includes(provider as ProviderName)) {
    throw new Error(
      `LLM_PROVIDER must be one of ${PROVIDERS.join(", ")}; got "${provider}"`,
    );
  }
  if (!env.LLM_MODEL) throw new Error("LLM_MODEL is required");
  const settings = {
    apiKey: env.LLM_API_KEY,
    baseURL: env.LLM_BASE_URL || undefined,
  };
  const factory = {
    anthropic: createAnthropic,
    openai: createOpenAI,
    gemini: createGoogle,
  }[provider as ProviderName];
  const model: LanguageModel = factory(settings)(env.LLM_MODEL);

  return {
    async generate({ system, prompt, schema }) {
      const { output } = await generateText({
        model,
        instructions: system,
        prompt,
        output: Output.object({ schema }),
      });
      return output;
    },
  };
}
