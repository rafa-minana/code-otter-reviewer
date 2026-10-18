import type { Finding } from "@otter/contracts";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { LlmProvider } from "./llm.js";
import { VERIFY_SYSTEM_PROMPT } from "./prompts/verify.js";

const scoresSchema = z.object({
  scores: z.array(z.object({ index: z.number().int(), score: z.number() })),
});

/** Verifier agent: one call per chunk scores each finding 0..10; confidence = score / 10, unscored = 0. */
export async function verify(
  llm: LlmProvider,
  chunk: string,
  findings: Finding[],
  tools?: ToolSet,
): Promise<Finding[]> {
  const listed = findings.map(
    ({ path, startLine, line, severity, body, suggestion }, index) => ({
      index,
      path,
      startLine,
      line,
      severity,
      body,
      suggestion,
    }),
  );
  const { scores } = await llm.generate({
    system: VERIFY_SYSTEM_PROMPT,
    prompt: `<untrusted>\n${chunk}\n\n## Findings\n${JSON.stringify(listed, null, 2)}\n</untrusted>`,
    schema: scoresSchema,
    tools,
  });
  const byIndex = new Map(scores.map((s) => [s.index, s.score]));
  return findings.map((f, i) => ({
    ...f,
    confidence: Math.min(Math.max(byIndex.get(i) ?? 0, 0), 10) / 10,
  }));
}

/** Pure: keeps findings at or above the threshold. */
export function filterByConfidence(
  findings: Finding[],
  threshold: number,
): Finding[] {
  return findings.filter((f) => (f.confidence ?? 0) >= threshold);
}
