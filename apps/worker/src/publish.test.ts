import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewerOutput, ReviewJob } from "@otter/contracts";
import { DIFF, finding } from "./fixtures.js";
import type { GitHubClient, ReviewComment } from "./ports.js";
import { publishReview, renderComment, renderSummary } from "./publish.js";

const output = (o: Partial<ReviewerOutput> = {}): ReviewerOutput => ({
  summary: "Adds login.",
  risk: "medium",
  language: "en",
  findings: [],
  notReviewed: [],
  filtered: [],
  deleted: [],
  ...o,
});

test("renderSummary: ready to merge only when there are no findings and nothing was left out", () => {
  const ready = renderSummary(output());
  assert.match(ready, /Risk: medium/);
  assert.match(ready, /Adds login\./);
  assert.match(ready, /ready to merge/);

  const partial = renderSummary(
    output({ notReviewed: ["big.ts"], filtered: ["yarn.lock"] }),
  );
  assert.doesNotMatch(partial, /ready to merge/);
  assert.match(partial, /some files were not reviewed/);
  assert.match(partial, /Not reviewed.*\n- `big.ts`/);
  assert.match(partial, /Skipped by filter.*\n- `yarn.lock`/);

  assert.doesNotMatch(
    renderSummary(output({ findings: [finding(2)] })),
    /ready to merge|not reviewed/,
  );
});

test("renderSummary and renderComment use the configured language", () => {
  assert.match(
    renderSummary(output({ language: "es", risk: "high" })),
    /Riesgo: alto[\s\S]*listo para mergear/,
  );
  assert.match(renderComment(finding(2), "es"), /^\*\*Importante\*\*/);
});

test("renderComment marks unverified findings and adds the suggestion as a code block", () => {
  const verified = renderComment(
    { ...finding(2), suggestion: "return null;" },
    "en",
  );
  assert.equal(
    verified,
    "**Major**\n\nbug\n\n**Suggestion:**\n```\nreturn null;\n```",
  );
  assert.match(
    renderComment({ ...finding(2), confidence: undefined }, "en"),
    /^\*\*Major\*\* _\(unverified\)_/,
  );
});

test("publishReview posts ONE review with only the publishable findings", async () => {
  const calls: { body: string; comments: ReviewComment[] }[] = [];
  const gh = {
    createReview: async (
      _job: ReviewJob,
      body: string,
      comments: ReviewComment[],
    ) => {
      calls.push({ body, comments });
      return 123;
    },
  } as unknown as GitHubClient;
  const job = { installationId: 1, owner: "o", repo: "r", number: 1, sha: "s" };

  const { reviewId, published } = await publishReview(
    gh,
    job,
    DIFF,
    output({
      findings: [
        finding(2),
        finding(99),
        { ...finding(22, "range"), startLine: 20 },
      ],
    }),
    [],
  );
  assert.equal(reviewId, 123);
  assert.deepEqual(
    published.map((f) => f.line),
    [2, 22],
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].comments, [
    { path: "a.ts", line: 2, side: "RIGHT", body: "**Major**\n\nbug" },
    {
      path: "a.ts",
      startLine: 20,
      line: 22,
      side: "RIGHT",
      body: "**Major**\n\nrange",
    },
  ]);
});
