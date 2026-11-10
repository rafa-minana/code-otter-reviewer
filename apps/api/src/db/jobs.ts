/**
 * SQL condition: the Graphile job (table alias `alias`) waits in the queue, i.e. nobody runs it and it has
 * attempts left. One past its last attempt has given up, even though Graphile keeps its row (and key).
 */
export const queuedJobSql = (alias: string) =>
  `(${alias}.locked_at IS NULL AND ${alias}.attempts < ${alias}.max_attempts)`;
