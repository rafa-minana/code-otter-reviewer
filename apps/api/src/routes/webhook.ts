import { Hono, type Context } from "hono";
import type { ReviewJob } from "@otter/contracts";
import { DEFAULT_BODY_LIMIT } from "../constraints/constraints.js";
import { decideWebhook, GITHUB_EVENTS } from "../github/pull-request-event.js";
import { verifySignature } from "../github/signature.js";
import { HTTP_STATUS } from "../http.js";

const GITHUB_HEADERS = {
  event: "x-github-event",
  signature: "x-hub-signature-256",
} as const;

export type EnqueueReview = (
  job: ReviewJob,
  delaySeconds: number,
) => Promise<void>;

export interface WebhookDeps {
  webhookSecret: string;
  enqueueReview: EnqueueReview;
}

export function webhookRoutes(deps: WebhookDeps): Hono {
  return new Hono().post("/", DEFAULT_BODY_LIMIT, (c) =>
    handleWebhook(c, deps),
  );
}

async function handleWebhook(c: Context, deps: WebhookDeps): Promise<Response> {
  const rawBody = new Uint8Array(await c.req.arrayBuffer());

  if (
    !verifySignature(
      deps.webhookSecret,
      rawBody,
      c.req.header(GITHUB_HEADERS.signature),
    )
  ) {
    return c.text("bad signature", HTTP_STATUS.unauthorized);
  }

  const event = c.req.header(GITHUB_HEADERS.event);
  if (event === GITHUB_EVENTS.ping) return c.text("pong", HTTP_STATUS.ok);

  const payload = parseJson(rawBody);
  if (payload === undefined)
    return c.text("invalid json", HTTP_STATUS.badRequest);

  const decision = decideWebhook(event, payload);

  switch (decision.kind) {
    case "ignore":
      return c.body(null, HTTP_STATUS.noContent);
    case "invalid":
      return c.text("invalid payload", HTTP_STATUS.badRequest);
    case "enqueue":
      // If this throws, Hono answers 500 and GitHub redelivers.
      await deps.enqueueReview(decision.job, decision.delaySeconds);
      return c.body(null, HTTP_STATUS.accepted);
  }
}

function parseJson(rawBody: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return undefined;
  }
}
