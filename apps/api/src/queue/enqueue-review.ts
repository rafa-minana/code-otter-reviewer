import type { Pool, PoolClient } from "pg";
import { reviewJobKey, TASKS, type ReviewJob } from "@otter/contracts";
import { withTransaction } from "../db/transaction.js";

/** A PR without activity for this long is cleaned up by the janitor. */
const PR_INACTIVITY_TTL = "5 days";

/** Each attempt repeats every LLM call: enough for a transient 429/timeout, bounded in cost. */
const REVIEW_MAX_ATTEMPTS = 3;

const UPSERT_REPO_SQL = `
  INSERT INTO repos (owner, name, installation_id)
  VALUES ($1, $2, $3)
  ON CONFLICT (owner, name) DO UPDATE
    SET installation_id = EXCLUDED.installation_id,
        last_used_at    = now()
  RETURNING id`;

const UPSERT_PULL_REQUEST_SQL = `
  INSERT INTO pull_requests (repo_id, number, expires_at)
  VALUES ($1, $2, now() + $3::interval)
  ON CONFLICT (repo_id, number) DO UPDATE
    SET state      = 'open',
        expires_at = EXCLUDED.expires_at`;

/** job_key_mode 'replace': a newer push swaps the pending job and restarts the debounce. */
const ADD_JOB_SQL = `
  SELECT graphile_worker.add_job(
    $1,
    $2::json,
    run_at       => now() + make_interval(secs => $3),
    job_key      => $4,
    job_key_mode => 'replace',
    max_attempts => $5
  )`;

/** PR state and its review job are written in ONE transaction (ARCHITECTURE.md §3). */
export async function enqueueReview(pool: Pool, job: ReviewJob, delaySeconds: number): Promise<void> {
  await withTransaction(pool, async (tx) => {
    const repoId = await upsertRepo(tx, job);
    await tx.query(UPSERT_PULL_REQUEST_SQL, [repoId, job.number, PR_INACTIVITY_TTL]);
    await tx.query(ADD_JOB_SQL, [TASKS.review, JSON.stringify(job), delaySeconds, reviewJobKey(job), REVIEW_MAX_ATTEMPTS]);
  });
}

async function upsertRepo(tx: PoolClient, job: ReviewJob): Promise<number> {
  const { rows } = await tx.query<{ id: number }>(UPSERT_REPO_SQL, [job.owner, job.repo, job.installationId]);
  return rows[0].id;
}
