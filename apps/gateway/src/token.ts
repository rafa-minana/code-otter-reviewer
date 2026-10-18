// Review tokens: what a reviewer container holds instead of the LLM key. Minted by the worker,
// checked by the gateway; the shared GATEWAY_SECRET is all they need, so there's no token store.
import { createHmac, timingSafeEqual } from "node:crypto";
import { GATEWAY_SECRET_MIN_LENGTH, REVIEW_TOKEN_TTL_MS } from "./constants.js";

const PREFIX = "otter";
const TOKEN_PATTERN = /^otter\.(\d+)\.(\d+)\.([A-Za-z0-9_-]+)$/;

export interface ReviewGrant {
  reviewId: string;
  /** One per attempt: a retried review mints a new token, so it gets a fresh budget. */
  budgetKey: string;
  expiresAt: number;
}

const sign = (secret: string, payload: string) =>
  createHmac("sha256", secret).update(payload).digest("base64url");

export function assertGatewaySecret(secret: string | undefined): string {
  if (!secret || secret.length < GATEWAY_SECRET_MIN_LENGTH) {
    throw new Error(
      `GATEWAY_SECRET must be at least ${GATEWAY_SECRET_MIN_LENGTH} characters (generate one with \`openssl rand -hex 32\`)`,
    );
  }
  return secret;
}

/** `otter.<reviewId>.<expiresAtMs>.<HMAC-SHA256 of "<reviewId>.<expiresAtMs>">` */
export function mintReviewToken(
  secret: string,
  reviewId: string,
  now = Date.now(),
): string {
  if (!/^\d+$/.test(reviewId))
    throw new Error(`review id must be numeric, got "${reviewId}"`);
  const payload = `${reviewId}.${now + REVIEW_TOKEN_TTL_MS}`;
  return `${PREFIX}.${payload}.${sign(secret, payload)}`;
}

/** The grant, or null when the token is malformed, forged or expired. */
export function verifyReviewToken(
  secret: string,
  token: string | undefined,
  now = Date.now(),
): ReviewGrant | null {
  const match = TOKEN_PATTERN.exec(token ?? "");
  if (!match) return null;
  const [, reviewId, expires, signature] = match;
  const payload = `${reviewId}.${expires}`;
  const expected = Buffer.from(sign(secret, payload));
  const received = Buffer.from(signature);
  // timingSafeEqual throws on different lengths, and the length leaks nothing.
  if (
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  )
    return null;
  const expiresAt = Number(expires);
  return expiresAt > now ? { reviewId, budgetKey: payload, expiresAt } : null;
}
