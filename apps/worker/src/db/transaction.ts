import type { PoolClient } from "pg";

/** Runs work in BEGIN … COMMIT on a connection Graphile lent (helpers.withPgClient); any error rolls back and is rethrown. */
export async function inTransaction<T>(
  pg: PoolClient,
  work: () => Promise<T>,
): Promise<T> {
  await pg.query("BEGIN");
  try {
    const result = await work();
    await pg.query("COMMIT");
    return result;
  } catch (err) {
    await pg.query("ROLLBACK");
    throw err;
  }
}
