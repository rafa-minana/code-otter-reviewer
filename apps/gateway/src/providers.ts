// Everything the gateway knows about each LLM vendor, mirroring how the AI SDK calls it (apps/reviewer/src/llm.ts).
import type { LlmProviderName } from "@otter/contracts";
import { QUOTA_RETRY_AFTER_SECONDS } from "./constants.js";

export interface Provider {
  /** Whether LLM_BASE_URL may (optional), must (required) or must not (forbidden) be set. */
  baseUrl: "optional" | "required" | "forbidden";
  /** Where requests go when LLM_BASE_URL isn't set; none when it is required. */
  defaultUpstream?: string;
  /** The AI SDK sends the key in this header: the review token arrives there, the real key leaves there. */
  readToken(headers: Headers): string | undefined;
  authHeaders(apiKey: string): Record<string, string>;
  /** The one path the reviewer calls; anything else is refused. */
  route(model: string): string;
  /** Whether the model travels in the body (and must be pinned there) or in the route. */
  modelInBody: boolean;
  /** Tokens billed for a successful response, from the provider's own usage report. */
  tokensUsed(body: unknown): number;
  /** An error in the provider's own shape, so the AI SDK surfaces our message as-is. */
  errorBody(status: number, message: string): unknown;
  /** The error means no credit or quota is left (daily, monthly, balance): retrying can't fix it. */
  quotaExhausted(status: number, body: unknown): boolean;
}

const count = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
const field = (o: unknown, key: string): unknown =>
  typeof o === "object" && o !== null
    ? (o as Record<string, unknown>)[key]
    : undefined;
const errorField = (body: unknown, key: string) =>
  field(field(body, "error"), key);
const bearer = (headers: Headers) =>
  /^Bearer (.+)$/.exec(headers.get("authorization") ?? "")?.[1];

const ANTHROPIC_ERROR_TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  429: "rate_limit_error",
};
const GOOGLE_ERROR_STATUSES: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  413: "INVALID_ARGUMENT",
  429: "RESOURCE_EXHAUSTED",
  502: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED",
};

/** OpenAI's own API; "openai-compatible" below is the same protocol on someone else's server. */
const OPENAI: Provider = {
  baseUrl: "forbidden",
  defaultUpstream: "https://api.openai.com/v1",
  readToken: bearer,
  authHeaders: (key) => ({ authorization: `Bearer ${key}` }),
  route: () => "/chat/completions",
  modelInBody: true,
  tokensUsed: (body) => {
    const usage = field(body, "usage");
    return (
      count(field(usage, "total_tokens")) ||
      count(field(usage, "prompt_tokens")) +
        count(field(usage, "completion_tokens"))
    );
  },
  errorBody: (status, message) => ({
    error: { message, type: "otter_gateway", code: String(status) },
  }),
  // 402: no credit left (OpenRouter). insufficient_quota: OpenAI's billing quota.
  // "per-day": OpenRouter's free-models-per-day (its free-models-per-min stays retryable).
  quotaExhausted: (status, body) =>
    status === 402 ||
    (status === 429 &&
      (errorField(body, "code") === "insufficient_quota" ||
        errorField(body, "type") === "insufficient_quota" ||
        /per-day/i.test(String(errorField(body, "message") ?? "")))),
};

