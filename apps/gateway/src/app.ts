import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Budget } from "./budget.js";
import type { GatewayConfig } from "./config.js";
import {
  FORWARDED_REQUEST_HEADERS,
  FORWARDED_RESPONSE_HEADERS,
  HTTP_STATUS,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  UPSTREAM_TIMEOUT_MS,
} from "./constants.js";
import { PROVIDERS } from "./providers.js";
import { verifyReviewToken, type ReviewGrant } from "./token.js";

export interface GatewayDeps {
  config: GatewayConfig;
  budget: Budget;
  fetch?: typeof fetch;
  now?: () => number;
  /** One JSON line per request: ids, statuses, timings and token counts; never bodies, headers or keys. */
  log?: (entry: Record<string, unknown>) => void;
}

/** Thrown inside a request to answer with our own error, in the provider's shape. */
class Refusal {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly message: string,
    readonly headers: Record<string, string> = {},
  ) {}
}

/**
 * The reviewer's only way out of its internal network (ARCHITECTURE.md §5, "Gateway del LLM").
 * It accepts exactly the call the reviewer makes (one route, one model, a valid review token),
 * swaps the token for the real key, enforces the spend budget and counts what each response cost.
 */
export function createGateway(deps: GatewayDeps): Hono {
  const { config, budget, fetch: fetchUpstream = fetch, now = Date.now } = deps;
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const provider = PROVIDERS[config.provider];
  const route = provider.route(config.model);
  const upstreamUrl = config.upstream + route; // a fixed string: nothing from the request reaches the URL

  const refuse = (c: Context, r: Refusal) =>
    c.json(
      provider.errorBody(r.status, `otter gateway: ${r.message}`),
      r.status,
      r.headers,
    );

  /** Checks 3–4, once the token is valid: without one, nothing else about the gateway is revealed. */
  async function readCall(c: Context): Promise<ArrayBuffer> {
    const url = new URL(c.req.url);
    if (url.pathname !== route || url.search)
      throw new Refusal(HTTP_STATUS.notFound, `only POST ${route} is allowed`);
    const body = await c.req.arrayBuffer();
    const json = parseObject(body);
    if (!json)
      throw new Refusal(
        HTTP_STATUS.badRequest,
        "the body must be a JSON object",
      );
    if (provider.modelInBody && json.model !== config.model)
      throw new Refusal(
        HTTP_STATUS.forbidden,
        `only the model "${config.model}" is allowed`,
      );
    if (json.stream === true)
      throw new Refusal(HTTP_STATUS.badRequest, "streaming is not supported");
    return body;
  }

  async function forward(
    c: Context,
    body: ArrayBuffer,
  ): Promise<{ response: Response; tokens: number }> {
    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }
    for (const [name, value] of Object.entries(
      provider.authHeaders(config.apiKey),
    ))
      headers.set(name, value);

    let upstream: Response;
    let payload: Uint8Array<ArrayBuffer> | null;
    try {
      upstream = await fetchUpstream(upstreamUrl, {
        method: "POST",
        headers,
        body,
        redirect: "error", // a redirect would carry the key to wherever it points
        signal: AbortSignal.any([
          c.req.raw.signal,
          AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        ]),
      });
      payload = await readCapped(upstream, MAX_RESPONSE_BYTES);
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError")
        throw new Refusal(
          HTTP_STATUS.gatewayTimeout,
          `the provider did not answer within ${UPSTREAM_TIMEOUT_MS / 1000} s`,
        );
      throw new Refusal(HTTP_STATUS.badGateway, "could not reach the provider");
    }
    if (!payload)
      throw new Refusal(
        HTTP_STATUS.badGateway,
        `the provider's response exceeded ${MAX_RESPONSE_BYTES} bytes`,
      );

    const tokens = upstream.ok ? provider.tokensUsed(parseObject(payload)) : 0;
    const out = new Headers();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }
    return {
      response: new Response(payload, {
        status: upstream.status,
        headers: out,
      }),
      tokens,
    };
  }

  return new Hono()
    .get("/healthz", (c) => c.text("ok", HTTP_STATUS.ok))
    .get("/review", (c) => {
      const grant = verifyReviewToken(config.secret, provider.readToken(c.req.raw.headers), now());
      return c.json({ reviewId: grant!.reviewId });
    })
    .post(
      "*",
      bodyLimit({
        maxSize: MAX_REQUEST_BYTES,
        onError: (c) =>
          refuse(
            c,
            new Refusal(
              HTTP_STATUS.payloadTooLarge,
              `the body exceeds ${MAX_REQUEST_BYTES} bytes`,
            ),
          ),
      }),
      async (c) => {
        const started = now();
        let grant: ReviewGrant | undefined;
        try {
          grant =
            verifyReviewToken(
              config.secret,
              provider.readToken(c.req.raw.headers),
              now(),
            ) ?? undefined;
          if (!grant)
            throw new Refusal(
              HTTP_STATUS.unauthorized,
              "missing, invalid or expired review token",
            );
          const body = await readCall(c);
          const denial = budget.admit(grant);
          if (denial)
            throw new Refusal(
              denial.status,
              denial.message,
              denial.status === HTTP_STATUS.tooManyRequests
                ? { "retry-after": "1" }
                : {},
            );
          let result: Awaited<ReturnType<typeof forward>> | undefined;
          try {
            result = await forward(c, body);
          } finally {
            budget.settle(grant, result?.tokens ?? 0); // frees the in-flight slot even when forwarding failed
          }
          log(
            entry(grant, result.response.status, started, {
              tokens: result.tokens,
            }),
          );
          return result.response;
        } catch (err) {
          if (!(err instanceof Refusal)) throw err;
          log(entry(grant, err.status, started, { refused: err.message }));
          return refuse(c, err);
        }
      },
    )
    .all("*", (c) =>
      refuse(
        c,
        new Refusal(HTTP_STATUS.notFound, `only POST ${route} is allowed`),
      ),
    );

  function entry(
    grant: ReviewGrant | undefined,
    status: number,
    started: number,
    extra: Record<string, unknown>,
  ) {
    const usage = grant ? budget.usage(grant) : undefined;
    return {
      at: new Date(now()).toISOString(),
      review: grant?.reviewId ?? null,
      status,
      ms: now() - started,
      ...extra,
      ...(usage && {
        reviewRequests: usage.requests,
        reviewTokens: usage.tokens,
        dailyTokens: usage.dailyTokens,
      }),
    };
  }
}

function parseObject(
  bytes: ArrayBuffer | Uint8Array,
): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The whole body, or null once it passes `max` bytes (the rest is never read). */
async function readCapped(
  res: Response,
  max: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!res.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > max) return null; // leaving the loop cancels the stream
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
