import type { JobHelpers } from "graphile-worker";

/**
 * Serialises git work on one repo's mirror across workers (clone, fetch, worktrees).
 * A session-level advisory lock, held on the job's own Postgres connection.
 */
export function withRepoLock<T>(
  helpers: JobHelpers,
  owner: string,
  repo: string,
  work: () => Promise<T>,
): Promise<T> {
  const key = `otter-repo:${owner}/${repo}`;
  return helpers.withPgClient(async (pg) => {
    await pg.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
    try {
      return await work();
    } finally {
      await pg.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
        key,
      ]);
    }
  });
}
