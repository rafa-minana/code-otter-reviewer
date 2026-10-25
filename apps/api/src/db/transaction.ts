import type { Pool, PoolClient } from "pg";

/** Runs work in BEGIN … COMMIT; any error rolls back and is rethrown. */
export async function withTransaction<T>(
  pool: Pool,
  work: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
