import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { verifyReviewToken } from "@otter/gateway/token.js";
import { REVIEWER_EXIT, REVIEWER_LLM_ENV, type LaunchRequest } from "@otter/contracts";
import { launcherRunner, ReviewerError, reviewerEnv, reviewerError } from "./runner.js";

const SECRET = "s".repeat(32);
const cfg = { launcherUrl: "", gatewayUrl: "http://otter-gateway:8080", gatewaySecret: SECRET };
const SHA = "a".repeat(40);

test("the container talks to the gateway with this review's token, never the real key, and gets nothing else", () => {
  const now = 1_700_000_000_000;
  const base = { PATH: "/bin", DATABASE_URL: "postgres://x", LLM_API_KEY: "sk-real", LLM_BASE_URL: "https://openrouter.ai/api/v1", LLM_MODEL: "m" };
  const env = reviewerEnv(cfg, "7", base, now);
  assert.equal(env.LLM_BASE_URL, "http://otter-gateway:8080");
  assert.equal(verifyReviewToken(SECRET, env.LLM_API_KEY!, now)?.reviewId, "7");
  assert.ok(!Object.values(env).includes("sk-real"));
  assert.equal(env.LLM_MODEL, "m", "the rest of the LLM settings still pass");
  assert.ok(Object.keys(env).every((k) => (REVIEWER_LLM_ENV as readonly string[]).includes(k)), "only LLM_* names");
});

test("a failed container keeps its exit code, so the worker knows whether to retry", () => {
  const permanent = reviewerError({ exitCode: REVIEWER_EXIT.permanent, stdout: "", stderr: "otter gateway: provider quota exhausted: free-models-per-day\n" });
  assert.equal(permanent.exitCode, REVIEWER_EXIT.permanent);
  assert.match(permanent.message, /^reviewer container failed \(exit 2\): otter gateway: provider quota exhausted/);
  const timedOut = reviewerError({ exitCode: null, stdout: "", stderr: "Command failed: docker run" });
  assert.equal(timedOut.exitCode, undefined, "a timeout is not a verdict: Graphile retries it");
});

test("a quota failure carries when it resets; anything unreadable on stdout is ignored", () => {
  const quota = reviewerError({ exitCode: REVIEWER_EXIT.quota, stdout: '{"retryAfterSeconds":3600}', stderr: "quota" });
  assert.equal(quota.exitCode, REVIEWER_EXIT.quota);
  assert.equal(quota.retryAfterSeconds, 3600);
  for (const stdout of ["", "{}", "not json", '{"retryAfterSeconds":-5}', '{"retryAfterSeconds":"1"}'])
    assert.equal(reviewerError({ exitCode: REVIEWER_EXIT.quota, stdout, stderr: "" }).retryAfterSeconds, undefined, stdout);
});

/** A fake launcher answering `status` + `body`; returns the runner and the requests it got. */
async function withLauncher(status: number, body: unknown, fn: (run: () => Promise<unknown>, got: LaunchRequest[]) => Promise<void>) {
  const got: LaunchRequest[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    got.push(JSON.parse(raw));
    res.writeHead(status).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const runner = launcherRunner({ ...cfg, launcherUrl: `http://127.0.0.1:${port}` }, "/var/otter");
  const request = { input: {} as never, finalAttempt: false };
  try {
    await fn(() => runner.runReviewer(request, `/var/otter/worktrees/acme/app/pr1/${SHA}`, "7"), got);
  } finally {
    server.close();
  }
}

test("the launcher gets the worktree relative to the data volume, and a clean exit returns the reviewer's JSON", () =>
  withLauncher(200, { exitCode: 0, stdout: '{"summary":"ok"}', stderr: "" }, async (run, got) => {
    assert.deepEqual(await run(), { summary: "ok" });
    assert.equal(got[0].worktree, `worktrees/acme/app/pr1/${SHA}`);
    assert.equal(got[0].reviewId, "7");
    assert.ok(got[0].env.LLM_API_KEY);
  }));

test("a failed container becomes a ReviewerError with its exit code and quota reset", () =>
  withLauncher(200, { exitCode: REVIEWER_EXIT.quota, stdout: '{"retryAfterSeconds":60}', stderr: "quota" }, async (run) => {
    await assert.rejects(run(), (e: ReviewerError) => e.exitCode === REVIEWER_EXIT.quota && e.retryAfterSeconds === 60);
  }));

test("a busy or broken launcher is a retry, not a verdict", async () => {
  for (const [status, body] of [[429, { error: "too many" }], [200, { exitCode: 0, stdout: "not json", stderr: "" }]] as const)
    await withLauncher(status, body, async (run) => {
      await assert.rejects(run(), (e: ReviewerError) => e instanceof ReviewerError && e.exitCode === undefined);
    });
  const unreachable = launcherRunner({ ...cfg, launcherUrl: "http://127.0.0.1:1" }, "/var/otter");
  await assert.rejects(unreachable.runReviewer({ input: {} as never, finalAttempt: false }, "/var/otter/x", "7"), (e: ReviewerError) => e.exitCode === undefined);
});
