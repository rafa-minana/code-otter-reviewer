import { Hono } from "hono";
import { HTTP_STATUS } from "../http.js";

/** /admin endpoints arrive in v3 (ARCHITECTURE.md §9). */
export function adminRoutes(): Hono {
  return new Hono().all("/*", (c) =>
    c.text("not implemented", HTTP_STATUS.notImplemented),
  );
}
