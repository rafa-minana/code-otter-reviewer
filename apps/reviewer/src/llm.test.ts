import { test } from "node:test";
import assert from "node:assert/strict";
import { createLlm } from "./llm.js";

test("createLlm rejects unknown providers", () => {
  assert.throws(() => createLlm({ LLM_PROVIDER: "foo", LLM_MODEL: "m" }), /LLM_PROVIDER/);
  assert.throws(() => createLlm({ LLM_MODEL: "m" }), /LLM_PROVIDER/);
});

test("createLlm requires a model", () => {
  assert.throws(() => createLlm({ LLM_PROVIDER: "anthropic" }), /LLM_MODEL/);
});

test("createLlm validates LLM_REASONING", () => {
  const base = { LLM_PROVIDER: "openai", LLM_MODEL: "m", LLM_API_KEY: "k" };
  assert.throws(() => createLlm({ ...base, LLM_REASONING: "off" }), /LLM_REASONING/);
  assert.equal(typeof createLlm({ ...base, LLM_REASONING: "none" }).generate, "function");
});

test("createLlm accepts supported providers", () => {
  for (const p of ["anthropic", "openai", "gemini"]) {
    assert.equal(typeof createLlm({ LLM_PROVIDER: p, LLM_MODEL: "m", LLM_API_KEY: "k" }).generate, "function");
  }
});
