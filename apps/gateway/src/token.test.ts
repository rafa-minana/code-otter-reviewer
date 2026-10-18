import { test } from "node:test";
import assert from "node:assert/strict";
import { REVIEW_TOKEN_TTL_MS } from "./constants.js";
import { assertGatewaySecret, mintReviewToken, verifyReviewToken } from "./token.js";

const SECRET = "s".repeat(32);
const NOW = 1_700_000_000_000;

test("a minted token verifies until it expires, with one budget per attempt", () => {
  const token = mintReviewToken(SECRET, "42", NOW);
  assert.match(token, /^otter\.42\.\d+\.[\w-]+$/);
  assert.deepEqual(verifyReviewToken(SECRET, token, NOW), {
    reviewId: "42",
    budgetKey: `42.${NOW + REVIEW_TOKEN_TTL_MS}`,
    expiresAt: NOW + REVIEW_TOKEN_TTL_MS,
  });
  assert.equal(verifyReviewToken(SECRET, token, NOW + REVIEW_TOKEN_TTL_MS), null, "expired");
  assert.notEqual(verifyReviewToken(SECRET, mintReviewToken(SECRET, "42", NOW + 1), NOW)?.budgetKey, `42.${NOW + REVIEW_TOKEN_TTL_MS}`);
});

test("forged, tampered, foreign or malformed tokens are rejected", () => {
  const token = mintReviewToken(SECRET, "42", NOW);
  const [prefix, id, exp, sig] = token.split(".");
  for (const bad of [
    `${prefix}.43.${exp}.${sig}`, // another review
    `${prefix}.${id}.${Number(exp) + 60_000}.${sig}`, // longer life
    `${prefix}.${id}.${exp}.${sig.slice(0, -1)}`, // truncated signature
    mintReviewToken("t".repeat(32), "42", NOW), // another secret
    `Bearer ${token}`,
    `${token}.extra`,
    "otter.42.1.",
    "",
    undefined,
  ]) {
    assert.equal(verifyReviewToken(SECRET, bad, NOW), null, String(bad));
  }
});

test("only numeric review ids are minted, and the secret must be long enough", () => {
  assert.throws(() => mintReviewToken(SECRET, "4.2", NOW), /numeric/);
  assert.throws(() => assertGatewaySecret("short"), /at least 32 characters/);
  assert.throws(() => assertGatewaySecret(undefined), /GATEWAY_SECRET/);
  assert.equal(assertGatewaySecret(SECRET), SECRET);
});
