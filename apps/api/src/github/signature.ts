import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PREFIX = "sha256=";
const SIGNATURE_ALGORITHM = "sha256";

/** GitHub's X-Hub-Signature-256: HMAC-SHA256 of the exact raw body. */
export function verifySignature(
  secret: string,
  rawBody: Uint8Array,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader) return false;

  const digest = createHmac(SIGNATURE_ALGORITHM, secret)
    .update(rawBody)
    .digest("hex");
  const expected = Buffer.from(SIGNATURE_PREFIX + digest);
  const received = Buffer.from(signatureHeader);

  // timingSafeEqual throws on different lengths, and the length leaks nothing.
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}
