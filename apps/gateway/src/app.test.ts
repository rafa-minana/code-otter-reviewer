import { test } from "node:test";
import assert from "node:assert/strict";
import type { LlmProviderName } from "@otter/contracts";
import { createGateway } from "./app.js";
import { createBudget } from "./budget.js";
import type { GatewayConfig } from "./config.js";
import { MAX_INFLIGHT_PER_REVIEW, MAX_REQUEST_BYTES } from "./constants.js";
import { upstreamBase } from "./providers.js";
import { mintReviewToken } from "./token.js";

const SECRET = "s".repeat(32);
const KEY = "sk-real-provider-key";
const MODEL = "nvidia/nemotron-3-super-120b-a12b:free";
const NOW = 1_700_000_000_000;

interface Upstream {
  url: string;
  init: RequestInit;
}

/** A gateway over a fake provider that records each call and answers with `reply`. */
function setup(opts: {
  provider?: LlmProviderName;
  model?: string;
  reply?: (call: Upstream) => Response | Promise<Response>;
  limits?: Partial<GatewayConfig["limits"]>;
} = {}) {
  const provider = opts.provider ?? "openai-compatible";
  const config: GatewayConfig = {
    provider,
    model: opts.model ?? MODEL,
    apiKey: KEY,
    upstream: upstreamBase(provider, provider === "openai-compatible" ? "https://openrouter.ai/api/v1" : undefined),
    secret: SECRET,
    limits: { reviewMaxRequests: 150, reviewMaxTokens: 3_000_000, ...opts.limits },
  };
  const calls: Upstream[] = [];
  const logs: string[] = [];
  const reply = opts.reply ?? (() => Response.json({ choices: [], usage: { total_tokens: 1000 } }, { headers: { "x-request-id": "req-1", "set-cookie": "a=b" } }));
  const app = createGateway({
    config,
    budget: createBudget(config.limits, () => NOW),
    now: () => NOW,
    log: (e) => void logs.push(JSON.stringify(e)),
    fetch: async (url, init) => {
      const call = { url: String(url), init: init ?? {} };
      calls.push(call);
      return reply(call);
    },
  });
  return { app, calls, logs };
}

const token = (id = "7") => mintReviewToken(SECRET, id, NOW);
const chat = (overrides: Record<string, unknown> = {}) => JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "secret code" }], ...overrides });
const post = (app: ReturnType<typeof setup>["app"], opts: { path?: string; body?: string; headers?: Record<string, string> } = {}) =>
  app.request(opts.path ?? "/chat/completions", {
    method: "POST",
    body: opts.body ?? chat(),
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json", ...opts.headers },
  });
const errorMessage = async (res: Response) => ((await res.json()) as { error: { message: string } }).error.message;

test("forwards the reviewer's call with the real key in place of its token, to the fixed URL", async () => {
  const { app, calls } = setup();
  const res = await post(app, { headers: { cookie: "x=1", "x-forwarded-for": "1.2.3.4", "anthropic-beta": "b" } });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
  const sent = new Headers(init.headers);
  assert.equal(sent.get("authorization"), `Bearer ${KEY}`);
  assert.deepEqual([...sent.keys()].sort(), ["anthropic-beta", "authorization", "content-type"]);
  assert.equal(init.redirect, "error");
  assert.equal(new TextDecoder().decode(init.body as ArrayBuffer), chat());
  assert.equal(res.headers.get("x-request-id"), "req-1");
  assert.equal(res.headers.get("set-cookie"), null, "only allow-listed response headers come back");
});

