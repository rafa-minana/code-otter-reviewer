import { existsSync } from "node:fs";
import { activeReviewSql } from "@otter/contracts";
import type { JobHelpers } from "graphile-worker";
import { cleanupPr, cleanupRepo } from "./cleanup.js";
import { inTransaction } from "./db/transaction.js";
import { withRepoLock } from "./git/lock.js";
import { mirrorPath } from "./git/mirror.js";
import { git, type GitEnv } from "./git/run.js";

// Every webhook refreshes pull_requests.expires_at (5 days) and repos.last_used_at, so a queued
// review always keeps its PR and repo fresh: only a review in progress needs guarding here.

const EXPIRED_PRS_SQL = `
  SELECT pr.id, r.owner, r.name AS repo, pr.number
  FROM pull_requests pr JOIN repos r ON r.id = pr.repo_id
  WHERE pr.expires_at < now()`;

/** Re-checked inside the repo lock: a webhook may have refreshed it since the SELECT. */
const DELETE_EXPIRED_PR_SQL = `
  DELETE FROM pull_requests pr
  WHERE pr.id = $1 AND pr.expires_at < now()
    AND NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv.pull_request_id = pr.id AND ${activeReviewSql("rv")})`;

const IDLE_REPOS_SQL = `
  SELECT id, owner, name AS repo FROM repos
  WHERE last_used_at < now() - make_interval(days => $1)`;

const DELETE_IDLE_REPO_SQL = `
  DELETE FROM repos r
  WHERE r.id = $1 AND r.last_used_at < now() - make_interval(days => $2)
    AND NOT EXISTS (
      SELECT 1 FROM reviews rv JOIN pull_requests pr ON pr.id = rv.pull_request_id
      WHERE pr.repo_id = r.id AND ${activeReviewSql("rv")})`;

const REPOS_SQL = `SELECT owner, name AS repo FROM repos`;

interface Row {
  id: string;
  owner: string;
  repo: string;
}

/**
 * Periodic job (and POST /admin/gc): drops PRs idle for 5 days and repos idle for KEEP_REPO_IDLE_TIME
 * days, files and rows, then compacts the remaining mirrors. One failing item never stops the rest.
 */
export async function janitorHandler(
  deps: { git: GitEnv; repoIdleDays: number },
  helpers: JobHelpers,
): Promise<void> {
  const { git: env, repoIdleDays } = deps;
  const query = <T extends object>(sql: string, params: unknown[] = []) =>
    helpers.withPgClient(async (pg) => (await pg.query<T>(sql, params)).rows);

  /** Deletes the row (guarded) and removes the files in one transaction, under the repo lock. */
  const drop = (row: Row, sql: string, params: unknown[], files: () => Promise<void>) =>
    withRepoLock(helpers, row.owner, row.repo, () =>
      helpers.withPgClient((pg) =>
        inTransaction(pg, async () => {
          const { rowCount } = await pg.query(sql, [row.id, ...params]);
          if (rowCount) await files(); // a git failure rolls the row back, so the next run retries
          return Boolean(rowCount);
        }),
      ),
    );

  const each = async <T extends { owner: string; repo: string }>(
    rows: T[],
    what: string,
    work: (row: T) => Promise<boolean>,
  ) => {
    let done = 0;
    for (const row of rows) {
      try {
        if (await work(row)) done++;
      } catch (err) {
        helpers.logger.error(`janitor: ${what} ${row.owner}/${row.repo} failed: ${(err as Error).message}`);
      }
    }
    return done;
  };

  const prs = await each(
    await query<Row & { number: number }>(EXPIRED_PRS_SQL),
    "PR cleanup of",
    (pr) => drop(pr, DELETE_EXPIRED_PR_SQL, [], () => cleanupPr(env, pr.owner, pr.repo, pr.number)),
  );
  const repos = await each(
    await query<Row>(IDLE_REPOS_SQL, [repoIdleDays]),
    "repo cleanup of",
    (r) => drop(r, DELETE_IDLE_REPO_SQL, [repoIdleDays], () => cleanupRepo(env, r.owner, r.repo)),
  );
  // Fetch packs, lazily fetched blobs and objects of cleaned PRs pile up in live mirrors.
  // --prune=now is safe under the lock: nothing else touches the mirror, and gc keeps worktree HEADs.
  const mirrors = await each(
    (await query<{ owner: string; repo: string }>(REPOS_SQL)).filter((r) =>
      existsSync(mirrorPath(env, r.owner, r.repo)),
    ),
    "gc of",
    (r) =>
      withRepoLock(helpers, r.owner, r.repo, async () => {
        await git(["gc", "--prune=now", "--quiet"], { cwd: mirrorPath(env, r.owner, r.repo) });
        return true;
      }),
  );
  helpers.logger.info(`janitor: removed ${prs} PRs and ${repos} repos, compacted ${mirrors} mirrors`);
}
