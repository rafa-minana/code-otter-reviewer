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
  const ready = renderSummary(output(), []);
  assert.match(ready, /Adds login\./);
  assert.match(ready, /> \[!TIP\]\n> No issues found\. This PR is ready to merge\./);

  const partial = renderSummary(
    output({ notReviewed: ["big.ts"], filtered: ["yarn.lock"] }),
    [],
  );
  assert.doesNotMatch(partial, /ready to merge/);
  assert.match(partial, /> \[!NOTE\]\n> No issues found in the reviewed files/);
  assert.match(partial, /Not reviewed.*\n- `big.ts`/);
  assert.match(partial, /Skipped by filter.*\n- `yarn.lock`/);

  assert.doesNotMatch(
    renderSummary(output({ findings: [finding(2)] }), [finding(2)]),
    /ready to merge|not reviewed/,
  );
});

test("renderSummary shows the risk as a GitHub alert coloured by level", () => {
  assert.match(renderSummary(output({ risk: "high" }), []), /> \[!CAUTION\]\n> \*\*Risk: high\*\*/);
  assert.match(renderSummary(output({ risk: "medium" }), []), /> \[!WARNING\]\n> \*\*Risk: medium\*\*/);
  assert.match(renderSummary(output({ risk: "low" }), []), /> \[!TIP\]\n> \*\*Risk: low\*\*/);
});

test("renderSummary counts the published findings by severity, and has no table without them", () => {
  const published = [
    { ...finding(1), severity: "critical" as const },
    finding(2),
    finding(3),
  ];
  assert.match(
    renderSummary(output({ findings: published }), published),
    /\*\*Findings:\*\*\n\n\| Critical \| Major \| Minor \| Nit \|\n\|:-:\|:-:\|:-:\|:-:\|\n\| 1 \| 2 \| 0 \| 0 \|/,
  );
  // Findings off the diff are not published, so they are not counted either.
  assert.doesNotMatch(renderSummary(output({ findings: [finding(99)] }), []), /Findings:/);
});

test("renderSummary and renderComment use the configured language", () => {
  assert.match(
    renderSummary(output({ language: "es", risk: "high" }), []),
    /Riesgo: alto[\s\S]*listo para mergear/,
  );
  assert.match(renderComment(finding(2), "es"), /^> \[!WARNING\]\n> \*\*Importante\*\*/);
});

test("renderComment: severity as a coloured alert, unverified tag, body and suggestion outside the alert", () => {
  assert.equal(
    renderComment({ ...finding(2), suggestion: "return null;" }, "en"),
    "> [!WARNING]\n> **Major**\n\nbug\n\n**Suggestion:**\n```\nreturn null;\n```",
  );
  assert.match(
    renderComment({ ...finding(2), severity: "critical", confidence: undefined }, "en"),
    /^> \[!CAUTION\]\n> \*\*Critical\*\* _\(unverified\)_\n\nbug$/,
  );
  assert.match(renderComment({ ...finding(2), severity: "minor" }, "en"), /^> \[!NOTE\]/);
  assert.match(renderComment({ ...finding(2), severity: "nit" }, "en"), /^> \[!TIP\]/);
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
  assert.match(calls[0].body, /\| 0 \| 2 \| 0 \| 0 \|/); // the off-diff finding is not counted
  assert.deepEqual(calls[0].comments, [
    { path: "a.ts", line: 2, side: "RIGHT", body: "> [!WARNING]\n> **Major**\n\nbug" },
    {
      path: "a.ts",
      startLine: 20,
      line: 22,
      side: "RIGHT",
      body: "> [!WARNING]\n> **Major**\n\nrange",
    },
  ]);
});
