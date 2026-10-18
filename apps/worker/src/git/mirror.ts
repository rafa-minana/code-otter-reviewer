import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { git, type GitEnv } from "./run.js";

// owner/repo are validated by the api (SAFE_NAME), and each is its own path segment, so names can't collide.
export const mirrorPath = (env: GitEnv, owner: string, repo: string) =>
  join(env.dataDir, "mirrors", owner, `${repo}.git`);

/** Bare partial clone (--filter=blob:none) of the repo if missing; returns its path. */
export async function ensureMirror(
  env: GitEnv,
  owner: string,
  repo: string,
  token?: string,
): Promise<string> {
  const path = mirrorPath(env, owner, repo);
  if (existsSync(join(path, "HEAD"))) return path;

  // Clone next to it and rename, so a crash mid-clone never leaves a half mirror behind.
  const tmp = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await rm(tmp, { recursive: true, force: true });
  await git(
    [
      "clone",
      "--bare",
      "--filter=blob:none",
      "--no-tags",
      `${env.remoteBase}/${owner}/${repo}.git`,
      tmp,
    ],
    { token },
  );
  await rename(tmp, path);
  return path;
}

/** Fetches the PR head into refs/otter/pr<n> and its base branch into refs/otter/base/<branch>. */
export async function fetchPr(
  env: GitEnv,
  owner: string,
  repo: string,
  number: number,
  baseRef: string,
  token?: string,
): Promise<void> {
  await git(
    [
      "fetch",
      "--no-tags",
      "--filter=blob:none",
      "origin",
      `+refs/pull/${number}/head:${prRef(number)}`,
      `+refs/heads/${baseRef}:${baseRefName(baseRef)}`,
    ],
    { cwd: mirrorPath(env, owner, repo), token },
  );
}

export const prRef = (number: number) => `refs/otter/pr${number}`;
export const baseRefName = (baseRef: string) => `refs/otter/base/${baseRef}`;
