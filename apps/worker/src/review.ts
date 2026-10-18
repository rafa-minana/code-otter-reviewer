import type { Finding, ReviewJob } from "@otter/contracts";
import { review } from "@otter/reviewer/agent.js";
import type { LlmProvider } from "@otter/reviewer/llm.js";
import type { JobHelpers } from "graphile-worker";
import { parse as parseYaml } from "yaml";
import { findingKey, isStale } from "./core.js";
import type { GitHubClient } from "./ports.js";
import { publishReview } from "./publish.js";

const CONFIG_PATH = ".otter.yaml";

/**
 * Each (PR, SHA) is reviewed once (UNIQUE in `reviews`). A row left unfinished by a crashed attempt
 * is claimed again; a finished one returns no row and the job is skipped.
 */
const CLAIM_REVIEW_SQL = `
  INSERT INTO reviews (pull_request_id, sha)
  SELECT pr.id, $4
  FROM pull_requests pr JOIN repos r ON r.id = pr.repo_id
  WHERE r.owner = $1 AND r.name = $2 AND pr.number = $3
  ON CONFLICT (pull_request_id, sha) DO UPDATE
    SET started_at = now()
    WHERE reviews.finished_at IS NULL
  RETURNING id`;

/** One statement, so the review result, its findings and the PR's last SHA are saved atomically. */
const FINISH_REVIEW_SQL = `
  WITH done AS (
    UPDATE reviews
    SET finished_at = now(), result = $2::text, github_review_id = $3
    WHERE id = $1
    RETURNING pull_request_id, sha
  ), saved AS (
    INSERT INTO findings (review_id, path, line, side, severity, body, published)
    SELECT $1, f.path, f.line, f.side, f.severity, f.body, f.published
    FROM jsonb_to_recordset($4::jsonb)
      AS f(path text, line int, side text, severity text, body text, published boolean)
  )
  UPDATE pull_requests SET last_reviewed_sha = done.sha
  FROM done
  WHERE pull_requests.id = done.pull_request_id AND $2::text = 'published'`;

type Result = "published" | "stale" | "failed";

/**
 * Review job handler: the only place that orchestrates (ARCHITECTURE.md §1).
 * v0: no container; the engine runs in-process over the diff from the GitHub API.
 */
export async function handleReview(
  deps: { gh: GitHubClient; llm: LlmProvider },
  job: ReviewJob,
  helpers: JobHelpers,
): Promise<void> {
  const { gh, llm } = deps;
  const reviewId = await helpers.withPgClient(
    async (pg) => (await pg.query<{ id: string }>(CLAIM_REVIEW_SQL, [job.owner, job.repo, job.number, job.sha])).rows[0]?.id,
  );
  if (!reviewId) {
    helpers.logger.info(`skip ${job.owner}/${job.repo}#${job.number}@${job.sha}: already reviewed or PR unknown`);
    return;
  }
  const finish = async (result: Result, githubReviewId: number | null = null, findings: (Finding & { published: boolean })[] = []) => {
    await helpers.withPgClient((pg) =>
      pg.query(FINISH_REVIEW_SQL, [reviewId, result, githubReviewId, JSON.stringify(findings)]),
    );
  };
  const finalAttempt = helpers.job.attempts >= helpers.job.max_attempts;

  try {
    const pr = await gh.getPullRequest(job);
    if (isStale(job.sha, pr.headSha)) return await finish("stale"); // a newer job is queued

    // Config from the base branch: a PR must not be able to change its own review.
    const [diff, rawConfig] = await Promise.all([gh.getDiff(job), gh.getFile(job, CONFIG_PATH, pr.baseRef)]);
    const output = await review(
      llm,
      { title: pr.title, description: pr.body, diff, config: parseConfig(rawConfig), previousFindings: [] },
      { finalAttempt },
    );

    if (isStale(job.sha, (await gh.getPullRequest(job)).headSha)) return await finish("stale");

    const { reviewId: githubReviewId, published } = await publishReview(gh, job, diff, output, []);
    const isPublished = new Set(published.map(findingKey));
    await finish(
      "published",
      githubReviewId,
      output.findings.map((f) => ({ ...f, published: isPublished.has(findingKey(f)) })),
    );
  } catch (err) {
    if (finalAttempt) await finish("failed"); // Graphile gives up after this attempt: record it
    throw err;
  }
}

function parseConfig(raw: string | null): unknown {
  if (raw === null) return {};
  try {
    return parseYaml(raw) ?? {};
  } catch (err) {
    throw new Error(`invalid ${CONFIG_PATH}: ${(err as Error).message}`);
  }
}
