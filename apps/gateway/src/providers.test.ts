import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS, upstreamBase } from "./providers.js";

const { anthropic, openai, gemini } = PROVIDERS;

test("each provider allows only the route its AI SDK provider calls", () => {
  assert.equal(anthropic.route("claude-x"), "/messages");
  assert.equal(openai.route("nvidia/nemotron:free"), "/chat/completions");
  assert.equal(gemini.route("gemini-2.5-pro"), "/models/gemini-2.5-pro:generateContent");
  assert.equal(gemini.route("tunedModels/mine"), "/tunedModels/mine:generateContent");
});

test("the upstream is LLM_BASE_URL when set, else the vendor's; bare Anthropic gets /v1 like the SDK", () => {
  assert.equal(upstreamBase("openai", undefined), "https://api.openai.com/v1");
  assert.equal(upstreamBase("openai-compatible", "https://openrouter.ai/api/v1/"), "https://openrouter.ai/api/v1");
  assert.equal(upstreamBase("anthropic", "https://api.anthropic.com"), "https://api.anthropic.com/v1");
  assert.equal(upstreamBase("gemini", undefined), "https://generativelanguage.googleapis.com/v1beta");
});

test("strict about the two OpenAI flavours: OpenAI takes no base URL, a compatible API needs one", () => {
  assert.throws(() => upstreamBase("openai", "https://openrouter.ai/api/v1"), /use LLM_PROVIDER=openai-compatible/);
  assert.throws(() => upstreamBase("openai-compatible", undefined), /needs LLM_BASE_URL/);
});

test("openai-compatible speaks exactly OpenAI's protocol", () => {
  const { baseUrl, defaultUpstream, ...protocol } = PROVIDERS["openai-compatible"];
  const { baseUrl: _b, defaultUpstream: _d, ...openaiProtocol } = openai;
  assert.deepEqual(protocol, openaiProtocol);
  assert.deepEqual([baseUrl, defaultUpstream], ["required", undefined]);
});

test("the token is read from, and the key written to, the header each SDK uses", () => {
  assert.equal(anthropic.readToken(new Headers({ "x-api-key": "t" })), "t");
  assert.equal(openai.readToken(new Headers({ authorization: "Bearer t" })), "t");
  assert.equal(openai.readToken(new Headers({ authorization: "Basic t" })), undefined);
  assert.equal(gemini.readToken(new Headers({ "x-goog-api-key": "t" })), "t");
  assert.deepEqual(openai.authHeaders("k"), { authorization: "Bearer k" });
  assert.deepEqual(anthropic.authHeaders("k"), { "x-api-key": "k" });
  assert.deepEqual(gemini.authHeaders("k"), { "x-goog-api-key": "k" });
});

test("tokens used come from each provider's usage report; anything odd counts as 0", () => {
  assert.equal(
    anthropic.tokensUsed({ usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 3 } }),
    128,
  );
  assert.equal(openai.tokensUsed({ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }), 120);
  assert.equal(openai.tokensUsed({ usage: { prompt_tokens: 100, completion_tokens: 20 } }), 120);
  assert.equal(gemini.tokensUsed({ usageMetadata: { totalTokenCount: 77 } }), 77);
  for (const p of [anthropic, openai, gemini]) {
    for (const odd of [null, {}, { usage: "x" }, { usage: { total_tokens: -5 } }]) assert.equal(p.tokensUsed(odd), 0);
  }
});

test("errors take each provider's shape, so the AI SDK shows our message", () => {
  assert.deepEqual(anthropic.errorBody(403, "m"), { type: "error", error: { type: "permission_error", message: "m" } });
  assert.deepEqual(openai.errorBody(403, "m"), { error: { message: "m", type: "otter_gateway", code: "403" } });
  assert.deepEqual(gemini.errorBody(403, "m"), { error: { code: 403, message: "m", status: "PERMISSION_DENIED" } });
});
