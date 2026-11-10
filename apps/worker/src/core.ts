import { REVIEWER_EXIT, type Finding, type ReviewerOutput } from "@otter/contracts";
import { parseDiff } from "@otter/reviewer/diff.js";
import { z } from "zod";

// Pure business rules: no I/O imports allowed here.

/** How long a review waits, and how many times, before it fails, by why the LLM couldn't take it. */
export const WAITS = {
  // A saturated provider: retried 5 min later, up to 30 min.
  overloaded: { counter: "deferrals", max: 6, fallbackSeconds: 5 * 60 },
  // An exhausted quota: until it resets when known (else 5 h), up to 4 times (~a day).
  quota: { counter: "quotaWaits", max: 4, fallbackSeconds: 5 * 3600 },
} as const;
export type Wait = (typeof WAITS)[keyof typeof WAITS];
/** A wait from the (untrusted) reviewer is bounded, and lands just after the reset, not on it. */
const MIN_WAIT_SECONDS = 60;
const MAX_WAIT_SECONDS = 24 * 3600;
const RESET_MARGIN_SECONDS = 60;

/** What the worker does with a failed review attempt (ARCHITECTURE.md §5, the reviewer's exit codes). */
export type NextStep =
  | { kind: "fail" } // retrying can't fix it: no space, bad key or model, request too big
  | { kind: "defer"; why: keyof typeof WAITS; wait: Wait; seconds: number } // the LLM can't take it now
  | { kind: "retry" }; // anything else: Graphile's quick retries

export function nextStep(failure: {
  diskFull: boolean;
  exitCode?: number | undefined;
  retryAfterSeconds?: number | undefined;
}): NextStep {
  const { diskFull, exitCode, retryAfterSeconds } = failure;
  if (diskFull || exitCode === REVIEWER_EXIT.permanent) return { kind: "fail" };
  const why =
    exitCode === REVIEWER_EXIT.overloaded ? "overloaded" : exitCode === REVIEWER_EXIT.quota ? "quota" : undefined;
  if (!why) return { kind: "retry" };
  const seconds =
    why === "quota" && retryAfterSeconds
      ? Math.min(Math.max(retryAfterSeconds + RESET_MARGIN_SECONDS, MIN_WAIT_SECONDS), MAX_WAIT_SECONDS)
      : WAITS[why].fallbackSeconds;
  return { kind: "defer", why, wait: WAITS[why], seconds };
}

const key = (path: string, side: string, line: number) =>
  `${path}:${side}:${line}`;

/** Commentable `path:RIGHT:line` keys of a unified diff: context and `+` lines (findings are always RIGHT). */
export function diffLines(diff: string): Set<string> {
  const keys = new Set<string>();
  for (const file of parseDiff(diff)) {
    for (const hunk of file.hunks) {
      let line = hunk.newStart;
      for (const l of hunk.lines)
        if (l[0] !== "-") keys.add(key(file.path, "RIGHT", line++));
    }
  }
  return keys;
}

/** Identity of a finding across reviews; the range start is left out on purpose. */
export const findingKey = (f: Finding) =>
  `${key(f.path, f.side, f.line)}:${f.body}`;

/**
 * Findings that sit on diff lines (GitHub answers 422 otherwise) and were not already published.
 * A range must lie entirely on commentable lines; otherwise it falls back to its last line, as PR-Agent does.
 */
export function selectPublishable(
  findings: Finding[],
  diff: string,
  previous: Finding[],
): Finding[] {
  const commentable = diffLines(diff);
  const onDiff = (f: Finding, line: number) =>
    commentable.has(key(f.path, f.side, line));
  // Stops at the first gap, so a bogus range (start after end, or huge) costs nothing.
  const rangeOnDiff = (f: Finding, start: number) => {
    if (start >= f.line) return false;
    for (let l = start; l <= f.line; l++) if (!onDiff(f, l)) return false;
    return true;
  };
  const published = new Set(previous.map(findingKey));
  return findings
    .map(({ startLine, ...f }) =>
      startLine !== undefined && rangeOnDiff(f, startLine)
        ? { ...f, startLine }
        : f,
    )
    .filter((f) => onDiff(f, f.line) && !published.has(findingKey(f)));
}

/** True when the PR moved on while we were reviewing: discard, another review is queued. */
export function isStale(reviewedSha: string, headSha: string): boolean {
  return reviewedSha !== headSha;
}

// Bounds for what a reviewer container may hand back: it touched untrusted code, so its output is untrusted too.
const MAX_FINDINGS = 50;
const MAX_TEXT_CHARS = 10_000; // a summary, a comment body or a suggestion
const MAX_PATH_CHARS = 1_000;
const MAX_LISTED_PATHS = 10_000;

const path = z.string().min(1).max(MAX_PATH_CHARS);
const text = z.string().max(MAX_TEXT_CHARS);
const lineNumber = z.number().int().positive();

const reviewerOutputSchema = z.object({
  summary: text,
  risk: z.enum(["low", "medium", "high"]),
  language: z.enum(["en", "es"]),
  findings: z
    .array(
      z.object({
        path,
        startLine: lineNumber.optional(),
        line: lineNumber,
        side: z.enum(["LEFT", "RIGHT"]),
        severity: z.enum(["critical", "major", "minor", "nit"]),
        body: text,
        suggestion: text.optional(),
        confidence: z.number().min(0).max(1).optional(),
      }),
    )
    .max(MAX_FINDINGS),
  notReviewed: z.array(path).max(MAX_LISTED_PATHS),
  filtered: z.array(path).max(MAX_LISTED_PATHS),
  deleted: z.array(path).max(MAX_LISTED_PATHS),
}); // z.object strips unknown fields

/** The reviewer container's output, checked before anything reaches GitHub or the database. */
export function parseReviewerOutput(raw: unknown): ReviewerOutput {
  const parsed = reviewerOutputSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `invalid reviewer output: ${z.prettifyError(parsed.error)}`,
    );
  return parsed.data;
}
