import type { Finding, ReviewerInput, ReviewJob } from "@otter/contracts";

// Only vendor-facing I/O gets a port: these are what tests fake and what may be swapped.

export interface GitHubClient {
  getDiff(job: ReviewJob): Promise<string>;
  getHeadSha(owner: string, repo: string, number: number): Promise<string>;
  /** Posts ONE review with all inline comments; returns its GitHub id. */
  createReview(job: ReviewJob, body: string, comments: Finding[]): Promise<number>;
  /** Short-lived installation token, used for git fetch. */
  installationToken(owner: string, repo: string): Promise<string>;
}

export interface ContainerRunner {
  /** Raw findings.json: the container ran untrusted code, so the core validates it. */
  runReviewer(job: ReviewJob, worktree: string, input: ReviewerInput): Promise<unknown>;
}
