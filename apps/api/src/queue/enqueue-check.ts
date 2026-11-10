import type { PoolClient } from "pg";
import {
  CHECK_MAX_ATTEMPTS,
  checkQueueName,
  TASKS,
  type CheckJob,
  type CheckState,
  type ReviewJob,
} from "@otter/contracts";

type PullRequest = Pick<ReviewJob, "installationId" | "owner" | "repo" | "number">;

/** The PR's named queue runs its check jobs in order: "queued" never lands after "published". */
const ADD_CHECK_JOB_SQL = `
  SELECT graphile_worker.add_job($1, $2::json, queue_name => $3, max_attempts => $4)`;

/** The review of (PR, SHA), cancelled ones aside: at most one (reviews_one_per_sha). */
const REVIEW_STATUS_SQL = `
  SELECT status FROM reviews WHERE pull_request_id = $1 AND sha = $2 AND status <> 'cancelled'`;

/** Queues a state change of the check run on `sha`, in the caller's transaction. */
export async function enqueueCheck(tx: PoolClient, pr: PullRequest, sha: string, check: CheckState): Promise<void> {
  const { installationId, owner, repo, number } = pr;
  const job: CheckJob = { installationId, owner, repo, number, sha, ...check };
  await tx.query(ADD_CHECK_JOB_SQL, [TASKS.checks, JSON.stringify(job), checkQueueName(job), CHECK_MAX_ATTEMPTS]);
}

/** "Queued", unless the SHA's review already started or finished (a redelivered event, a reopened PR). */
export async function markQueued(tx: PoolClient, pr: PullRequest, pullRequestId: string, sha: string) {
  if ((await reviewStatus(tx, pullRequestId, sha)) === undefined) await enqueueCheck(tx, pr, sha, { state: "queued" });
}

/** Skipped (a newer push, a closed PR), unless its review finished: a "published" stays. */
export async function markSkipped(
  tx: PoolClient,
  pr: PullRequest,
  pullRequestId: string,
  sha: string,
  state: "superseded" | "closed",
) {
  const status = await reviewStatus(tx, pullRequestId, sha);
  if (status === undefined || status === "running") await enqueueCheck(tx, pr, sha, { state });
}

/** Undefined while none has started (still queued, or never). */
async function reviewStatus(tx: PoolClient, pullRequestId: string, sha: string): Promise<string | undefined> {
  const { rows } = await tx.query<{ status: string }>(REVIEW_STATUS_SQL, [pullRequestId, sha]);
  return rows[0]?.status;
}
