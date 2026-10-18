import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { CleanupJob, ReviewJob } from "@otter/contracts";
import { createApp } from "./app.js";
import { MAX_BODY_BYTES } from "./constraints/constraints.js";
import { EXPECTED_JOB, prPayload } from "./fixtures.js";

const SECRET = "test-secret";
const OVER_BODY_LIMIT = "x".repeat(MAX_BODY_BYTES + 1);

const enqueued: Array<[ReviewJob, number]> = [];
const cleanups: Required<CleanupJob>[] = [];
const app = createApp({
  webhookSecret: SECRET,
  enqueueReview: async (job, delaySeconds) =>
    void enqueued.push([job, delaySeconds]),
  enqueueCleanup: async (job) => void cleanups.push(job),
});

const signatureOf = (body: string) =>
  `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

async function postWebhook(
  event: string,
  body: string,
  signature = signatureOf(body),
): Promise<number> {
  const res = await app.request("/webhook", {
    method: "POST",
    body,
    headers: { "x-github-event": event, "x-hub-signature-256": signature },
  });
  return res.status;
}

test("webhook rejects, ignores or enqueues", async () => {
  const opened = JSON.stringify(prPayload("opened"));

  assert.equal(await postWebhook("pull_request", opened, "sha256=bad"), 401);
  assert.equal(await postWebhook("ping", "{}"), 200);
  assert.equal(
    await postWebhook("pull_request", JSON.stringify(prPayload("labeled"))),
    204,
  );
  assert.equal(await postWebhook("pull_request", "not json"), 400);
  assert.equal(
    enqueued.length,
    0,
    "nothing is enqueued before a valid PR event",
  );

  assert.equal(await postWebhook("pull_request", opened), 202);
  assert.deepEqual(enqueued, [[EXPECTED_JOB, 0]]);

  assert.equal(await postWebhook("pull_request", OVER_BODY_LIMIT), 413);
});

test("a closed PR enqueues its cleanup", async () => {
  assert.equal(
    await postWebhook("pull_request", JSON.stringify(prPayload("closed"))),
    202,
  );
  const { owner, repo, number } = EXPECTED_JOB;
  assert.deepEqual(cleanups, [{ owner, repo, number }]);
});

test("admin is not implemented yet", async () => {
  assert.equal((await app.request("/admin/status")).status, 501);
});
