import type { ReviewJob } from "@otter/contracts";

// Test-only data.

export const EXPECTED_JOB: ReviewJob = {
  installationId: 42,
  owner: "acme",
  repo: "repo",
  number: 7,
  sha: "a".repeat(40),
};

/** Minimal pull_request webhook payload that maps to EXPECTED_JOB. */
export const prPayload = (action: string) => ({
  action,
  installation: { id: EXPECTED_JOB.installationId },
  repository: { name: EXPECTED_JOB.repo, owner: { login: EXPECTED_JOB.owner } },
  pull_request: {
    number: EXPECTED_JOB.number,
    head: { sha: EXPECTED_JOB.sha },
  },
});
