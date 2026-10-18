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
