import type { Pool } from "pg";
import { reviewJobKey, TASKS, type CleanupJob } from "@otter/contracts";
import { withTransaction } from "../db/transaction.js";

const CLOSE_PULL_REQUEST_SQL = `
  UPDATE pull_requests pr
  SET state = 'closed'
  FROM repos r
  WHERE pr.repo_id = r.id AND r.owner = $1 AND r.name = $2 AND pr.number = $3`;

/** A review still waiting (e.g. in its push debounce) is pointless once the PR is closed. */
const REMOVE_PENDING_REVIEW_SQL = `SELECT graphile_worker.remove_job($1)`;

/** The job key makes a redelivered close event replace the pending cleanup instead of adding another. */
const ADD_CLEANUP_JOB_SQL = `
  SELECT graphile_worker.add_job($1, $2::json, job_key => $3)`;

/** Closing the PR, dropping its pending review and queueing its cleanup happen in ONE transaction. */
export async function enqueueCleanup(
  pool: Pool,
  job: Required<CleanupJob>,
): Promise<void> {
  await withTransaction(pool, async (tx) => {
    await tx.query(CLOSE_PULL_REQUEST_SQL, [job.owner, job.repo, job.number]);
    await tx.query(REMOVE_PENDING_REVIEW_SQL, [reviewJobKey(job)]);
    await tx.query(ADD_CLEANUP_JOB_SQL, [
      TASKS.cleanup,
      JSON.stringify(job),
      `cleanup:${job.owner}/${job.repo}#${job.number}`,
    ]);
  });
}
