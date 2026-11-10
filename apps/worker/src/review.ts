import {
  reviewJobKey,
  sourcesOf,
  TASKS,
  type Finding,
  type ReviewJob,
} from "@otter/contracts";
import type { JobHelpers } from "graphile-worker";
import { parse as parseYaml } from "yaml";
import {
  findingKey,
  isStale,
  nextStep,
  parseReviewerOutput,
  type Wait,
} from "./core.js";
import { inTransaction } from "./db/transaction.js";
import { prDiff } from "./git/diff.js";
import { withRepoLock } from "./git/lock.js";
import { ensureMirror, fetchPr } from "./git/mirror.js";
import type { GitEnv } from "./git/run.js";
import { assertStorage, isDiskFull } from "./git/storage.js";
import { addWorktree } from "./git/worktree.js";
import type { ContainerRunner, GitHubClient } from "./ports.js";
import { publishReview } from "./publish.js";
import { ReviewerError } from "./runner.js";

const CONFIG_PATH = ".otter.yaml";

/**
 * A postponed job whose payload a newer push replaced (same job, new SHA) leaves its old SHA's row
 * running: it is stale now.
 */
const SUPERSEDED_REVIEWS_SQL = `
  UPDATE reviews rv SET status = 'stale', finished_at = now()
  FROM pull_requests pr JOIN repos r ON r.id = pr.repo_id
  WHERE rv.pull_request_id = pr.id AND r.owner = $1 AND r.name = $2 AND pr.number = $3
    AND rv.job_id = $5 AND rv.sha <> $4 AND rv.status = ANY($6::text[])`;

/**
 * Each (PR, SHA) is reviewed once (unique among non-cancelled rows). Only a retry of the job that
 * claimed the row claims it again; a finished row, or one running under another job, returns no row
 * and the job is skipped.
 */
const CLAIM_REVIEW_SQL = `
  INSERT INTO reviews (pull_request_id, sha, job_id)
  SELECT pr.id, $4, $5
  FROM pull_requests pr JOIN repos r ON r.id = pr.repo_id
  WHERE r.owner = $1 AND r.name = $2 AND pr.number = $3
  ON CONFLICT (pull_request_id, sha) WHERE status <> 'cancelled' DO UPDATE
    SET started_at = now()
    WHERE reviews.status = 'running' AND reviews.job_id = EXCLUDED.job_id
  RETURNING id`;

/**
 * Taken before deferring: enqueueReview (api) locks the same row, so a push in between is never lost.
 * No row when the PR was closed or its repo deleted meanwhile: nothing left to review.
 */
const LOCK_PULL_REQUEST_SQL = `
  SELECT pr.id FROM pull_requests pr JOIN repos r ON r.id = pr.repo_id
  WHERE r.owner = $1 AND r.name = $2 AND pr.number = $3 AND pr.state = 'open'
  FOR UPDATE OF pr`;

/**
 * Another job holds the PR's key: a newer push took it from this one, queued or already running
 * (with WORKER_CONCURRENCY > 1). Deferring now would take the key back and strip that job's retries.
 */
const NEWER_REVIEW_SQL = `
  SELECT 1 FROM graphile_worker.jobs WHERE key = $1 AND id <> $2`;

/**
 * The running job holds the key: Graphile clears it from this job and creates a new one.
 * Graphile runs ready jobs by run_at alone, so reviews waiting for the same moment (a quota reset)
 * wake on the same whole minute, shifted 1 µs earlier per second they have been queued: first in, first out.
 */
const DEFER_JOB_SQL = `
  WITH wake AS (
    SELECT date_trunc('minute', now() + make_interval(secs => $3)) + interval '1 minute' AS at
  )
  SELECT (graphile_worker.add_job(
    $1, $2::json,
    run_at       => at - (at - $6::timestamptz) / 1000000,
    job_key      => $4,
    max_attempts => $5
  )).id
  FROM wake`;

/** The row stays running and moves to the new job, which claims it when it runs. */
const HAND_OVER_REVIEW_SQL = `
  UPDATE reviews SET job_id = $2 WHERE id = $1 AND status = 'running'`;

