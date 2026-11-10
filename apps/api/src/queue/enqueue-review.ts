import type { Pool, PoolClient } from "pg";
import { reviewJobKey, TASKS, type ReviewJob } from "@otter/contracts";
import { withTransaction } from "../db/transaction.js";
import { markQueued, markSkipped } from "./enqueue-check.js";

/** A PR without activity for this long is cleaned up by the janitor. */
const PR_INACTIVITY_TTL = "5 days";

/** Each attempt repeats every LLM call: enough for a transient 429/timeout, bounded in cost. */
export const REVIEW_MAX_ATTEMPTS = 3;

const UPSERT_REPO_SQL = `
  INSERT INTO repos (owner, name, installation_id)
  VALUES ($1, $2, $3)
  ON CONFLICT (owner, name) DO UPDATE
    SET installation_id = EXCLUDED.installation_id,
        last_used_at    = now()
  RETURNING id`;

/** The SHA queued before this push, locked so two pushes at once each see the other's. */
const PREVIOUS_HEAD_SQL = `
  SELECT head_sha FROM pull_requests WHERE repo_id = $1 AND number = $2 FOR UPDATE`;

const UPSERT_PULL_REQUEST_SQL = `
  INSERT INTO pull_requests (repo_id, number, expires_at, head_sha)
  VALUES ($1, $2, now() + $3::interval, $4)
  ON CONFLICT (repo_id, number) DO UPDATE
    SET state      = 'open',
        expires_at = EXCLUDED.expires_at,
        head_sha   = EXCLUDED.head_sha
  RETURNING id`;

/** job_key_mode 'replace': a newer push swaps the pending job and restarts the debounce. */
export const ADD_JOB_SQL = `
  SELECT graphile_worker.add_job(
    $1,
    $2::json,
    run_at       => now() + make_interval(secs => $3),
    job_key      => $4,
    job_key_mode => 'replace',
    max_attempts => $5
  )`;

/** PR state, its review job and its check run's state are written in ONE transaction (ARCHITECTURE.md §3). */
export async function enqueueReview(pool: Pool, job: ReviewJob, delaySeconds: number): Promise<void> {
  await withTransaction(pool, async (tx) => {
    const repoId = await upsertRepo(tx, job);
    const previous = (await tx.query<{ head_sha: string | null }>(PREVIOUS_HEAD_SQL, [repoId, job.number])).rows[0]
      ?.head_sha;
    const { rows } = await tx.query<{ id: string }>(UPSERT_PULL_REQUEST_SQL, [
      repoId,
      job.number,
      PR_INACTIVITY_TTL,
      job.sha,
    ]);
    const { id } = rows[0];
    await tx.query(ADD_JOB_SQL, [TASKS.review, JSON.stringify(job), delaySeconds, reviewJobKey(job), REVIEW_MAX_ATTEMPTS]);
    if (previous && previous !== job.sha) await markSkipped(tx, job, id, previous, "superseded");
    await markQueued(tx, job, id, job.sha);
  });
}

async function upsertRepo(tx: PoolClient, job: ReviewJob): Promise<number> {
  const { rows } = await tx.query<{ id: number }>(UPSERT_REPO_SQL, [job.owner, job.repo, job.installationId]);
  return rows[0].id;
}
