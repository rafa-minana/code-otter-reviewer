import { loadConfig } from "./config.js";
import { ensureDocker, removeOrphanReviewers, runReviewer } from "./docker.js";
import { createLauncher, PORT } from "./server.js";

// The only process with the Docker socket: it starts reviewer containers for the worker, on its terms.
const cfg = loadConfig(process.env);
await ensureDocker(cfg);
await removeOrphanReviewers();
createLauncher(cfg, runReviewer).listen(PORT, () =>
  console.log(JSON.stringify({ launcher: `listening on :${PORT}`, ...cfg })),
);
