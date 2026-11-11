import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { REVIEWER_LLM_ENV, type LaunchResult } from "@otter/contracts";
import { loadConfig } from "./config.js";
import { dockerRunArgs, supportsVolumeSubpath } from "./docker.js";
import { createLauncher, parseLaunchRequest, type Run } from "./server.js";

const cfg = { image: "code-otter-reviewer", network: "otter-reviewers", volume: "otter-data", maxReviewers: 1 };
const SHA = "a".repeat(40);
const WORKTREE = `worktrees/acme/app/pr1/${SHA}`;
const args = dockerRunArgs(cfg, WORKTREE, "otter-review-7");
const valueOf = (flag: string) => args[args.indexOf(flag) + 1];
const allValuesOf = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

test("the reviewer container gets the checkout read-only, as a subpath of the data volume, and nothing else", () => {
  assert.deepEqual(allValuesOf("--mount"), [
    `type=volume,src=otter-data,dst=/repo,volume-subpath=${WORKTREE},readonly`,
  ]);
  assert.ok(!args.includes("-v"), "no host bind mount");
  assert.equal(valueOf("--name"), "otter-review-7");
  assert.equal(args.at(-1), "code-otter-reviewer"); // the image goes last: nothing after it reaches the CLI
});

test("the container runs without privileges, on a read-only filesystem, with bounded resources", () => {
  for (const flag of ["--rm", "-i", "--read-only"]) assert.ok(args.includes(flag), flag);
  assert.equal(valueOf("--cap-drop"), "ALL");
  assert.equal(valueOf("--security-opt"), "no-new-privileges");
  assert.equal(valueOf("--pull"), "never");
  assert.equal(valueOf("--network"), "otter-reviewers");
  assert.ok(valueOf("--memory") && valueOf("--cpus") && valueOf("--pids-limit"));
});

test("only the LLM variables pass, by name: no value ever appears in the arguments", () => {
  assert.deepEqual(allValuesOf("-e"), REVIEWER_LLM_ENV);
  assert.ok(allValuesOf("-e").every((v) => /^LLM_[A-Z_]+$/.test(v)), "names only, never NAME=value");
});

const valid = { reviewId: "7", worktree: WORKTREE, env: { LLM_MODEL: "m" }, request: { finalAttempt: false } };

test("a valid request passes, keeping only the LLM variables", () => {
  const job = parseLaunchRequest({ ...valid, env: { LLM_MODEL: "m", DATABASE_URL: "x", LLM_API_KEY: 5, PATH: "/evil" } });
  assert.deepEqual(job?.env, { LLM_MODEL: "m" });
  assert.equal(job?.worktree, WORKTREE);
});

test("a request that could mount anything but a worktree, or rename another container, is refused", () => {
  const worktrees = [
    "/var/otter/" + WORKTREE, // absolute
    `worktrees/acme/app/pr1/../../../..`,
    `worktrees/../mirrors/pr1/${SHA}`,
    `worktrees/acme/../pr1/${SHA}`,
    `worktrees/acme/app,readonly=false/pr1/${SHA}`, // would add a --mount option
    `mirrors/acme/app.git`,
    `worktrees/acme/app/pr1/${SHA}/sub`,
    `worktrees/acme/app/pr1/${SHA.toUpperCase()}`,
  ];
  for (const worktree of worktrees) assert.equal(parseLaunchRequest({ ...valid, worktree }), undefined, worktree);
  for (const reviewId of ["", "7/../x", "7 --privileged", "abc", "1".repeat(21), 7])
    assert.equal(parseLaunchRequest({ ...valid, reviewId }), undefined, String(reviewId));
  for (const bad of [null, "x", { ...valid, env: null }, { ...valid, request: "x" }])
    assert.equal(parseLaunchRequest(bad), undefined, JSON.stringify(bad));
});

test("WORKER_CONCURRENCY caps the reviewers, default 1, and rejects nonsense", () => {
  assert.equal(loadConfig({}).maxReviewers, 1);
  assert.equal(loadConfig({ WORKER_CONCURRENCY: "3" }).maxReviewers, 3);
  for (const v of ["0", "-1", "1.5", "x"]) assert.throws(() => loadConfig({ WORKER_CONCURRENCY: v }), /WORKER_CONCURRENCY/);
});

type Post = (body: unknown) => Promise<{ status: number; body: unknown }>;

async function withServer(run: Run, fn: (post: Post, port: number) => Promise<void>) {
  const server = createLauncher(cfg, run);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const post: Post = async (body) => {
    const r = await fetch(`http://127.0.0.1:${port}/review`, { method: "POST", body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    await fn(post, port);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test("POST /review answers with the container's result; a bad request never reaches docker", async () => {
  const result: LaunchResult = { exitCode: 4, stdout: "{}", stderr: "quota" };
  let calls = 0;
  await withServer(async () => (calls++, result), async (post) => {
    assert.deepEqual(await post(valid), { status: 200, body: result });
    assert.equal((await post({ ...valid, worktree: "/" })).status, 400);
    assert.equal(calls, 1);
  });
});

test("over the cap a review gets a 429; a worker that hangs up aborts its container", async () => {
  let release!: () => void;
  let aborted!: Promise<void>;
  const run: Run = (_cfg, _job, signal) => {
    aborted = new Promise((r) => signal.addEventListener("abort", () => r()));
    return new Promise((r) => (release = () => r({ exitCode: 0, stdout: "", stderr: "" })));
  };
  await withServer(run, async (post, port) => {
    // a request we can cut, like a worker restarting mid-review: node:http, not fetch
    const first = request({ port, host: "127.0.0.1", path: "/review", method: "POST" });
    first.on("error", () => {});
    first.end(JSON.stringify(valid));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await post(valid)).status, 429);
    first.destroy();
    await aborted;
    release();
  });
});

test("volume-subpath mounts need Docker API 1.45 (Engine 26) or newer", () => {
  for (const v of ["1.45", "1.52", "2.0"]) assert.ok(supportsVolumeSubpath(v), v);
  for (const v of ["1.44", "1.9", "", "x"]) assert.ok(!supportsVolumeSubpath(v), v);
});
