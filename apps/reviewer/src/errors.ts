import {
  QUOTA_EXHAUSTED_HEADER,
  REVIEWER_EXIT,
  type ReviewerFailure,
} from "@otter/contracts";
import { APICallError, RetryError } from "ai";

/** Saturated or unreachable provider: worth waiting minutes, not seconds. */
const OVERLOADED_STATUSES = new Set([502, 503, 529]);

/**
 * How the worker should treat this failure (REVIEWER_EXIT), from what the AI SDK already knows:
 * the gateway marks an exhausted quota (with when it resets, if known); any other non-retryable API
 * error (4xx: bad key or model, too big) is permanent; a saturated provider is overloaded; anything
 * else is transient.
 */
export function classify(err: unknown): {
  exitCode: number;
  failure?: ReviewerFailure;
} {
  const api = apiCallError(err);
  const headers = api?.responseHeaders ?? {};
  if (headers[QUOTA_EXHAUSTED_HEADER]) {
    const retryAfter = Number(headers["retry-after"]);
    return {
      exitCode: REVIEWER_EXIT.quota,
      failure: retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {},
    };
  }
  if (api?.statusCode !== undefined && OVERLOADED_STATUSES.has(api.statusCode))
    return { exitCode: REVIEWER_EXIT.overloaded };
  if (api?.isRetryable === false) return { exitCode: REVIEWER_EXIT.permanent };
  return { exitCode: REVIEWER_EXIT.transient };
}

/** The API error behind the SDK's retry wrapper or a `cause` chain, if any. */
function apiCallError(err: unknown, depth = 0): APICallError | undefined {
  if (APICallError.isInstance(err)) return err;
  if (depth > 5 || typeof err !== "object" || err === null) return undefined;
  const next = RetryError.isInstance(err) ? err.lastError : (err as { cause?: unknown }).cause;
  return apiCallError(next, depth + 1);
}