export const PROVIDERS: Record<LlmProviderName, Provider> = {
  anthropic: {
    baseUrl: "optional",
    defaultUpstream: "https://api.anthropic.com/v1",
    readToken: (h) => h.get("x-api-key") ?? undefined,
    authHeaders: (key) => ({ "x-api-key": key }),
    route: () => "/messages",
    modelInBody: true,
    tokensUsed: (body) => {
      const usage = field(body, "usage");
      return [
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
      ]
        .map((k) => count(field(usage, k)))
        .reduce((a, b) => a + b, 0);
    },
    errorBody: (status, message) => ({
      type: "error",
      error: { type: ANTHROPIC_ERROR_TYPES[status] ?? "api_error", message },
    }),
    // 402 billing_error: no credit. 400: credit balance too low, or the monthly spend limit reached.
    quotaExhausted: (status, body) =>
      status === 402 ||
      (status === 400 &&
        /credit balance|usage limits/i.test(String(errorField(body, "message") ?? ""))),
  },
  openai: OPENAI,
  // Same protocol, someone else's server: OpenRouter, Groq, Together, DeepSeek, Ollama, LM Studio…
  "openai-compatible": { ...OPENAI, baseUrl: "required", defaultUpstream: undefined },
  gemini: {
    baseUrl: "optional",
    defaultUpstream: "https://generativelanguage.googleapis.com/v1beta",
    readToken: (h) => h.get("x-goog-api-key") ?? undefined,
    authHeaders: (key) => ({ "x-goog-api-key": key }),
    // Same rule as the AI SDK's getModelPath: ids with a "/" (tunedModels/…) are already a path.
    route: (model) =>
      `/${model.includes("/") ? model : `models/${model}`}:generateContent`,
    modelInBody: false,
    tokensUsed: (body) =>
      count(field(field(body, "usageMetadata"), "totalTokenCount")),
    errorBody: (status, message) => ({
      error: {
        code: status,
        message,
        status: GOOGLE_ERROR_STATUSES[status] ?? "INTERNAL",
      },
    }),
    // A daily quota names itself in the QuotaFailure details, e.g. GenerateRequestsPerDayPerProjectPerModel.
    quotaExhausted: (status, body) =>
      status === 429 && /PerDay/.test(JSON.stringify(errorField(body, "details") ?? "")),
  },
};

/** The provider's own rule, or any 429 asking to wait longer than a review lives (e.g. Anthropic's tokens per day). */
export function quotaExhausted(
  provider: Provider,
  status: number,
  body: unknown,
  headers: Headers,
): boolean {
  return (
    provider.quotaExhausted(status, body) ||
    (status === 429 && retryAfterSeconds(headers) > QUOTA_RETRY_AFTER_SECONDS)
  );
}

/**
 * Seconds until an exhausted quota resets, when the provider says: its `retry-after`, or OpenRouter's
 * `X-RateLimit-Reset` (epoch ms) in the error's metadata. Undefined when unknown.
 */
export function quotaResetSeconds(
  body: unknown,
  headers: Headers,
  now = Date.now(),
): number | undefined {
  const retryAfter = retryAfterSeconds(headers, now);
  if (retryAfter > 0) return Math.ceil(retryAfter);
  const reset = Number(
    field(field(errorField(body, "metadata"), "headers"), "X-RateLimit-Reset"),
  );
  return reset > now ? Math.ceil((reset - now) / 1000) : undefined;
}

/** `retry-after` in seconds or as an HTTP date; 0 when absent or unreadable. */
function retryAfterSeconds(headers: Headers, now = Date.now()): number {
  const value = headers.get("retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds;
  const at = Date.parse(value);
  return Number.isNaN(at) ? 0 : (at - now) / 1000;
}

/** The provider's own error message, kept when the gateway turns its error into ours. */
export const providerMessage = (body: unknown): string =>
  String(errorField(body, "message") ?? "no message");

/**
 * Where the gateway sends requests: LLM_BASE_URL or the vendor's own API, as the provider's rule allows.
 * Strict on purpose: "openai" with a base URL or "openai-compatible" without one is a setup mistake.
 */
export function upstreamBase(provider: LlmProviderName, baseUrl: string | undefined): string {
  const { baseUrl: rule, defaultUpstream } = PROVIDERS[provider];
  if (rule === "forbidden" && baseUrl)
    throw new Error(
      `LLM_PROVIDER=${provider} is ${provider}'s own API and takes no LLM_BASE_URL; for OpenRouter, Ollama or another OpenAI-compatible API use LLM_PROVIDER=openai-compatible`,
    );
  if (!baseUrl) {
    if (!defaultUpstream)
      throw new Error(`LLM_PROVIDER=${provider} needs LLM_BASE_URL, e.g. https://openrouter.ai/api/v1`);
    return defaultUpstream;
  }
  const base = baseUrl.replace(/\/+$/, "");
  // Like the AI SDK: the bare Anthropic host means its versioned API.
  return provider === "anthropic" && base === "https://api.anthropic.com" ? `${base}/v1` : base;
}
