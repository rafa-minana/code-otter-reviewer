import { test } from "node:test";
import assert from "node:assert/strict";
import { QUOTA_EXHAUSTED_HEADER, REVIEWER_EXIT } from "@otter/contracts";
import { APICallError, RetryError } from "ai";
import { classify } from "./errors.js";

const apiError = (statusCode: number, responseHeaders?: Record<string, string>) =>
  new APICallError({ message: `status ${statusCode}`, url: "http://otter-gateway:8080", requestBodyValues: {}, statusCode, responseHeaders });
const exitCodeFor = (err: unknown) => classify(err).exitCode;

test("a saturated provider is overloaded; a 4xx is permanent; the rest is transient", () => {
  for (const s of [502, 503, 529]) assert.equal(exitCodeFor(apiError(s)), REVIEWER_EXIT.overloaded, `${s}`);
  for (const s of [400, 401, 402, 403, 404, 413]) assert.equal(exitCodeFor(apiError(s)), REVIEWER_EXIT.permanent, `${s}`);
  for (const s of [408, 429, 500]) assert.equal(exitCodeFor(apiError(s)), REVIEWER_EXIT.transient, `${s}`);
  assert.equal(exitCodeFor(new Error("the model ended without submitting its answer")), REVIEWER_EXIT.transient);
  assert.equal(exitCodeFor("boom"), REVIEWER_EXIT.transient);
});

test("the API error is found behind the SDK's retries and a cause chain", () => {
  const retried = new RetryError({ message: "Failed after 3 attempts", reason: "maxRetriesExceeded", errors: [apiError(500), apiError(529)] });
  assert.equal(exitCodeFor(retried), REVIEWER_EXIT.overloaded);
  assert.equal(exitCodeFor(new Error("verify failed", { cause: apiError(403) })), REVIEWER_EXIT.permanent);
});

test("the gateway's quota mark is its own case, with the reset time it knows", () => {
  const quota = (headers: Record<string, string>) => classify(apiError(403, { [QUOTA_EXHAUSTED_HEADER]: "exhausted", ...headers }));
  assert.deepEqual(quota({ "retry-after": "3600" }), { exitCode: REVIEWER_EXIT.quota, failure: { retryAfterSeconds: 3600 } });
  assert.deepEqual(quota({}), { exitCode: REVIEWER_EXIT.quota, failure: {} }, "unknown reset: the worker picks the wait");
  assert.deepEqual(classify(apiError(403)), { exitCode: REVIEWER_EXIT.permanent }, "an unmarked 403 (review budget) stays permanent");
});
