import { test } from "node:test";
import assert from "node:assert/strict";
import { REVIEW_TRANSITIONS, sourcesOf } from "./review-status.js";

test("only the worker's running row finishes, and only a finished one is cancelled", () => {
  assert.deepEqual(sourcesOf("running"), []);
  assert.deepEqual(sourcesOf("published"), ["running"]);
  assert.deepEqual(sourcesOf("failed"), ["running"]);
  assert.deepEqual(sourcesOf("cancelled"), ["published", "stale", "failed"]);
  assert.deepEqual(REVIEW_TRANSITIONS.cancelled, [], "cancelled is terminal");
});
