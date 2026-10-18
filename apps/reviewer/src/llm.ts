// The only module that knows which LLM vendor is in use.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output, type LanguageModel } from "ai";
import type { z } from "zod";
import { LLM_REASONING_LEVELS, LLM_TIMEOUT_MS } from "./constants.js";

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
  // Reasoning models can think for minutes; "none" makes cheap/free ones usable.
  const reasoning = (env.LLM_REASONING ||
    "provider-default") as (typeof LLM_REASONING_LEVELS)[number];
  if (!LLM_REASONING_LEVELS.includes(reasoning)) {
    throw new Error(
      `LLM_REASONING must be one of ${LLM_REASONING_LEVELS.join(", ")}; got "${reasoning}"`,
    );
  }
  const settings = {
    apiKey: env.LLM_API_KEY,
    baseURL: env.LLM_BASE_URL || undefined,
  };
  const factory = {
    anthropic: createAnthropic,
    openai: createOpenAI,
    gemini: createGoogle,
  }[provider as ProviderName];
  // OpenAI-compatible endpoints (OpenRouter, local models) speak Chat Completions, not OpenAI's Responses API.
  const model: LanguageModel =
    provider === "openai" && settings.baseURL
      ? createOpenAI(settings).chat(env.LLM_MODEL)
      : factory(settings)(env.LLM_MODEL);

  return {
    async generate({ system, prompt, schema }) {
      const { output } = await generateText({
        model,
        instructions: system,
        prompt,
        reasoning,
        timeout: LLM_TIMEOUT_MS,
        output: Output.object({ schema }),
      });
      return output;
    },
  };
}
