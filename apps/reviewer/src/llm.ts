// The only module that knows which LLM vendor is in use.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import {
  generateText,
  hasToolCall,
  Output,
  stepCountIs,
  tool,
  type LanguageModel,
  type ToolSet,
} from "ai";
import type { z } from "zod";
import {
  LLM_REASONING_LEVELS,
  LLM_TIMEOUT_MS,
  LLM_TOTAL_TIMEOUT_MS,
  TOOL_MAX_STEPS,
} from "./constants.js";

export interface LlmProvider {
  generate<T>(req: {
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    tools?: ToolSet;
  }): Promise<T>;
}

const SUBMIT_TOOL = "submit";
const SUBMIT_DESCRIPTION =
  "Submit your final answer. Call it exactly once, when you are done.";

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

  const common = {
    model,
    reasoning,
    timeout: { stepMs: LLM_TIMEOUT_MS, totalMs: LLM_TOTAL_TIMEOUT_MS },
  };

  return {
    async generate({ system, prompt, schema, tools }) {
      if (!tools) {
        const { output } = await generateText({
          ...common,
          instructions: system,
          prompt,
          output: Output.object({ schema }),
        });
        return output;
      }
      const { steps } = await generateText({
        ...common,
        instructions: system,
        prompt,
        tools: {
          ...tools,
          [SUBMIT_TOOL]: tool({
            description: SUBMIT_DESCRIPTION,
            inputSchema: schema,
          }),
        },
        toolChoice: "required",
        stopWhen: [stepCountIs(TOOL_MAX_STEPS + 1), hasToolCall(SUBMIT_TOOL)],
        prepareStep: ({ stepNumber }) =>
          stepNumber === TOOL_MAX_STEPS
            ? { activeTools: [SUBMIT_TOOL] }
            : undefined,
      });
      const submitted = steps
        .flatMap((s) => s.toolCalls)
        .find((c) => c.toolName === SUBMIT_TOOL);
      if (!submitted)
        throw new Error("the model ended without submitting its answer");
      return schema.parse(submitted.input);
    },
  };
}
