import { serve } from "@hono/node-server";
import { runMigrations } from "graphile-worker";
import pg from "pg";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { enqueueCleanup } from "./queue/enqueue-cleanup.js";
import { enqueueReview } from "./queue/enqueue-review.js";

const config = loadConfig(process.env);

// So graphile_worker.add_job exists even if the worker has not started yet.
await runMigrations({ connectionString: config.databaseUrl });

const pool = new pg.Pool({ connectionString: config.databaseUrl });

const app = createApp({
  webhookSecret: config.webhookSecret,
  enqueueReview: (job, delaySeconds) => enqueueReview(pool, job, delaySeconds),
  enqueueCleanup: (job) => enqueueCleanup(pool, job),
});

serve({ fetch: app.fetch, port: config.port }, ({ port }) =>
  console.log(`api listening on :${port}`),
);
