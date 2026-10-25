import { Hono, type Context } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import type { CleanupJob } from "@otter/contracts";
import { SAFE_NAME } from "../github/pull-request-event.js";
import { HTTP_STATUS } from "../http.js";
import type {
  PullRequestRef,
  RereviewOutcome,
} from "../queue/enqueue-rereview.js";
import type { EnqueueCleanup } from "./webhook.js";

/** pull_requests.number is a Postgres integer. */
const MAX_PR_NUMBER = 2 ** 31 - 1;

export interface AdminDeps {
  /** Unset: every /admin route answers 503. */
  adminToken?: string;
  status: () => Promise<unknown>;
  pullRequest: (pr: PullRequestRef) => Promise<unknown | null>;
  rereview: (pr: PullRequestRef) => Promise<RereviewOutcome>;
  enqueueCleanup: EnqueueCleanup;
  enqueueRepoCleanup: (job: Omit<CleanupJob, "number">) => Promise<void>;
  enqueueJanitor: () => Promise<void>;
}

/** ARCHITECTURE.md §9. Cleanups and the janitor go through the queue, so they never race a review. */
export function adminRoutes(deps: AdminDeps): Hono {
  const app = new Hono();
  if (!deps.adminToken)
    return app.all("/*", (c) =>
      c.text("admin disabled: set ADMIN_TOKEN", HTTP_STATUS.serviceUnavailable),
    );

  const accepted = (c: Context) => c.body(null, HTTP_STATUS.accepted);
  const badRequest = (c: Context) =>
    c.text(
      "invalid owner, repo or pull request number",
      HTTP_STATUS.badRequest,
    );

  return app
    .use("/*", bearerAuth({ token: deps.adminToken }))
    .get("/status", async (c) => c.json(await deps.status()))
    .post("/gc", async (c) => {
      await deps.enqueueJanitor();
      return accepted(c);
    })
    .get("/repos/:owner/:repo/pulls/:n", async (c) => {
      const pr = pullRequestParams(c);
      if (!pr) return badRequest(c);
      const state = await deps.pullRequest(pr);
      return state
        ? c.json(state)
        : c.text("unknown pull request", HTTP_STATUS.notFound);
    })
    .post("/repos/:owner/:repo/pulls/:n/review", async (c) => {
      const pr = pullRequestParams(c);
      if (!pr) return badRequest(c);
      const outcome = await deps.rereview(pr);
      const status =
        outcome === "queued"
          ? HTTP_STATUS.accepted
          : outcome === "unknown"
            ? HTTP_STATUS.notFound
            : HTTP_STATUS.conflict;
      return c.json({ outcome }, status);
    })
    .delete("/repos/:owner/:repo/pulls/:n", async (c) => {
      const pr = pullRequestParams(c);
      if (!pr) return badRequest(c);
      await deps.enqueueCleanup(pr);
      return accepted(c);
    })
    .delete("/repos/:owner/:repo", async (c) => {
      const repo = repoParams(c);
      if (!repo) return badRequest(c);
      await deps.enqueueRepoCleanup(repo);
      return accepted(c);
    });
}

/** owner/repo end up in `rm -rf` paths: same rule as the webhook. */
function repoParams(c: Context): Omit<CleanupJob, "number"> | undefined {
  const { owner, repo } = c.req.param();
  return SAFE_NAME.test(owner) && SAFE_NAME.test(repo)
    ? { owner, repo }
    : undefined;
}

function pullRequestParams(c: Context): PullRequestRef | undefined {
  const repo = repoParams(c);
  const raw = c.req.param("n");
  const number = Number(raw);
  return repo && /^[1-9]\d*$/.test(raw ?? "") && number <= MAX_PR_NUMBER
    ? { ...repo, number }
    : undefined;
}
