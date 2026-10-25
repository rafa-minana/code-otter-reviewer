/**
 * Review status state machine: one row of `reviews` is one processed review request (ARCHITECTURE.md §7).
 * The worker inserts `running` and finishes it; the api only cancels a finished one to re-review its SHA.
 * Every status UPDATE guards with `status = ANY(sourcesOf(to))`, so an illegal transition touches no row.
 */
export const REVIEW_STATUSES = ["running", "published", "stale", "failed", "cancelled"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** A running review is never cancelled: a re-review waits for it to finish. */
export const REVIEW_TRANSITIONS: Record<ReviewStatus, readonly ReviewStatus[]> = {
  running: ["published", "stale", "failed"],
  published: ["cancelled"],
  stale: ["cancelled"],
  failed: ["cancelled"],
  cancelled: [],
};

/** The statuses `to` can be reached from. */
export const sourcesOf = (to: ReviewStatus): ReviewStatus[] =>
  REVIEW_STATUSES.filter((from) => REVIEW_TRANSITIONS[from].includes(to));

/**
 * SQL condition: the review (table alias `alias`) is in progress, i.e. `running` and its Graphile job can
 * still run it (running now, or attempts left). A running row without such a job is an orphan (job deleted,
 * worker died for good) and blocks neither a re-review nor the janitor.
 */
export const activeReviewSql = (alias: string) => `(
  ${alias}.status = 'running' AND EXISTS (
    SELECT 1 FROM graphile_worker.jobs j
    WHERE j.id = ${alias}.job_id AND (j.locked_at IS NOT NULL OR j.attempts < j.max_attempts)))`;