/** One statement, so the review result, its findings and the PR's last SHA are saved atomically. */
const FINISH_REVIEW_SQL = `
  WITH done AS (
    UPDATE reviews
    SET finished_at = now(), status = $2::text, github_review_id = $3, error = $5
    WHERE id = $1 AND status = ANY($6::text[])
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
  deps: {
    gh: GitHubClient;
    runner: ContainerRunner;
    git: GitEnv;
    maxStorageBytes: number;
  },
  job: ReviewJob,
  helpers: JobHelpers,
): Promise<void> {
  const { gh, runner } = deps;
  const reviewId = await helpers.withPgClient(async (pg) => {
    const params = [job.owner, job.repo, job.number, job.sha, helpers.job.id];
    await pg.query(SUPERSEDED_REVIEWS_SQL, [...params, sourcesOf("stale")]);
    return (await pg.query<{ id: string }>(CLAIM_REVIEW_SQL, params)).rows[0]
      ?.id;
  });
  if (!reviewId) {
    helpers.logger.info(
      `skip ${job.owner}/${job.repo}#${job.number}@${job.sha}: already reviewed, running under another job, or PR unknown`,
    );
    return;
  }
  const finish = async (
    result: Result,
    {
      githubReviewId = null,
      findings = [],
      error = null,
    }: {
      githubReviewId?: number | null;
      findings?: (Finding & { published: boolean })[];
      error?: string | null;
    } = {},
  ) => {
    await helpers.withPgClient((pg) =>
      pg.query(FINISH_REVIEW_SQL, [
        reviewId,
        result,
        githubReviewId,
        JSON.stringify(findings),
        error,
        sourcesOf(result),
      ]),
    );
  };
  const fail = (error: string) => finish("failed", { error });
  const finalAttempt = helpers.job.attempts >= helpers.job.max_attempts;

  try {
    await assertStorage(deps.git.dataDir, deps.maxStorageBytes);
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
    await finish("published", {
      githubReviewId,
      findings: output.findings.map((f) => ({
        ...f,
        published: isPublished.has(findingKey(f)),
      })),
    });
  } catch (err) {
    const error = (err as Error).message;
    const target = `${job.owner}/${job.repo}#${job.number}@${job.sha}`;
    const reviewer = err instanceof ReviewerError ? err : undefined;
    const step = nextStep({
      diskFull: isDiskFull(err),
      exitCode: reviewer?.exitCode,
      retryAfterSeconds: reviewer?.retryAfterSeconds,
    });
    if (step.kind === "fail") {
      await fail(error); // no Graphile retries
      helpers.logger.error(`abort ${target}: ${error}`);
      return;
    }
    if (step.kind === "defer") {
      const { why, wait, seconds } = step;
      const outcome = await defer(helpers, job, reviewId, wait, seconds);
      if (outcome === "superseded") await finish("stale");
      else if (outcome === "gave_up") await fail(`LLM ${why}: gave up after waiting ${wait.max} times: ${error}`);
      helpers.logger.warn(
        `LLM ${why} for ${target}: ${outcome === "deferred" ? `retry in ${Math.round(seconds / 60)} min` : outcome}`,
      );
      return;
    }
    if (finalAttempt) await fail(error); // Graphile gives up after this attempt: record it
    throw err;
  }
}

/**
 * The LLM can't take the review now (saturated, or out of quota): queue the same review `seconds`
 * later instead of burning Graphile's quick retries. The row stays running and is handed to the new job.
 */
async function defer(
  helpers: JobHelpers,
  job: ReviewJob,
  reviewId: string,
  wait: Wait,
  seconds: number,
): Promise<"deferred" | "superseded" | "gave_up"> {
  const waited = job[wait.counter] ?? 0;
  return helpers.withPgClient((pg) =>
    inTransaction(pg, async () => {
      const open = await pg.query(LOCK_PULL_REQUEST_SQL, [job.owner, job.repo, job.number]);
      const key = reviewJobKey(job);
      if (!open.rowCount || (await pg.query(NEWER_REVIEW_SQL, [key, helpers.job.id])).rowCount)
        return "superseded";
      if (waited >= wait.max) return "gave_up";
      const queuedAt = job.queuedAt ?? new Date(helpers.job.created_at).toISOString();
      const { rows } = await pg.query<{ id: string }>(DEFER_JOB_SQL, [
        TASKS.review,
        JSON.stringify({ ...job, [wait.counter]: waited + 1, queuedAt }),
        seconds,
        key,
        helpers.job.max_attempts,
        queuedAt,
      ]);
      await pg.query(HAND_OVER_REVIEW_SQL, [reviewId, rows[0].id]);
      return "deferred";
    }),
  );
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
