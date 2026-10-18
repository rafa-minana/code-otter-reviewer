import type { Finding } from "@otter/contracts";
import { parseDiff } from "@otter/reviewer/diff.js";

// Pure business rules: no I/O imports allowed here.

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
