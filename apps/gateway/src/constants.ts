// Gateway tuning knobs (ARCHITECTURE.md §5, "Gateway del LLM").

export const PORT = 8080;

/** A review step resends the whole conversation (diff + tool results): a few hundred KB, never 10 MB. */
export const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** Above the reviewer's 250 s per step, so the reviewer's own timeout always fires first. */
export const UPSTREAM_TIMEOUT_MS = 5 * 60_000;

/** The reviewer container lives 15 min at most; the margin covers clock skew and the last response. */
export const REVIEW_TOKEN_TTL_MS = 20 * 60_000;
export const GATEWAY_SECRET_MIN_LENGTH = 32;

/** Worst real case: 3 chunks × (11 review + 11 verify steps) = 66 calls, plus the SDK's retries. */
export const DEFAULT_REVIEW_MAX_REQUESTS = 150;
export const DEFAULT_REVIEW_MAX_TOKENS = 3_000_000;
/** A review runs at most 3 chunk calls at once; more is a runaway or abusive reviewer. */
export const MAX_INFLIGHT_PER_REVIEW = 4;
export const SWEEP_INTERVAL_MS = 60_000;
export const SHUTDOWN_GRACE_MS = 30_000;

/** Request headers that reach the provider; everything else (the review token included) is dropped. */
export const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "anthropic-version",
  "anthropic-beta",
  "user-agent",
];
/** Response headers that reach the reviewer: what the AI SDK reads (retry hints) and what helps debugging. */
export const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "retry-after",
  "retry-after-ms",
  "request-id",
  "x-request-id",
];

export const HTTP_STATUS = {
  ok: 200,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403, // never retried by the AI SDK: right for "this will not work again"
  notFound: 404,
  payloadTooLarge: 413,
  tooManyRequests: 429, // retried by the AI SDK
  badGateway: 502,
  gatewayTimeout: 504,
} as const;
