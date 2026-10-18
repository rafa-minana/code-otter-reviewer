import { LLM_PROVIDERS, type LlmProviderName } from "@otter/contracts";
import type { BudgetLimits } from "./budget.js";
import {
  DEFAULT_REVIEW_MAX_REQUESTS,
  DEFAULT_REVIEW_MAX_TOKENS,
} from "./constants.js";
import { upstreamBase } from "./providers.js";
import { assertGatewaySecret } from "./token.js";

export interface GatewayConfig {
  provider: LlmProviderName;
  model: string;
  apiKey: string;
  /** Provider base URL without trailing slash; the allowed route is appended to it. */
  upstream: string;
  secret: string;
  limits: BudgetLimits;
}

/** Fails at startup, with the variable's name, on anything that would only break at the first review. */
export function loadConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const provider = env.LLM_PROVIDER as LlmProviderName;
  if (!LLM_PROVIDERS.includes(provider))
    throw new Error(
      `LLM_PROVIDER must be one of ${LLM_PROVIDERS.join(", ")}; got "${env.LLM_PROVIDER ?? ""}"`,
    );
  if (!env.LLM_MODEL) throw new Error("LLM_MODEL is required");
  if (!env.LLM_API_KEY)
    throw new Error(
      "LLM_API_KEY is required: the gateway is the only service that holds it",
    );
  return {
    provider,
    model: env.LLM_MODEL,
    apiKey: env.LLM_API_KEY,
    upstream: upstreamBase(provider, httpUrl(env.LLM_BASE_URL)),
    secret: assertGatewaySecret(env.GATEWAY_SECRET),
    limits: {
      reviewMaxRequests:
        positiveInt(env, "GATEWAY_REVIEW_MAX_REQUESTS") ??
        DEFAULT_REVIEW_MAX_REQUESTS,
      reviewMaxTokens:
        positiveInt(env, "GATEWAY_REVIEW_MAX_TOKENS") ??
        DEFAULT_REVIEW_MAX_TOKENS,
      dailyMaxTokens: positiveInt(env, "GATEWAY_DAILY_MAX_TOKENS"),
    },
  };
}

function httpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = URL.parse(value);
  if (url?.protocol !== "http:" && url?.protocol !== "https:")
    throw new Error(`LLM_BASE_URL must be an http(s) URL, got "${value}"`);
  return value;
}

/** Unset or empty means "use the default"; anything else must be a positive integer. */
function positiveInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = env[name];
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  return n;
}
