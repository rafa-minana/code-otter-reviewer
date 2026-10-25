import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const ENV = { GITHUB_WEBHOOK_SECRET: "s", DATABASE_URL: "postgres://x" };

test("ADMIN_TOKEN is optional, but a short one stops the api", () => {
  assert.equal(loadConfig(ENV).adminToken, undefined);
  assert.equal(loadConfig({ ...ENV, ADMIN_TOKEN: "t".repeat(32) }).adminToken, "t".repeat(32));
  assert.throws(() => loadConfig({ ...ENV, ADMIN_TOKEN: "short" }), /ADMIN_TOKEN must be at least 32/);
});
