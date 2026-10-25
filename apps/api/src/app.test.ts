import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { CleanupJob, ReviewJob } from "@otter/contracts";
import { createApp, type AppDeps } from "./app.js";
import { MAX_BODY_BYTES } from "./constraints/constraints.js";
import { EXPECTED_JOB, prPayload } from "./fixtures.js";

const SECRET = "test-secret";
const OVER_BODY_LIMIT = "x".repeat(MAX_BODY_BYTES + 1);

const ADMIN_TOKEN = "a".repeat(32);

const enqueued: Array<[ReviewJob, number]> = [];
const cleanups: Required<CleanupJob>[] = [];
const repoCleanups: CleanupJob[] = [];
let janitorRuns = 0;
let rereviewOutcome: Awaited<ReturnType<AppDeps["rereview"]>> = "queued";
const deps: AppDeps = {
  webhookSecret: SECRET,
  enqueueReview: async (job, delaySeconds) =>
    void enqueued.push([job, delaySeconds]),
  enqueueCleanup: async (job) => void cleanups.push(job),
  adminToken: ADMIN_TOKEN,
  status: async () => ({ queue: [], activeReviews: [] }),
  pullRequest: async (pr) => (pr.number === 1 ? { ...pr, reviews: [] } : null),
  rereview: async () => rereviewOutcome,
  enqueueRepoCleanup: async (job) => void repoCleanups.push(job),
  enqueueJanitor: async () => void janitorRuns++,
};
const app = createApp(deps);

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

const admin = (path: string, method = "GET", token = ADMIN_TOKEN) =>
  app.request(`/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });

test("admin needs ADMIN_TOKEN, and is off without one", async () => {
  assert.equal((await app.request("/admin/status")).status, 401);
  assert.equal((await admin("/status", "GET", "b".repeat(32))).status, 401);
  assert.equal((await admin("/status")).status, 200);
  const off = createApp({ ...deps, adminToken: undefined });
  assert.equal((await off.request("/admin/status")).status, 503);
});

test("admin rejects names and numbers that could escape a path", async () => {
  assert.equal((await admin("/repos/acme/..%2Fetc/pulls/1")).status, 400);
  assert.equal((await admin("/repos/acme/app/pulls/0")).status, 400);
  assert.equal((await admin("/repos/acme/app/pulls/1e3")).status, 400);
  assert.equal((await admin("/repos/acme/app/pulls/99999999999")).status, 400);
  assert.equal((await admin("/repos/acme/app%20x", "DELETE")).status, 400);
  assert.equal(repoCleanups.length, 0);
});

test("admin reads PR state and queues cleanups and the janitor", async () => {
  assert.equal((await admin("/repos/acme/app/pulls/1")).status, 200);
  assert.equal((await admin("/repos/acme/app/pulls/2")).status, 404);

  assert.equal((await admin("/repos/acme/app/pulls/7", "DELETE")).status, 202);
  assert.deepEqual(cleanups.at(-1), { owner: "acme", repo: "app", number: 7 });
  assert.equal((await admin("/repos/acme/app", "DELETE")).status, 202);
  assert.deepEqual(repoCleanups, [{ owner: "acme", repo: "app" }]);
  assert.equal((await admin("/gc", "POST")).status, 202);
  assert.equal(janitorRuns, 1);
});

test("a forced re-review answers by its outcome", async () => {
  const cases = [
    ["queued", 202],
    ["unknown", 404],
    ["closed", 409],
    ["already_queued", 409],
    ["in_progress", 409],
    ["never_reviewed", 409],
  ] as const;
  for (const [outcome, status] of cases) {
    rereviewOutcome = outcome;
    const res = await admin("/repos/acme/app/pulls/1/review", "POST");
    assert.equal(res.status, status, outcome);
    assert.deepEqual(await res.json(), { outcome });
  }
});
