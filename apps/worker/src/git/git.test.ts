import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiff } from "@otter/reviewer/diff.js";
import { cleanupPr } from "../cleanup.js";
import { prDiff } from "./diff.js";
import { ensureMirror, fetchPr, mirrorPath, prRef } from "./mirror.js";
import { git, type GitEnv } from "./run.js";
import { addWorktree } from "./worktree.js";

// Integration tests against a local "GitHub": a repo at <tmp>/acme/app.git served over file://
// (file:// rather than a plain path, so the partial clone filter is honoured).

let tmp: string;
let env: GitEnv;
let origin: string;
const sh = (args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: origin,
    encoding: "utf8",
  }).trim();
const commit = (file: string, content: string, message: string) => {
  writeFileSync(join(origin, file), content);
  sh(["add", "."]);
  sh(["commit", "-qm", message]);
  return sh(["rev-parse", "HEAD"]);
};
const worktrees = () =>
  readdirSync(join(env.dataDir, "worktrees", "acme", "app", "pr1"));

let firstSha: string;

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "otter-git-"));
  origin = join(tmp, "acme", "app.git");
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  sh(["config", "uploadpack.allowFilter", "true"]);
  sh(["config", "uploadpack.allowAnySHA1InWant", "true"]);
  commit(
    "app.ts",
    "function login(email) {\n  return find(email);\n}\n",
    "base",
  );
  sh(["checkout", "-qb", "feature"]);
  firstSha = commit(
    "app.ts",
    "function login(email) {\n  if (!email) return null;\n  return find(email);\n}\n",
    "pr",
  );
  sh(["update-ref", "refs/pull/1/head", firstSha]); // what GitHub exposes for PR #1
  sh(["checkout", "-q", "main"]);
  env = { dataDir: join(tmp, "data"), remoteBase: `file://${tmp}` };
});

after(() => rm(tmp, { recursive: true, force: true }));

test("ensureMirror makes a bare partial clone, once", async () => {
  const path = await ensureMirror(
    env,
    "acme",
    "app",
    "token-is-ignored-by-file-urls",
  );
  assert.equal(path, mirrorPath(env, "acme", "app"));
  assert.equal(
    (await git(["config", "remote.origin.promisor"], { cwd: path })).trim(),
    "true",
  );
  assert.equal(
    (await git(["rev-parse", "--is-bare-repository"], { cwd: path })).trim(),
    "true",
  );
  assert.equal(await ensureMirror(env, "acme", "app"), path); // already there: no second clone
});

test("fetchPr brings the PR head and its base branch", async () => {
  await fetchPr(env, "acme", "app", 1, "main");
  const mirror = mirrorPath(env, "acme", "app");
  assert.equal(
    (await git(["rev-parse", prRef(1)], { cwd: mirror })).trim(),
    firstSha,
  );
  assert.ok(
    (await git(["rev-parse", "refs/otter/base/main"], { cwd: mirror })).trim(),
  );
});

test("prDiff is the merge-base diff, in the format parseDiff reads", async () => {
  const files = parseDiff(await prDiff(env, "acme", "app", "main", firstSha));
  assert.deepEqual(
    files.map((f) => f.path),
    ["app.ts"],
  );
  assert.deepEqual(files[0].hunks[0].lines, [
    " function login(email) {",
    "+  if (!email) return null;",
    "   return find(email);",
    " }",
  ]);
});

test("addWorktree checks out the SHA, reuses it, and keeps only the latest one per PR", async () => {
  const first = await addWorktree(env, "acme", "app", 1, firstSha);
  assert.match(readFileSync(join(first, "app.ts"), "utf8"), /if \(!email\)/);
  assert.equal(await addWorktree(env, "acme", "app", 1, firstSha), first); // a retry reuses it

  sh(["checkout", "-q", "feature"]);
  const secondSha = commit(
    "app.ts",
    "function login(email) {\n  return null;\n}\n",
    "push",
  );
  sh(["update-ref", "refs/pull/1/head", secondSha]);
  sh(["checkout", "-q", "main"]);
  await fetchPr(env, "acme", "app", 1, "main");
  const second = await addWorktree(env, "acme", "app", 1, secondSha);

  assert.deepEqual(worktrees(), [secondSha]);
  assert.ok(!existsSync(first));
  assert.match(readFileSync(join(second, "app.ts"), "utf8"), /return null/);
});

test("cleanupPr removes the PR's worktrees and ref, and keeps the mirror", async () => {
  const mirror = mirrorPath(env, "acme", "app");
  await cleanupPr(env, "acme", "app", 1);
  assert.ok(!existsSync(join(env.dataDir, "worktrees", "acme", "app", "pr1")));
  await assert.rejects(
    git(["rev-parse", "--verify", prRef(1)], { cwd: mirror }),
  );
  assert.ok(existsSync(join(mirror, "HEAD")));
  await cleanupPr(env, "acme", "app", 1); // idempotent: a redelivered close event is fine
});
