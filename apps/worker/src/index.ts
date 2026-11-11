import { TASKS, type CheckJob, type CleanupJob, type ReviewJob } from "@otter/contracts";
import { createLlm } from "@otter/reviewer/llm.js";
import { run } from "graphile-worker";
import { handleCheck } from "./checks.js";
import { handleCleanup } from "./cleanup.js";
import { loadConfig } from "./config.js";
import { octokitClient } from "./github.js";
import { handleJanitor } from "./janitor.js";
import { launcherRunner } from "./runner.js";
import { handleReview } from "./review.js";

/** Check run updates are a few GitHub calls each: two at a time is plenty. */
const CHECKS_CONCURRENCY = 2;

const config = loadConfig(process.env);
// The LLM runs in the reviewer container; validating its settings here makes a typo fail at startup.
createLlm(process.env);
const deps = {
  gh: octokitClient(config),
  runner: launcherRunner(config.reviewer, config.git.dataDir),
  git: config.git,
  maxStorageBytes: config.maxStorageBytes,
  repoIdleDays: config.repoIdleDays,
};

// Its own runner, so a PR's check run is updated even while every review slot is busy.
await run({
  connectionString: config.databaseUrl,
  concurrency: CHECKS_CONCURRENCY,
  taskList: {
    [TASKS.checks]: (payload, helpers) => handleCheck(deps, payload as CheckJob, helpers),
  },
});

// Global limit of simultaneous reviewers (ARCHITECTURE.md §8); extra jobs wait in the queue.
await run({
  connectionString: config.databaseUrl,
  concurrency: config.concurrency,
  // Daily at 04:00 UTC; POST /admin/gc queues it on demand.
  crontab: `0 4 * * * ${TASKS.janitor}`,
  taskList: {
    [TASKS.review]: (payload, helpers) =>
      handleReview(deps, payload as ReviewJob, helpers),
    [TASKS.cleanup]: (payload, helpers) =>
      handleCleanup(deps, payload as CleanupJob, helpers),
    [TASKS.janitor]: (_payload, helpers) => handleJanitor(deps, helpers),
  },
});
console.log("worker started");
