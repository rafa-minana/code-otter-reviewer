import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const ENV = { DATABASE_URL: "postgres://x", GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "k", GATEWAY_SECRET: "s".repeat(32) };

test("reviewers default to the internal network and the gateway", () => {
  const { reviewer } = loadConfig(ENV);
  assert.equal(reviewer.network, "otter-reviewers");
  assert.equal(reviewer.gatewayUrl, "http://otter-gateway:8080");
});

test("without a long enough GATEWAY_SECRET the worker does not start", () => {
  assert.throws(() => loadConfig({ ...ENV, GATEWAY_SECRET: undefined }), /GATEWAY_SECRET must be at least 32/);
  assert.throws(() => loadConfig({ ...ENV, GATEWAY_SECRET: "short" }), /GATEWAY_SECRET/);
});

test("storage quota and repo idle time default to 10 GB and 30 days, and reject nonsense", () => {
  const config = loadConfig(ENV);
  assert.equal(config.maxStorageBytes, 10 * 1024 ** 3);
  assert.equal(config.repoIdleDays, 30);
  assert.equal(loadConfig({ ...ENV, MAX_SPACE_REPO_STORAGE_GB: "0.5" }).maxStorageBytes, 0.5 * 1024 ** 3);
  assert.throws(() => loadConfig({ ...ENV, MAX_SPACE_REPO_STORAGE_GB: "0" }), /MAX_SPACE_REPO_STORAGE_GB/);
  assert.throws(() => loadConfig({ ...ENV, KEEP_REPO_IDLE_DAYS: "1.5" }), /KEEP_REPO_IDLE_DAYS must be a positive integer/);
  assert.throws(() => loadConfig({ ...ENV, WORKER_CONCURRENCY: "abc" }), /WORKER_CONCURRENCY/);
});
