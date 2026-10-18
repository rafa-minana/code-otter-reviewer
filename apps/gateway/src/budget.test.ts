import { test } from "node:test";
import assert from "node:assert/strict";
import { createBudget } from "./budget.js";
import { MAX_INFLIGHT_PER_REVIEW } from "./constants.js";

const grant = (id = "1", expiresAt = 1_000) => ({ reviewId: id, budgetKey: `${id}.${expiresAt}`, expiresAt });
const clock = (start = 0) => {
  let t = start;
  return { now: () => t, set: (v: number) => void (t = v) };
};

test("a review attempt is cut off at its request budget", () => {
  const b = createBudget({ reviewMaxRequests: 2, reviewMaxTokens: 1e9 });
  const g = grant();
  for (let i = 0; i < 2; i++) {
    assert.equal(b.admit(g), null);
    b.settle(g, 1);
  }
  assert.deepEqual(b.admit(g), { status: 403, message: "review budget exhausted (2 requests)" });
  assert.equal(b.admit(grant("2")), null, "another attempt has its own budget");
});

test("a review attempt is cut off once its tokens reach the budget", () => {
  const b = createBudget({ reviewMaxRequests: 100, reviewMaxTokens: 1000 });
  const g = grant();
  assert.equal(b.admit(g), null);
  b.settle(g, 1000);
  assert.deepEqual(b.admit(g), { status: 403, message: "review budget exhausted (1000 tokens)" });
});

test("parallel requests per attempt are capped, and settling frees a slot", () => {
  const b = createBudget({ reviewMaxRequests: 100, reviewMaxTokens: 1e9 });
  const g = grant();
  for (let i = 0; i < MAX_INFLIGHT_PER_REVIEW; i++) assert.equal(b.admit(g), null);
  assert.equal(b.admit(g)?.status, 429);
  b.settle(g, 0);
  assert.equal(b.admit(g), null);
  assert.equal(b.usage(g).requests, MAX_INFLIGHT_PER_REVIEW + 1, "a refused request is not counted");
});

test("the daily cap stops every review and resets at 00:00 UTC", () => {
  const c = clock(Date.UTC(2026, 0, 1, 23, 59));
  const b = createBudget({ reviewMaxRequests: 100, reviewMaxTokens: 1e9, dailyMaxTokens: 500 }, c.now);
  assert.equal(b.admit(grant("1")), null);
  b.settle(grant("1"), 500);
  assert.match(b.admit(grant("2"))?.message ?? "", /daily token limit reached \(500\)/);
  c.set(Date.UTC(2026, 0, 2, 0, 1));
  assert.equal(b.admit(grant("2")), null);
});

test("sweep forgets expired attempts, but never one with a request in flight", () => {
  const c = clock(0);
  const b = createBudget({ reviewMaxRequests: 100, reviewMaxTokens: 1e9 }, c.now);
  const [done, busy] = [grant("1", 10), grant("2", 10)];
  b.admit(done);
  b.settle(done, 1);
  b.admit(busy);
  c.set(11);
  b.sweep();
  assert.equal(b.size, 1);
  b.settle(busy, 1);
  b.sweep();
  assert.equal(b.size, 0);
});
