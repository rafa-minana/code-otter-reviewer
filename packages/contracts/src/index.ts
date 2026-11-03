// Contracts: only what crosses process boundaries (queue, mounted files, findings.json, shared DB rows). Helpers only where both sides must agree (job keys, review status).
export * from "./review-status.js";
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
  deferrals?: number; // times the worker postponed it because the LLM provider was overloaded
  quotaWaits?: number; // times it waited for the LLM quota to reset
  queuedAt?: string; // when it was first queued, set on its first postponement: postponed reviews run in this order
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

/** Exit codes of the reviewer container: how the worker treats a failed review. */
export const REVIEWER_EXIT = {
  transient: 1, // Graphile retries the job
  permanent: 2, // retrying can't fix it (bad config, quota exhausted, request too big): fail now
  overloaded: 3, // the provider is saturated: the worker postpones the job
  quota: 4, // the LLM quota ran out: the worker postpones the job until it resets
} as const;

/** What the reviewer writes on stdout when it exits with REVIEWER_EXIT.quota. */
export interface ReviewerFailure {
  retryAfterSeconds?: number; // until the quota resets, when the gateway knows it
}

/** Set by the gateway on a refusal for an exhausted quota (its daily cap or the provider's); `retry-after` may come with it. */
export const QUOTA_EXHAUSTED_HEADER = "x-otter-quota";

/** Graphile Worker task names: the api enqueues them, the worker registers them. */
export const TASKS = {
  review: "review",
  cleanup: "cleanup",
  janitor: "janitor",
} as const;

/**
 * Values of LLM_PROVIDER: the reviewer picks its AI SDK provider by it, the gateway its upstream and auth.
 * "openai" is OpenAI's own API; "openai-compatible" is anything else speaking its protocol (OpenRouter,
 * Groq, Ollama…) and needs LLM_BASE_URL.
 */
export const LLM_PROVIDERS = [
  "anthropic",
  "openai",
  "openai-compatible",
  "gemini",
] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

export const reviewJobKey = (j: Pick<ReviewJob, "owner" | "repo" | "number">) =>
  `review:${j.owner}/${j.repo}#${j.number}`;
