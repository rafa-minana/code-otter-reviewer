import { TASKS, type ReviewJob } from "@otter/contracts";
import { createLlm } from "@otter/reviewer/llm.js";
import { run } from "graphile-worker";
import { loadConfig } from "./config.js";
import { octokitClient } from "./github.js";
import { handleReview } from "./review.js";

const config = loadConfig(process.env);
const deps = { gh: octokitClient(config), llm: createLlm(process.env) };

// shortcut: one review at a time (ARCHITECTURE.md §8 global limit); raise it with more replicas or an env var.
await run({
  connectionString: config.databaseUrl,
  concurrency: 1,
  taskList: {
    [TASKS.review]: (payload, helpers) =>
      handleReview(deps, payload as ReviewJob, helpers),
  },
});
console.log("worker started");
