import { TASKS, type CleanupJob, type ReviewJob } from "@otter/contracts";
import { createLlm } from "@otter/reviewer/llm.js";
import { run } from "graphile-worker";
import { handleCleanup } from "./cleanup.js";
import { loadConfig } from "./config.js";
import { octokitClient } from "./github.js";
import { dockerRunner, ensureReviewerImage } from "./runner.js";
import { handleReview } from "./review.js";

const config = loadConfig(process.env);
// The LLM runs in the reviewer container; validating its settings here makes a typo fail at startup.
createLlm(process.env);
await ensureReviewerImage(config.reviewer);
const deps = {
  gh: octokitClient(config),
  runner: dockerRunner(config.reviewer),
  git: config.git,
};

// shortcut: one review at a time (ARCHITECTURE.md §8 global limit); raise it with more replicas or an env var.
await run({
  connectionString: config.databaseUrl,
  concurrency: 1,
  taskList: {
    [TASKS.review]: (payload, helpers) =>
      handleReview(deps, payload as ReviewJob, helpers),
    [TASKS.cleanup]: (payload, helpers) =>
      handleCleanup(deps, payload as CleanupJob, helpers),
  },
});
console.log("worker started");
