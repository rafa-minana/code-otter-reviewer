import { test } from "node:test";
import assert from "node:assert/strict";
import { EXPECTED_JOB, prPayload } from "../fixtures.js";
import { decideWebhook } from "./pull-request-event.js";

test("decideWebhook maps actions to review delays", () => {
  const enqueue = (delaySeconds: number) => ({
    kind: "enqueue",
    job: EXPECTED_JOB,
    delaySeconds,
  });
  assert.deepEqual(
    decideWebhook("pull_request", prPayload("opened")),
    enqueue(0),
  );
  assert.deepEqual(
    decideWebhook("pull_request", prPayload("reopened")),
    enqueue(0),
  );
  assert.deepEqual(
    decideWebhook("pull_request", prPayload("synchronize")),
    enqueue(120),
  );
});

test("decideWebhook ignores other events and actions", () => {
  const ignore = { kind: "ignore" };
  assert.deepEqual(decideWebhook("pull_request", prPayload("closed")), ignore);
  assert.deepEqual(
    decideWebhook("pull_request", prPayload("constructor")),
    ignore,
  );
  assert.deepEqual(decideWebhook("issues", prPayload("opened")), ignore);
  assert.deepEqual(decideWebhook("pull_request", null), ignore);
});

test("decideWebhook rejects malformed payloads", () => {
  const invalid = { kind: "invalid" };
  const opened = prPayload("opened");
  assert.deepEqual(
    decideWebhook("pull_request", {
      ...opened,
      pull_request: { number: 7, head: {} },
    }),
    invalid,
  );
  assert.deepEqual(
    decideWebhook("pull_request", {
      ...opened,
      repository: { name: "../x", owner: { login: "acme" } },
    }),
    invalid,
  );
  assert.deepEqual(
    decideWebhook("pull_request", { ...opened, installation: undefined }),
    invalid,
  );
});
