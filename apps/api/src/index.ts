import { serve } from "@hono/node-server";
import { runMigrations } from "graphile-worker";
import pg from "pg";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { adminStatus, pullRequestState } from "./db/admin-queries.js";
import {
  enqueueCleanup,
  enqueueJanitor,
  enqueueRepoCleanup,
} from "./queue/enqueue-cleanup.js";
import { enqueueRereview } from "./queue/enqueue-rereview.js";
import { enqueueReview } from "./queue/enqueue-review.js";

const config = loadConfig(process.env);

// So graphile_worker.add_job exists even if the worker has not started yet.
await runMigrations({ connectionString: config.databaseUrl });

const pool = new pg.Pool({ connectionString: config.databaseUrl });

const app = createApp({
  webhookSecret: config.webhookSecret,
  enqueueReview: (job, delaySeconds) => enqueueReview(pool, job, delaySeconds),
  enqueueCleanup: (job) => enqueueCleanup(pool, job),
  adminToken: config.adminToken,
  status: () => adminStatus(pool),
  pullRequest: (pr) => pullRequestState(pool, pr),
  rereview: (pr) => enqueueRereview(pool, pr),
  enqueueRepoCleanup: (job) => enqueueRepoCleanup(pool, job),
  enqueueJanitor: () => enqueueJanitor(pool),
});

serve({ fetch: app.fetch, port: config.port }, ({ port }) =>
  console.log(`api listening on :${port}`),
);
