import type { ReviewJob } from "@otter/contracts";
import type { ContainerRunner, GitHubClient } from "./ports.js";

/**
 * Review job handler: the only place that orchestrates (ARCHITECTURE.md §1).
 * 1. lock per repo → fetch into the mirror   2. worktree of the SHA
 * 3. runner.runReviewer → validate findings   4. isStale? → discard
 * 5. publishReview                            6. save state
 */
export async function handleReview(deps: { gh: GitHubClient; runner: ContainerRunner }, job: ReviewJob): Promise<void> {
  throw new Error("not implemented");
}
