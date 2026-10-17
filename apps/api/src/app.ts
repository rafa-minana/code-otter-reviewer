import { Hono } from "hono";
import { HTTP_STATUS } from "./http.js";
import { adminRoutes } from "./routes/admin.js";
import { webhookRoutes, type WebhookDeps } from "./routes/webhook.js";

export type AppDeps = WebhookDeps;

export function createApp(deps: AppDeps): Hono {
  return new Hono()
    .get("/health", (c) => c.text("ok", HTTP_STATUS.ok))
    .route("/webhook", webhookRoutes(deps))
    .route("/admin", adminRoutes());
}
