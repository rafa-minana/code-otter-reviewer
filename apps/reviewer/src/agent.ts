import { matchesGlob } from "node:path";
import type { Finding, ReviewerInput, ReviewerOutput } from "@otter/contracts";
import type { ToolSet } from "ai";
import { z } from "zod";
import {
  MAX_DESCRIPTION_CHARS,
  OUTPUT_RESERVE_TOKENS,
  REVIEW_MAX_CALLS,
  REVIEW_MAX_FINDINGS,
  REVIEW_MAX_INPUT_TOKENS,
  REVIEW_MIN_SCORE,
  LANGUAGES,
  RISKS,
} from "./constants.js";
import { chunkDiff, countTokens } from "./diff.js";
import { repoFileReader } from "./files.js";
import { runLinters } from "./linters.js";
import type { LlmProvider } from "./llm.js";
import { reviewSystemPrompt } from "./prompts/review.js";
import { repoTools } from "./tools.js";
import type { Chunk, Hint } from "./types.js";
import { filterByConfidence, verify } from "./verify.js";

// .otter.yaml comes from the PR's repo: validate it, never trust its shape.
const configSchema = z.object({
  language: z.enum(["en", "es"]).default("en"),
  ignore: z.array(z.string()).default([]),
  instructions: z
    .array(z.object({ path: z.string(), text: z.string() }))
    .default([]),
});

const reviewSchema = z.object({
  summary: z.string(),
  risk: z.enum(RISKS),
  findings: z.array(
    z.object({
      path: z.string(),
      startLine: z.number().int(),
      line: z.number().int(),
      severity: z.enum(["critical", "major", "minor", "nit"]),
      body: z.string(),
      suggestion: z.string().optional(),
    }),
  ),
});

export async function review(
  llm: LlmProvider,
  input: ReviewerInput,
  opts: { finalAttempt?: boolean; linters?: typeof runLinters } = {},
): Promise<ReviewerOutput> {
  const parsed = configSchema.safeParse(input.config ?? {});
  if (!parsed.success)
    throw new Error(`invalid .otter.yaml: ${z.prettifyError(parsed.error)}`);
  const config = parsed.data;
  const language = LANGUAGES[config.language];

  const header = `# Pull request\nTitle: ${input.title}\nDescription:\n${input.description.slice(0, MAX_DESCRIPTION_CHARS)}`;
  const reserved =
    countTokens(
      reviewSystemPrompt(REVIEW_MAX_FINDINGS, config.instructions, language) +
        header,
    ) + OUTPUT_RESERVE_TOKENS;
  const { chunks, filtered, deleted, notReviewed } = chunkDiff(input.diff, {
    maxTokens: REVIEW_MAX_INPUT_TOKENS - reserved,
    maxCalls: REVIEW_MAX_CALLS,
    ignore: config.ignore,
    readLines: input.repoDir ? repoFileReader(input.repoDir) : undefined,
  });
  const tools = input.repoDir ? repoTools(input.repoDir) : undefined;
  const hints = input.repoDir ? await (opts.linters ?? runLinters)(input.repoDir, input.diff) : [];
  const context = [
    deleted.length ? `## Deleted files\n${deleted.join("\n")}` : "",
    filtered.length ? `## Skipped by filter\n${filtered.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const out = await llm.generate({
        system: reviewSystemPrompt(
          REVIEW_MAX_FINDINGS,
          config.instructions.filter((i) =>
            chunk.paths.some((p) => matchesGlob(p, i.path)),
          ),
          language,
        ),
        prompt: `<untrusted>\n${header}\n\n${context}${renderHints(hints, chunk)}\n\n# Diff\n${chunk.text}\n</untrusted>`,
        schema: reviewSchema,
        tools,
      });
      const findings: Finding[] = out.findings
        .slice(0, REVIEW_MAX_FINDINGS)
        .map(({ startLine, ...f }) => ({
          ...f,
          side: "RIGHT",
          // A single line or a nonsense range (start after end) becomes a one-line finding.
          ...(startLine >= 1 && startLine < f.line ? { startLine } : {}),
        }));
      return {
        ...out,
        findings: await verifyChunk(
          llm,
          chunk,
          findings,
          opts.finalAttempt ?? true,
          tools,
        ),
      };
    }),
  );

  // Merge as PR-Agent's review_merge.py: union without duplicates, most conservative global verdict.
  const seen = new Set<string>();
  return {
    summary: results.map((r) => r.summary).join("\n\n"),
    risk: RISKS[Math.max(0, ...results.map((r) => RISKS.indexOf(r.risk)))],
    language: config.language,
    findings: results
      .flatMap((r) => r.findings)
      .filter((f) => {
        const key = `${f.path}:${f.line}:${f.body}`;
        return !seen.has(key) && seen.add(key);
      }),
    notReviewed,
    filtered,
    deleted,
  };
}

/** If the verifier fails on the last attempt, keep critical/major unverified (no confidence) and drop the rest. */
async function verifyChunk(
  llm: LlmProvider,
  chunk: Chunk,
  findings: Finding[],
  finalAttempt: boolean,
  tools: ToolSet | undefined,
): Promise<Finding[]> {
  if (!findings.length) return [];
  try {
    return filterByConfidence(
      await verify(llm, chunk.text, findings, tools),
      REVIEW_MIN_SCORE / 10,
    );
  } catch (err) {
    if (!finalAttempt) throw err; // let Graphile retry the job
    return findings.filter(
      (f) => f.severity === "critical" || f.severity === "major",
    );
  }
}

/** The chunk's linter hints, inside <untrusted>: rule descriptions can come from the repo's own config. */
function renderHints(hints: Hint[], chunk: Chunk): string {
  const mine = hints.filter((h) => chunk.paths.includes(h.path));
  if (!mine.length) return "";
  const lines = mine.map((h) => `- ${h.path}:${h.line} ${h.source} ${h.rule}: ${h.message}`);
  return `\n\n## Automated checks (hints: confirm before reporting)\n${lines.join("\n")}`;
}
