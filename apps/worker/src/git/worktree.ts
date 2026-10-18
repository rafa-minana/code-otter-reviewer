import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { mirrorPath } from "./mirror.js";
import { git, type GitEnv } from "./run.js";

const prDir = (env: GitEnv, owner: string, repo: string, number: number) =>
  join(env.dataDir, "worktrees", owner, repo, `pr${number}`);

/**
 * Checkout of the PR's SHA; returns its path. Reused when it already exists (a retry of the same job).
 * Only the latest SHA is kept per PR: older worktrees are stale, so they are removed here.
 */
export async function addWorktree(
  env: GitEnv,
  owner: string,
  repo: string,
  number: number,
  sha: string,
  token?: string,
): Promise<string> {
  const mirror = mirrorPath(env, owner, repo);
  const path = join(prDir(env, owner, repo, number), sha);
  if (!existsSync(join(path, ".git"))) {
    await rm(path, { recursive: true, force: true }); // leftover of a crashed attempt
    await git(["worktree", "prune"], { cwd: mirror });
    await git(["worktree", "add", "--detach", path, sha], {
      cwd: mirror,
      token,
    });
  }
  await removeWorktrees(env, owner, repo, number, path);
  return path;
}

/** Removes every worktree of the PR except `keep`. */
export async function removeWorktrees(
  env: GitEnv,
  owner: string,
  repo: string,
  number: number,
  keep?: string,
): Promise<void> {
  const mirror = mirrorPath(env, owner, repo);
  const dir = prDir(env, owner, repo, number);
  const shas = existsSync(dir) ? await readdir(dir) : [];
  for (const sha of shas) {
    const path = join(dir, sha);
    if (path === keep) continue;
    // Best effort through git, then the directory goes regardless; `prune` drops the dangling metadata.
    await git(["worktree", "remove", "--force", path], { cwd: mirror }).catch(
      () => {},
    );
    await rm(path, { recursive: true, force: true });
  }
  if (!keep) await rm(dir, { recursive: true, force: true });
  if (existsSync(mirror)) await git(["worktree", "prune"], { cwd: mirror });
}
