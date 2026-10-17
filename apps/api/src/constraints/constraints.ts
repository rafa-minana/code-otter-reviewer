import { bodyLimit } from "hono/body-limit";
import { HTTP_STATUS } from "../http.js";

/** GitHub caps webhook payloads at 25 MB; nothing we accept is larger. */
export const MAX_BODY_BYTES = 25 * 1024 * 1024;

export const DEFAULT_BODY_LIMIT = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) => c.text("payload too large", HTTP_STATUS.payloadTooLarge),
});
