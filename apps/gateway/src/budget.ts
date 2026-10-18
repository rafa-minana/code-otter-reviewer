import { HTTP_STATUS, MAX_INFLIGHT_PER_REVIEW } from "./constants.js";
import type { ReviewGrant } from "./token.js";

export interface BudgetLimits {
  reviewMaxRequests: number;
  reviewMaxTokens: number;
  /** Emergency brake on the bill; undefined means no daily cap. */
  dailyMaxTokens?: number;
}

export interface Denial {
  status: typeof HTTP_STATUS.forbidden | typeof HTTP_STATUS.tooManyRequests;
  message: string;
}

interface Attempt {
  requests: number;
  tokens: number;
  inFlight: number;
  expiresAt: number;
}

/** One limit: when it's broken, the request is refused with `status` and `message`. */
interface Rule extends Denial {
  isBroken: (attempt: Attempt, dailyTokens: number) => boolean;
}

/** What `admit` checks, in order; the first broken rule is the answer. */
const rulesFor = (limits: BudgetLimits): Rule[] => [
  {
    isBroken: (_, dailyTokens) => limits.dailyMaxTokens !== undefined && dailyTokens >= limits.dailyMaxTokens,
    status: HTTP_STATUS.forbidden,
    message: `daily token limit reached (${limits.dailyMaxTokens}); it resets at 00:00 UTC`,
  },
  {
    isBroken: (a) => a.requests >= limits.reviewMaxRequests,
    status: HTTP_STATUS.forbidden,
    message: `review budget exhausted (${limits.reviewMaxRequests} requests)`,
  },
  {
    isBroken: (a) => a.tokens >= limits.reviewMaxTokens,
    status: HTTP_STATUS.forbidden,
    message: `review budget exhausted (${limits.reviewMaxTokens} tokens)`,
  },
  {
    isBroken: (a) => a.inFlight >= MAX_INFLIGHT_PER_REVIEW,
    status: HTTP_STATUS.tooManyRequests, // retryable: a slot frees up as soon as a call ends
    message: `more than ${MAX_INFLIGHT_PER_REVIEW} requests at once for this review`,
  },
];

const newAttempt = (grant: ReviewGrant): Attempt => ({ requests: 0, tokens: 0, inFlight: 0, expiresAt: grant.expiresAt });
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Spend per review attempt and per UTC day. Requests are counted when admitted and tokens when settled,
 * so the in-flight cap is what keeps a burst of parallel calls from overshooting the token budget.
 * shortcut: in memory, so a gateway restart resets the counters; move to Postgres if spend must be exact.
 */
export function createBudget(limits: BudgetLimits, now: () => number = Date.now) {
  const rules = rulesFor(limits);
  const attempts = new Map<string, Attempt>();
  let day = utcDay(now());
  let dailyTokens = 0;
  const rollDay = () => {
    const today = utcDay(now());
    if (today !== day) [day, dailyTokens] = [today, 0];
  };

  return {
    /** Counts the request and marks it in flight, or says why it can't go out. */
    admit(grant: ReviewGrant): Denial | null {
      rollDay();
      const attempt = attempts.get(grant.budgetKey) ?? newAttempt(grant);
      const broken = rules.find((rule) => rule.isBroken(attempt, dailyTokens));
      if (broken) return { status: broken.status, message: broken.message };
      attempts.set(grant.budgetKey, { ...attempt, requests: attempt.requests + 1, inFlight: attempt.inFlight + 1 });
      return null;
    },

    /** The admitted request is over: adds what it cost (0 when it failed) and frees its in-flight slot. */
    settle(grant: ReviewGrant, tokens: number) {
      rollDay();
      const attempt = attempts.get(grant.budgetKey);
      if (attempt) attempts.set(grant.budgetKey, { ...attempt, inFlight: attempt.inFlight - 1, tokens: attempt.tokens + tokens });
      dailyTokens += tokens;
    },

    usage(grant: ReviewGrant) {
      const a = attempts.get(grant.budgetKey);
      return { requests: a?.requests ?? 0, tokens: a?.tokens ?? 0, dailyTokens };
    },

    /** Forgets expired attempts with nothing in flight, so memory stays flat. */
    sweep() {
      const t = now();
      for (const [key, a] of attempts) if (a.expiresAt <= t && a.inFlight === 0) attempts.delete(key);
    },

    get size() {
      return attempts.size;
    },
  };
}

export type Budget = ReturnType<typeof createBudget>;
