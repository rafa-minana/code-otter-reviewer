import type { Pool } from "pg";
import { activeReviewSql, reviewJobKey } from "@otter/contracts";
import type { PullRequestRef } from "../queue/enqueue-rereview.js";
import { queuedJobSql } from "./jobs.js";

/** Jobs per task: waiting (incl. retries), running, and given up after their last attempt. */
const QUEUE_SQL = `
  SELECT j.task_identifier AS task,
    count(*) FILTER (WHERE ${queuedJobSql("j")})::int AS queued,
    count(*) FILTER (WHERE j.locked_at IS NOT NULL)::int AS running,
    count(*) FILTER (WHERE j.locked_at IS NULL AND NOT ${queuedJobSql("j")})::int AS failed
  FROM graphile_worker.jobs j
  GROUP BY j.task_identifier ORDER BY j.task_identifier`;

const ACTIVE_REVIEWS_SQL = `
  SELECT r.owner, r.name AS repo, pr.number, rv.sha, rv.started_at
  FROM reviews rv
  JOIN pull_requests pr ON pr.id = rv.pull_request_id
  JOIN repos r ON r.id = pr.repo_id
  WHERE ${activeReviewSql("rv")}
  ORDER BY rv.started_at`;

const PULL_REQUEST_SQL = `
  SELECT pr.id, pr.state, pr.last_reviewed_sha, pr.expires_at
  FROM pull_requests pr JOIN repos r ON r.id = pr.repo_id
  WHERE r.owner = $1 AND r.name = $2 AND pr.number = $3`;

/** Newest first; `active` tells a review in progress from an orphaned `running` row. */
const REVIEWS_SQL = `
  SELECT rv.id, rv.sha, rv.status, rv.error, rv.started_at, rv.finished_at,
    rv.github_review_id, ${activeReviewSql("rv")} AS active
  FROM reviews rv
  WHERE rv.pull_request_id = $1
  ORDER BY rv.started_at DESC`;

const PENDING_REVIEW_JOB_SQL = `
  SELECT j.run_at, j.attempts, j.max_attempts, j.last_error
  FROM graphile_worker.jobs j
  WHERE j.key = $1 AND ${queuedJobSql("j")}`;

export async function adminStatus(pool: Pool) {
  const [queue, reviews] = await Promise.all([
    pool.query(QUEUE_SQL),
    pool.query(ACTIVE_REVIEWS_SQL),
  ]);
  return { queue: queue.rows, activeReviews: reviews.rows };
}

/** The PR, its reviews and its queued review job; null if the PR is unknown. */
export async function pullRequestState(pool: Pool, ref: PullRequestRef) {
  const { rows } = await pool.query<{ id: string }>(PULL_REQUEST_SQL, [
    ref.owner,
    ref.repo,
    ref.number,
  ]);
  if (!rows[0]) return null;
  const { id, ...pr } = rows[0];
  const [reviews, job] = await Promise.all([
    pool.query(REVIEWS_SQL, [id]),
    pool.query(PENDING_REVIEW_JOB_SQL, [reviewJobKey(ref)]),
  ]);
  return {
    ...ref,
    ...pr,
    queuedReview: job.rows[0] ?? null,
    reviews: reviews.rows,
  };
}
