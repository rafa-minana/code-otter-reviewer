import type { Finding, ReviewerInput } from "@otter/contracts";
import type { LlmProvider } from "./llm.js";

export async function review(llm: LlmProvider, input: ReviewerInput, hints: string): Promise<Finding[]> {
  throw new Error("not implemented");
}
