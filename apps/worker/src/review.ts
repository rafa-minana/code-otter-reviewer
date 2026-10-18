import type { Finding, ReviewJob } from "@otter/contracts";
import type { JobHelpers } from "graphile-worker";
import { parse as parseYaml } from "yaml";
import { findingKey, isStale, parseReviewerOutput } from "./core.js";
import { prDiff } from "./git/diff.js";
import { withRepoLock } from "./git/lock.js";
import { ensureMirror, fetchPr } from "./git/mirror.js";
import type { GitEnv } from "./git/run.js";
import { addWorktree } from "./git/worktree.js";
import type { ContainerRunner, GitHubClient } from "./ports.js";
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
 * The review itself runs in the reviewer container (runner.ts), never in this process.
 */
export async function handleReview(
  deps: { gh: GitHubClient; runner: ContainerRunner; git: GitEnv },
  job: ReviewJob,
  helpers: JobHelpers,
): Promise<void> {
  const { gh, runner } = deps;
  const reviewId = await helpers.withPgClient(
    async (pg) =>
      (
        await pg.query<{ id: string }>(CLAIM_REVIEW_SQL, [
          job.owner,
          job.repo,
          job.number,
          job.sha,
        ])
      ).rows[0]?.id,
  );
  if (!reviewId) {
    helpers.logger.info(
      `skip ${job.owner}/${job.repo}#${job.number}@${job.sha}: already reviewed or PR unknown`,
    );
    return;
  }
  const finish = async (
    result: Result,
    githubReviewId: number | null = null,
    findings: (Finding & { published: boolean })[] = [],
  ) => {
    await helpers.withPgClient((pg) =>
      pg.query(FINISH_REVIEW_SQL, [
        reviewId,
        result,
        githubReviewId,
        JSON.stringify(findings),
      ]),
    );
  };
  const finalAttempt = helpers.job.attempts >= helpers.job.max_attempts;

  try {
    const pr = await gh.getPullRequest(job);
    if (isStale(job.sha, pr.headSha)) return await finish("stale"); // a newer job is queued

    // Config from the base branch: a PR must not be able to change its own review.
    const rawConfig = await gh.getFile(job, CONFIG_PATH, pr.baseRef);
    const { worktree, diff } = await checkout(
      deps.git,
      job,
      pr.baseRef,
      await gh.installationToken(job),
      helpers,
    );
    const input = {
      title: pr.title,
      description: pr.body,
      diff,
      config: parseConfig(rawConfig),
      previousFindings: [],
    };
    const output = parseReviewerOutput(
      await runner.runReviewer({ input, finalAttempt }, worktree, reviewId),
    );

    if (isStale(job.sha, (await gh.getPullRequest(job)).headSha))
      return await finish("stale");

    const { reviewId: githubReviewId, published } = await publishReview(
      gh,
      job,
      diff,
      output,
      [],
    );
    const isPublished = new Set(published.map(findingKey));
    await finish(
      "published",
      githubReviewId,
      output.findings.map((f) => ({
        ...f,
        published: isPublished.has(findingKey(f)),
      })),
    );
  } catch (err) {
    if (finalAttempt) await finish("failed"); // Graphile gives up after this attempt: record it
    throw err;
  }
}

/** Mirror → fetch → worktree → diff, under the repo lock. The LLM runs outside it. */
function checkout(
  env: GitEnv,
  job: ReviewJob,
  baseRef: string,
  token: string,
  helpers: JobHelpers,
) {
  const { owner, repo, number, sha } = job;
  return withRepoLock(helpers, owner, repo, async () => {
    await ensureMirror(env, owner, repo, token);
    await fetchPr(env, owner, repo, number, baseRef, token);
    const worktree = await addWorktree(env, owner, repo, number, sha, token);
    // Unextended (3 lines of context, like GitHub's): it also decides which lines are commentable.
    const diff = await prDiff(env, owner, repo, baseRef, sha, token);
    return { worktree, diff };
  });
}

function parseConfig(raw: string | null): unknown {
  if (raw === null) return {};
  try {
    return parseYaml(raw) ?? {};
  } catch (err) {
    throw new Error(`invalid ${CONFIG_PATH}: ${(err as Error).message}`);
  }
}
