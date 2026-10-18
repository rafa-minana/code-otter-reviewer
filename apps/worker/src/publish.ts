import type { Finding, ReviewerOutput, ReviewJob } from "@otter/contracts";
import { selectPublishable } from "./core.js";
import type { GitHubClient } from "./ports.js";
import { getTranslation } from "./translations/index.js";

const fileList = (title: string, paths: string[]) =>
  paths.length
    ? `\n\n**${title}:**\n${paths.map((p) => `- \`${p}\``).join("\n")}`
    : "";

/** Review body: risk + LLM summary, the "no issues" verdict when it applies, and what was left out. */
export function renderSummary(output: ReviewerOutput): string {
  const t = (key: Parameters<typeof getTranslation>[0]) =>
    getTranslation(key, output.language);
  // Never promise "ready to merge" for files we did not review.
  const verdict = output.findings.length
    ? ""
    : `\n\n${t(output.notReviewed.length ? "noIssuesInReviewed" : "readyToMerge")}`;
  return (
    `## ${t("title")}\n\n**${t(`risk.${output.risk}`)}**\n\n${output.summary}${verdict}` +
    fileList(t("notReviewed"), output.notReviewed) +
    fileList(t("filtered"), output.filtered) +
    fileList(t("deleted"), output.deleted)
  );
}

// shortcut: plain code block, not a committable ```suggestion (PR-Agent's /improve, off by default there);
// add it as an opt-in once the suggestion is checked to replace exactly startLine..line.
export function renderComment(
  f: Finding,
  language: ReviewerOutput["language"],
): string {
  const t = (key: Parameters<typeof getTranslation>[0]) =>
    getTranslation(key, language);
  const tag = f.confidence === undefined ? ` _(${t("unverified")})_` : "";
  const suggestion = f.suggestion
    ? `\n\n**${t("suggestion")}:**\n\`\`\`\n${f.suggestion}\n\`\`\``
    : "";
  return `**${t(`severity.${f.severity}`)}**${tag}\n\n${f.body}${suggestion}`;
}

/** selectPublishable() + gh.createReview(); returns the GitHub review id and what was published. */
export async function publishReview(
  gh: GitHubClient,
  job: ReviewJob,
  diff: string,
  output: ReviewerOutput,
  previous: Finding[],
): Promise<{ reviewId: number; published: Finding[] }> {
  const published = selectPublishable(output.findings, diff, previous);
  const comments = published.map((f) => ({
    path: f.path,
    ...(f.startLine !== undefined ? { startLine: f.startLine } : {}),
    line: f.line,
    side: f.side,
    body: renderComment(f, output.language),
  }));
  const reviewId = await gh.createReview(job, renderSummary(output), comments);
  return { reviewId, published };
}
