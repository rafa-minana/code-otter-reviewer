import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifySignature } from "./signature.js";

const SECRET = "test-secret";
const body = new TextEncoder().encode('{"a":1}');
const sign = (secret: string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

test("verifySignature accepts only the right HMAC", () => {
  assert.equal(verifySignature(SECRET, body, sign(SECRET)), true);
  assert.equal(verifySignature(SECRET, body, sign("other-secret")), false);
  assert.equal(verifySignature(SECRET, body, undefined), false);
  assert.equal(verifySignature(SECRET, body, "sha256=abc"), false);
});
