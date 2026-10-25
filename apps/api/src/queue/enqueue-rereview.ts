import type { Pool } from "pg";
import {
  activeReviewSql,
  reviewJobKey,
  sourcesOf,
  TASKS,
  type ReviewJob,
} from "@otter/contracts";
import { withTransaction } from "../db/transaction.js";
import { ADD_JOB_SQL, REVIEW_MAX_ATTEMPTS } from "./enqueue-review.js";

export type PullRequestRef = Pick<ReviewJob, "owner" | "repo" | "number">;

export type RereviewOutcome =
  | "queued"
  | "unknown"
  | "closed"
  | "already_queued"
  | "in_progress"
  | "never_reviewed";

/** The PR's latest review; FOR UPDATE serialises two re-reviews of the same PR. */
const LATEST_REVIEW_SQL = `
  SELECT pr.state, r.installation_id, rv.id AS review_id, rv.sha,
    coalesce(${activeReviewSql("rv")}, false) AS active,
    EXISTS (
      SELECT 1 FROM graphile_worker.jobs j
      WHERE j.key = $4 AND j.locked_at IS NULL AND j.attempts < j.max_attempts) AS queued
  FROM repos r
  JOIN pull_requests pr ON pr.repo_id = r.id
  LEFT JOIN LATERAL (
    SELECT * FROM reviews
    WHERE pull_request_id = pr.id AND status <> 'cancelled'
    ORDER BY started_at DESC LIMIT 1) rv ON true
  WHERE r.owner = $1 AND r.name = $2 AND pr.number = $3
  FOR UPDATE OF pr`;

/** A running row whose job is gone (e.g. the PR closed between retries) never finishes: record it as failed. */
const FAIL_ORPHAN_SQL = `
  UPDATE reviews rv SET status = 'failed', finished_at = now(), error = 'orphaned: its job is gone'
  WHERE rv.id = $1 AND rv.status = ANY($2::text[]) AND NOT ${activeReviewSql("rv")}`;

const CANCEL_REVIEW_SQL = `
  UPDATE reviews SET status = 'cancelled' WHERE id = $1 AND status = ANY($2::text[])`;

interface LatestReview {
  state: string;
  installation_id: string;
  review_id: string | null;
  sha: string | null;
  active: boolean;
  queued: boolean;
}

/**
 * Forced re-review of the PR's last reviewed SHA: its review is cancelled (it stays as history) and the
 * SHA is queued again, in ONE transaction. A review in progress or already queued is left alone.
 */
export async function enqueueRereview(
  pool: Pool,
  pr: PullRequestRef,
): Promise<RereviewOutcome> {
  return withTransaction(pool, async (tx): Promise<RereviewOutcome> => {
    const key = reviewJobKey(pr);
    const { rows } = await tx.query<LatestReview>(LATEST_REVIEW_SQL, [
      pr.owner,
      pr.repo,
      pr.number,
      key,
    ]);
    const latest = rows[0];
    if (!latest) return "unknown";
    if (latest.state === "closed") return "closed";
    if (latest.queued) return "already_queued";
    if (latest.active) return "in_progress";
    if (!latest.review_id || !latest.sha) return "never_reviewed";

    await tx.query(FAIL_ORPHAN_SQL, [latest.review_id, sourcesOf("failed")]);
    await tx.query(CANCEL_REVIEW_SQL, [
      latest.review_id,
      sourcesOf("cancelled"),
    ]);
    const job: ReviewJob = {
      installationId: Number(latest.installation_id),
      ...pr,
      sha: latest.sha,
    };
    await tx.query(ADD_JOB_SQL, [
      TASKS.review,
      JSON.stringify(job),
      0,
      key,
      REVIEW_MAX_ATTEMPTS,
    ]);
    return "queued";
  });
}
