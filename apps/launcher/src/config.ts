import type { LauncherConfig } from "./docker.js";

/** Compose gives the launcher these four variables only, never the whole .env. */
export function loadConfig(env: NodeJS.ProcessEnv): LauncherConfig {
  const maxReviewers = Number(env.WORKER_CONCURRENCY || 1);
  if (!Number.isInteger(maxReviewers) || maxReviewers < 1)
    throw new Error(`WORKER_CONCURRENCY must be a positive integer; got "${env.WORKER_CONCURRENCY}"`);
  return {
    image: env.REVIEWER_IMAGE || "code-otter-reviewer", // built by `docker compose build reviewer`
    network: env.REVIEWER_NETWORK || "otter-reviewers",
    volume: env.OTTER_DATA_VOLUME || "otter-data",
    maxReviewers,
  };
}
