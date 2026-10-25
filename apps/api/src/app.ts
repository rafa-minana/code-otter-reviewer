import { Hono } from "hono";
import { HTTP_STATUS } from "./http.js";
import { adminRoutes, type AdminDeps } from "./routes/admin.js";
import { webhookRoutes, type WebhookDeps } from "./routes/webhook.js";

export type AppDeps = WebhookDeps & AdminDeps;

/** Public port: only what GitHub needs. */
export function createApp(deps: WebhookDeps): Hono {
  return new Hono()
    .get("/health", (c) => c.text("ok", HTTP_STATUS.ok))
    .route("/webhook", webhookRoutes(deps));
}

/** Its own port, published on 127.0.0.1 only: /admin never shares the webhook's public port. */
export function createAdminApp(deps: AdminDeps): Hono {
  return new Hono().route("/admin", adminRoutes(deps));
}
