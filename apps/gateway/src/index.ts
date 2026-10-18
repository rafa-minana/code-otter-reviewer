import { serve } from "@hono/node-server";
import { createGateway } from "./app.js";
import { createBudget } from "./budget.js";
import { loadConfig } from "./config.js";
import { PORT, SHUTDOWN_GRACE_MS, SWEEP_INTERVAL_MS } from "./constants.js";

const config = loadConfig(process.env);
const budget = createBudget(config.limits);
const app = createGateway({ config, budget });

const server = serve({ fetch: app.fetch, port: PORT }, ({ port }) =>
  // Never the key: provider, model and where requests go are enough to check the setup.
  console.log(
    JSON.stringify({
      gateway: `listening on :${port}`,
      provider: config.provider,
      model: config.model,
      upstream: new URL(config.upstream).origin,
      limits: config.limits,
    }),
  ),
);
setInterval(() => budget.sweep(), SWEEP_INTERVAL_MS).unref();

// Stop taking requests and let the in-flight ones finish; a review step cut short is retried by the SDK.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  });
}
