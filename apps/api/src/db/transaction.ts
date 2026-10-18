import type { Pool, PoolClient } from "pg";

/** Runs work in BEGIN … COMMIT; any error rolls back and is rethrown. */
export async function withTransaction(
  pool: Pool,
  work: (tx: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await work(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function countOpenPullRequests(pool: Pool): Promise<number> {
  const client = await pool.connect();
  const result = await client.query<{ count: string }>(
    "SELECT count(*) AS count FROM pull_requests WHERE state = 'open'",
  );
  const count = Number(result.rows[0].count);
  return count;
}
