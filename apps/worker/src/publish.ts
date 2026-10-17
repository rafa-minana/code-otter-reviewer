import type { Finding, ReviewJob } from "@otter/contracts";
import type { GitHubClient } from "./ports.js";

/** selectPublishable() + gh.createReview(); returns the GitHub review id. */
export async function publishReview(
  gh: GitHubClient,
  job: ReviewJob,
  diff: string,
  findings: Finding[],
  previous: Finding[],
): Promise<number> {
  throw new Error("not implemented");
}
