import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { CleanupJob } from "@otter/contracts";
import type { JobHelpers } from "graphile-worker";
import { withRepoLock } from "./git/lock.js";
import { mirrorPath, prRef } from "./git/mirror.js";
import { git, type GitEnv } from "./git/run.js";
import { removeWorktrees, repoWorktreesDir } from "./git/worktree.js";

/** Cascades to its PRs, reviews and findings. */
const DELETE_REPO_SQL = `DELETE FROM repos WHERE owner = $1 AND name = $2`;

/**
 * PR closed: drops its worktrees and its ref; the mirror stays for the repo's other PRs.
 * DB rows are kept: deleting them under a running review would break its findings insert (the janitor removes them).
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

/** Every worktree of the repo and its mirror (a half-cloned one too). DB rows are the caller's. */
export async function cleanupRepo(
  env: GitEnv,
  owner: string,
  repo: string,
): Promise<void> {
  const mirror = mirrorPath(env, owner, repo);
  for (const path of [repoWorktreesDir(env, owner, repo), mirror, `${mirror}.tmp`])
    await rm(path, { recursive: true, force: true });
}

/** Cleanup job handler, under the repo lock so it never races a review's git work. */
export async function handleCleanup(
  deps: { git: GitEnv },
  job: CleanupJob,
  helpers: JobHelpers,
): Promise<void> {
  const { owner, repo, number } = job;
  if (number !== undefined)
    return withRepoLock(helpers, owner, repo, () =>
      cleanupPr(deps.git, owner, repo, number),
    );
  // Whole repo (admin): files, then rows; a webhook afterwards recreates both, they were only cache.
  await withRepoLock(helpers, owner, repo, () =>
    cleanupRepo(deps.git, owner, repo),
  );
  await helpers.withPgClient((pg) => pg.query(DELETE_REPO_SQL, [owner, repo]));
}
