import type { Finding, ReviewerOutput, ReviewJob } from "@otter/contracts";
import {
  ALERT_BY_RISK,
  ALERT_BY_SEVERITY,
  SEVERITIES,
  type AlertType,
} from "./constants.js";
import { selectPublishable } from "./core.js";
import type { GitHubClient, ReviewComment } from "./ports.js";
import { getTranslation } from "./translations/index.js";

/** Only the label goes inside the alert: multi-line bodies and code blocks would need "> " on every line. */
const alert = (type: AlertType, text: string) => `> [!${type}]\n> ${text}`;

const fileList = (title: string, paths: string[]) =>
  paths.length
    ? `\n\n**${title}:**\n${paths.map((p) => `- \`${p}\``).join("\n")}`
    : "";

/** Review body: risk, LLM summary, findings count (or the "no issues" verdict) and what was left out. */
export function renderSummary(
  output: ReviewerOutput,
  published: Finding[],
): string {
  const t = (key: Parameters<typeof getTranslation>[0]) =>
    getTranslation(key, output.language);
  // Never promise "ready to merge" for files we did not review.
  const verdict = output.findings.length
    ? ""
    : `\n\n${
        output.notReviewed.length
          ? alert("NOTE", t("noIssuesInReviewed"))
          : alert("TIP", t("readyToMerge"))
      }`;
  const count = (s: Finding["severity"]) =>
    published.filter((f) => f.severity === s).length;
  const table = published.length
    ? `\n\n**${t("findings")}:**\n\n` +
      `| ${SEVERITIES.map((s) => t(`severity.${s}`)).join(" | ")} |\n` +
      `|${SEVERITIES.map(() => ":-:").join("|")}|\n` +
      `| ${SEVERITIES.map(count).join(" | ")} |`
    : "";
  return (
    `## ${t("title")}\n\n` +
    alert(ALERT_BY_RISK[output.risk], `**${t(`risk.${output.risk}`)}**`) +
    `\n\n${output.summary}${verdict}${table}` +
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
  const label = alert(
    ALERT_BY_SEVERITY[f.severity],
    `**${t(`severity.${f.severity}`)}**${tag}`,
  );
  const suggestion = f.suggestion
    ? `\n\n**${t("suggestion")}:**\n\`\`\`\n${f.suggestion}\n\`\`\``
    : "";
  return `${label}\n\n${f.body}${suggestion}`;
}

/** A finding as one of GitHub's inline comments (startLine only for a multi-line range). */
const toReviewComment = (f: Finding, language: ReviewerOutput["language"]): ReviewComment => ({
  path: f.path,
  startLine: f.startLine,
  line: f.line,
  side: f.side,
  body: renderComment(f, language),
});

/** The same finding as a section of the review body, with its location spelled out. */
const toBodySection = (f: Finding, language: ReviewerOutput["language"]) =>
  `---

\`${f.path}:${f.line}\`

${renderComment(f, language)}`;

/** GitHub answers 422 when an inline comment sits on a line it doesn't consider part of the diff. */
const isRejectedLine = (err: unknown) => (err as { status?: number }).status === 422;

/** selectPublishable() + gh.createReview(); returns the GitHub review id and what was published. */
export async function publishReview(
  gh: GitHubClient,
  job: ReviewJob,
  diff: string,
  output: ReviewerOutput,
  previous: Finding[],
): Promise<{ reviewId: number; published: Finding[] }> {
  const published = selectPublishable(output.findings, diff, previous);
  const summary = renderSummary(output, published);
  const comments = published.map((f) => toReviewComment(f, output.language));
  try {
    return { reviewId: await gh.createReview(job, summary, comments), published };
  } catch (err) {
    if (!isRejectedLine(err) || !comments.length) throw err;
    // Our local diff disagreed with GitHub's: post the findings in the body rather than lose the review.
    const body = [summary, ...published.map((f) => toBodySection(f, output.language))].join("\n\n");
    return { reviewId: await gh.createReview(job, body, []), published };
  }
}
