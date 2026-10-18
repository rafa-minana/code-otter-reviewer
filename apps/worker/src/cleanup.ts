import { existsSync } from "node:fs";
import type { CleanupJob } from "@otter/contracts";
import type { JobHelpers } from "graphile-worker";
import { withRepoLock } from "./git/lock.js";
import { mirrorPath, prRef } from "./git/mirror.js";
import { git, type GitEnv } from "./git/run.js";
import { removeWorktrees } from "./git/worktree.js";

/**
 * PR closed: drops its worktrees and its ref; the mirror stays for the repo's other PRs.
 * DB rows are kept: deleting them under a running review would break its findings insert (the janitor removes them, v2).
 */
export async function cleanupPr(
  env: GitEnv,
  owner: string,
  repo: string,
  number: number,
): Promise<void> {
  await removeWorktrees(env, owner, repo, number);
  const mirror = mirrorPath(env, owner, repo);
  if (existsSync(mirror))
    await git(["update-ref", "-d", prRef(number)], { cwd: mirror });
}

export async function cleanupRepo(owner: string, repo: string): Promise<void> {
  throw new Error("not implemented");
}

/** Cleans PRs idle for 5 days and repos idle for N days. */
export async function gc(): Promise<void> {
  throw new Error("not implemented");
}

/** Cleanup job handler, under the repo lock so it never races a review's git work. */
export async function handleCleanup(
  deps: { git: GitEnv },
  job: CleanupJob,
  helpers: JobHelpers,
): Promise<void> {
  const { owner, repo, number } = job;
  if (number === undefined)
    throw new Error("repo cleanup is not implemented yet (v2)");
  await withRepoLock(helpers, owner, repo, () =>
    cleanupPr(deps.git, owner, repo, number),
  );
}