test("anthropic and gemini: the token comes in, and the key goes out, in their own header", async () => {
  const a = setup({ provider: "anthropic", reply: () => Response.json({ usage: { input_tokens: 1 } }) });
  const ra = await a.app.request("/messages", { method: "POST", body: chat(), headers: { "x-api-key": token() } });
  assert.equal(ra.status, 200);
  assert.equal(new Headers(a.calls[0].init.headers).get("x-api-key"), KEY);
  assert.equal(a.calls[0].url, "https://api.anthropic.com/v1/messages");

  const g = setup({ provider: "gemini", model: "gemini-2.5-pro", reply: () => Response.json({}) });
  const rg = await g.app.request("/models/gemini-2.5-pro:generateContent", { method: "POST", body: "{}", headers: { "x-goog-api-key": token() } });
  assert.equal(rg.status, 200);
  assert.equal(new Headers(g.calls[0].init.headers).get("x-goog-api-key"), KEY);
  assert.equal(g.calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent");
});

test("refuses, before reaching the provider, anything but the reviewer's exact call", async () => {
  const { app, calls } = setup();
  const cases: [string, Response | Promise<Response>, number, RegExp][] = [
    ["no token", post(app, { headers: { authorization: "" } }), 401, /review token/],
    ["forged token", post(app, { headers: { authorization: `Bearer ${token()}x` } }), 401, /review token/],
    ["the real key itself", post(app, { headers: { authorization: `Bearer ${KEY}` } }), 401, /review token/],
    ["another route", post(app, { path: "/embeddings" }), 404, /only POST \/chat\/completions/],
    ["a query string", post(app, { path: "/chat/completions?x=1" }), 404, /only POST/],
    ["an encoded path trick", post(app, { path: "/chat/completions%2F..%2Ffiles" }), 404, /only POST/],
    ["not JSON", post(app, { body: "nope" }), 400, /JSON object/],
    ["a JSON array", post(app, { body: "[]" }), 400, /JSON object/],
    ["another model", post(app, { body: chat({ model: "openai/gpt-5-pro" }) }), 403, /only the model/],
    ["streaming", post(app, { body: chat({ stream: true }) }), 400, /streaming/],
    ["too big", post(app, { body: "x".repeat(MAX_REQUEST_BYTES + 1) }), 413, /exceeds/],
    ["GET", app.request("/chat/completions"), 404, /only POST/],
  ];
  for (const [name, pending, status, message] of cases) {
    const res = await pending;
    assert.equal(res.status, status, name);
    assert.match(await errorMessage(res), new RegExp(`^otter gateway: .*${message.source}`), name);
  }
  assert.equal(calls.length, 0, "nothing reached the provider");
});

test("the budget counts what each response cost and cuts the review off with a non-retryable 403", async () => {
  const { app, calls } = setup({ limits: { reviewMaxTokens: 2500 } });
  for (let i = 0; i < 3; i++) assert.equal((await post(app)).status, 200); // 1000 tokens each
  const res = await post(app);
  assert.equal(res.status, 403);
  assert.equal(await errorMessage(res), "otter gateway: review budget exhausted (2500 tokens)");
  assert.equal(calls.length, 3);
  assert.equal((await post(app, { headers: { authorization: `Bearer ${token("8")}` } })).status, 200, "another review is unaffected");
});

test("more than MAX_INFLIGHT_PER_REVIEW parallel calls get a retryable 429", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { app } = setup({ reply: async () => (await gate, Response.json({ usage: { total_tokens: 1 } })) });
  const inFlight = Array.from({ length: MAX_INFLIGHT_PER_REVIEW }, () => post(app));
  const extra = await post(app);
  assert.equal(extra.status, 429);
  assert.equal(extra.headers.get("retry-after"), "1");
  release();
  assert.deepEqual((await Promise.all(inFlight)).map((r) => r.status), Array(MAX_INFLIGHT_PER_REVIEW).fill(200));
  assert.equal((await post(app)).status, 200, "the slots are free again");
});

test("provider errors pass through; unreachable is 502 and too slow is 504, and the slot is freed", async () => {
  const limited = setup({ reply: () => Response.json({ error: { message: "rate limited" } }, { status: 429, headers: { "retry-after": "7" } }) });
  const res = await post(limited.app);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "7");

  const down = setup({ reply: () => Promise.reject(new TypeError("fetch failed")) });
  assert.equal((await post(down.app)).status, 502);
  const slow = setup({ reply: () => Promise.reject(new DOMException("timed out", "TimeoutError")) });
  const timedOut = await post(slow.app);
  assert.equal(timedOut.status, 504);
  assert.match(await errorMessage(timedOut), /did not answer within/);
  for (let i = 0; i < MAX_INFLIGHT_PER_REVIEW; i++) assert.equal((await post(down.app)).status, 502, "never stuck at 429");
});

test("logs one line per request with ids and counts, never the token, the key or the body", async () => {
  const { app, logs } = setup();
  await post(app);
  await post(app, { path: "/embeddings" });
  assert.equal(logs.length, 2);
  assert.equal(JSON.parse(logs[1]).review, "7", "a refusal after a valid token is attributed to its review");
  const first = JSON.parse(logs[0]);
  assert.deepEqual({ review: first.review, status: first.status, tokens: first.tokens, reviewTokens: first.reviewTokens }, { review: "7", status: 200, tokens: 1000, reviewTokens: 1000 });
  for (const line of logs) {
    for (const secret of [token(), KEY, "secret code"]) assert.ok(!line.includes(secret), line);
  }
});

test("healthz answers without a token and without calling the provider", async () => {
  const { app, calls } = setup();
  const res = await app.request("/healthz");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok");
  assert.equal(calls.length, 0);
});
