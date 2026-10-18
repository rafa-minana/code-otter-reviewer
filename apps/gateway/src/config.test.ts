import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import { DEFAULT_REVIEW_MAX_REQUESTS, DEFAULT_REVIEW_MAX_TOKENS } from "./constants.js";

const ENV = {
  LLM_PROVIDER: "openai-compatible",
  LLM_MODEL: "m",
  LLM_API_KEY: "k",
  LLM_BASE_URL: "https://openrouter.ai/api/v1",
  GATEWAY_SECRET: "s".repeat(32),
};

test("loads the upstream and default budget; the daily cap is off unless set", () => {
  const config = loadConfig(ENV);
  assert.equal(config.upstream, "https://openrouter.ai/api/v1");
  assert.deepEqual(config.limits, {
    reviewMaxRequests: DEFAULT_REVIEW_MAX_REQUESTS,
    reviewMaxTokens: DEFAULT_REVIEW_MAX_TOKENS,
    dailyMaxTokens: undefined,
  });
  assert.equal(loadConfig({ ...ENV, GATEWAY_DAILY_MAX_TOKENS: "500" }).limits.dailyMaxTokens, 500);
});

test("fails at startup, naming the variable, on a setup that would break the first review", () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ LLM_PROVIDER: "mistral" }, /LLM_PROVIDER must be one of/],
    [{ LLM_MODEL: "" }, /LLM_MODEL is required/],
    [{ LLM_API_KEY: "" }, /LLM_API_KEY is required/],
    [{ LLM_BASE_URL: "file:///etc/passwd" }, /LLM_BASE_URL must be an http\(s\) URL/],
    [{ LLM_BASE_URL: "" }, /LLM_PROVIDER=openai-compatible needs LLM_BASE_URL/],
    [{ LLM_PROVIDER: "openai" }, /takes no LLM_BASE_URL.*openai-compatible/],
    [{ GATEWAY_SECRET: "short" }, /GATEWAY_SECRET must be at least 32/],
    [{ GATEWAY_REVIEW_MAX_TOKENS: "-1" }, /GATEWAY_REVIEW_MAX_TOKENS must be a positive integer/],
  ];
  for (const [override, message] of cases) assert.throws(() => loadConfig({ ...ENV, ...override }), message);
});
