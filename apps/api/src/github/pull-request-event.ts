import type { ReviewJob } from "@otter/contracts";

export const GITHUB_EVENTS = {
  ping: "ping",
  pullRequest: "pull_request",
} as const;

const IMMEDIATE_SECONDS = 0;
/** Waits for more pushes before reviewing; a newer push restarts it. */
const PUSH_DEBOUNCE_SECONDS = 120;

const REVIEW_DELAY_BY_ACTION: Readonly<Record<string, number>> = {
  opened: IMMEDIATE_SECONDS,
  reopened: IMMEDIATE_SECONDS,
  synchronize: PUSH_DEBOUNCE_SECONDS,
};

/** owner/repo end up in filesystem paths and job keys. */
const SAFE_NAME = /^[A-Za-z0-9_.-]+$/;
/** SHA-1 (40 hex) or SHA-256 (64 hex) object id. */
const GIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Only the fields we read from GitHub's pull_request payload; all untrusted. */
interface PullRequestPayload {
  action?: unknown;
  installation?: { id?: unknown };
  repository?: { name?: unknown; owner?: { login?: unknown } };
  pull_request?: { number?: unknown; head?: { sha?: unknown } };
}

export type WebhookDecision =
  | { kind: "enqueue"; job: ReviewJob; delaySeconds: number }
  | { kind: "ignore" }
  | { kind: "invalid" };

export function decideWebhook(
  event: string | undefined,
  payload: unknown,
): WebhookDecision {
  const pr = (payload ?? {}) as PullRequestPayload;
  const delaySeconds = reviewDelayFor(event, pr.action);
  if (delaySeconds === undefined) return { kind: "ignore" };

  const job = extractReviewJob(pr);
  return job ? { kind: "enqueue", job, delaySeconds } : { kind: "invalid" };
}

function reviewDelayFor(
  event: string | undefined,
  action: unknown,
): number | undefined {
  if (event !== GITHUB_EVENTS.pullRequest || typeof action !== "string")
    return undefined;
  // hasOwn: rejects inherited keys such as "constructor".
  return Object.hasOwn(REVIEW_DELAY_BY_ACTION, action)
    ? REVIEW_DELAY_BY_ACTION[action]
    : undefined;
}

function extractReviewJob(pr: PullRequestPayload): ReviewJob | undefined {
  const installationId = pr.installation?.id;
  const owner = pr.repository?.owner?.login;
  const repo = pr.repository?.name;
  const number = pr.pull_request?.number;
  const sha = pr.pull_request?.head?.sha;

  const isValid =
    isInteger(installationId) &&
    isInteger(number) &&
    matches(owner, SAFE_NAME) &&
    matches(repo, SAFE_NAME) &&
    matches(sha, GIT_SHA);

  return isValid ? { installationId, owner, repo, number, sha } : undefined;
}

const isInteger = (value: unknown): value is number => Number.isInteger(value);
const matches = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" && pattern.test(value);
