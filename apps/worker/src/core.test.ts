import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, isStale, selectPublishable } from "./core.js";
import { DIFF, finding } from "./fixtures.js";

test("diffLines: context and + lines on the new side, across hunks; - lines are not commentable", () => {
  assert.deepEqual(
    [...diffLines(DIFF)],
    ["a.ts:RIGHT:1", "a.ts:RIGHT:2", "a.ts:RIGHT:3", "a.ts:RIGHT:20", "a.ts:RIGHT:21", "a.ts:RIGHT:22"],
  );
});

test("selectPublishable drops findings off the diff and those already published", () => {
  const kept = selectPublishable(
    [finding(2), finding(10), finding(2, "bug", "other.ts"), finding(21, "old"), finding(21, "new")],
    DIFF,
    [finding(21, "old")],
  );
  assert.deepEqual(kept.map((f) => [f.path, f.line, f.body]), [["a.ts", 2, "bug"], ["a.ts", 21, "new"]]);
});

test("selectPublishable keeps ranges fully on the diff and falls back to the last line otherwise", () => {
  const ranged = (startLine: number, line: number) => ({ ...finding(line, `r${startLine}-${line}`), startLine });
  const kept = selectPublishable(
    [ranged(1, 3), ranged(3, 20), ranged(18, 21), ranged(3, 2), ranged(1, 10)],
    DIFF,
    [],
  );
  assert.deepEqual(
    kept.map((f) => [f.startLine, f.line]),
    [
      [1, 3], // whole range inside the first hunk
      [undefined, 20], // spans the gap between hunks
      [undefined, 21], // starts before the second hunk
      [undefined, 2], // start after end
      // 1..10 dropped: its last line is not on the diff
    ],
  );
});

test("isStale when the head moved", () => {
  assert.equal(isStale("a", "a"), false);
  assert.equal(isStale("a", "b"), true);
});
