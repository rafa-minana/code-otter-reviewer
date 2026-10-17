import type { Finding } from "@otter/contracts";
import type { LlmProvider } from "./llm.js";

/** Verifier agent: confirms or drops each finding and scores its confidence. */
export async function verify(llm: LlmProvider, findings: Finding[]): Promise<Finding[]> {
  throw new Error("not implemented");
}

/** Pure: keeps findings at or above the threshold. */
export function filterByConfidence(findings: Finding[], threshold: number): Finding[] {
  throw new Error("not implemented");
}
