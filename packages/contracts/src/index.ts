// Contracts: only messages that cross process boundaries (queue, mounted files, findings.json). No helpers.
export type Severity = "critical" | "major" | "minor" | "nit";

export interface Finding {
  path: string;
  startLine?: number; // first line of a multi-line range; absent = only `line`
  line: number; // last line of the range (GitHub's `line`)
  side: "LEFT" | "RIGHT";
  severity: Severity;
  body: string;
  suggestion?: string;
  confidence?: number; // 0..1, set by the verifier; absent = unverified
}

export interface ReviewJob {
  installationId: number; // to request the installation token
  owner: string;
  repo: string;
  number: number;
  sha: string;
}

/** Without `number` it cleans the whole repo, mirror included. */
export interface CleanupJob {
  owner: string;
  repo: string;
  number?: number;
}

/** What the worker hands the reviewer container. */
export interface ReviewerInput {
  title: string;
  description: string;
  diff: string;
  repoDir?: string; // checkout of the PR's head; enables dynamic context (absent = diff only)
  config: unknown; // parsed .otter.yaml
  previousFindings: Finding[];
}

/** The worker → reviewer container message, on its stdin. */
export interface ReviewerRequest {
  input: ReviewerInput;
  finalAttempt: boolean; // on the last attempt a failing verifier degrades instead of throwing
}

/** What the reviewer hands back: findings plus what the published summary needs. */
export interface ReviewerOutput {
  summary: string;
  risk: "low" | "medium" | "high";
  language: "en" | "es"; // from .otter.yaml, for the worker's fixed texts
  findings: Finding[];
  notReviewed: string[]; // paths left out by the token budget
  filtered: string[]; // paths skipped by .otter.yaml or default filters
  deleted: string[]; // files deleted entirely
}

/** Graphile Worker task names: the api enqueues them, the worker registers them. */
export const TASKS = { review: "review", cleanup: "cleanup" } as const;

export const reviewJobKey = (j: Pick<ReviewJob, "owner" | "repo" | "number">) =>
  `review:${j.owner}/${j.repo}#${j.number}`;
