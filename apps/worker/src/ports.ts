import type { Finding, ReviewerInput, ReviewJob } from "@otter/contracts";

// Only vendor-facing I/O gets a port: these are what tests fake and what may be swapped.

export interface PullRequest {
  title: string;
  body: string;
  baseRef: string;
  headSha: string;
}

/** A rendered inline comment, as GitHub's createReview takes it. */
export type ReviewComment = Pick<
  Finding,
  "path" | "startLine" | "line" | "side" | "body"
>;

export interface GitHubClient {
  getPullRequest(job: ReviewJob): Promise<PullRequest>;
  /** File contents at `ref`, or null when it does not exist. */
  getFile(job: ReviewJob, path: string, ref: string): Promise<string | null>;
  /** Posts ONE review (event COMMENT) with all inline comments; returns its GitHub id. */
  createReview(
    job: ReviewJob,
    body: string,
    comments: ReviewComment[],
  ): Promise<number>;
  /** Short-lived installation token, used for git fetch (v1). */
  installationToken(job: ReviewJob): Promise<string>;
}

export interface ContainerRunner {
  /** Raw findings.json: the container ran untrusted code, so the core validates it. */
  runReviewer(
    job: ReviewJob,
    worktree: string,
    input: ReviewerInput,
  ): Promise<unknown>;
}
