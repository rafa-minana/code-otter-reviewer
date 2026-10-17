// Contracts: only messages that cross process boundaries (queue, mounted files, findings.json). No helpers.
export type Severity = "critical" | "major" | "minor" | "nit";

export interface Finding {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  severity: Severity;
  body: string;
  suggestion?: string;
  confidence: number; // 0..1, set by the verifier
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
  diff: string;
  config: unknown; // parsed .otter.yaml
  previousFindings: Finding[];
}

/** Graphile Worker task names: the api enqueues them, the worker registers them. */
export const TASKS = { review: "review", cleanup: "cleanup" } as const;

export const reviewJobKey = (j: Pick<ReviewJob, "owner" | "repo" | "number">) =>
  `review:${j.owner}/${j.repo}#${j.number}`;
