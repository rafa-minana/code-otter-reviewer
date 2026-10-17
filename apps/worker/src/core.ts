import type { Finding } from "@otter/contracts";

// Pure business rules: no I/O imports allowed here.

/** Commentable `path:side:line` keys of a unified diff (context and `+` → RIGHT, `-` → LEFT). */
export function diffLines(diff: string): Set<string> {
  throw new Error("not implemented");
}

/** Findings that sit on diff lines and were not already published. */
export function selectPublishable(findings: Finding[], diff: string, previous: Finding[]): Finding[] {
  throw new Error("not implemented");
}

/** True when the PR moved on while we were reviewing: discard, another review is queued. */
export function isStale(reviewedSha: string, headSha: string): boolean {
  throw new Error("not implemented");
}
