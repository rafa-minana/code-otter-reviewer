import { baseRefName, mirrorPath } from "./mirror.js";
import { git, type GitEnv } from "./run.js";

/**
 * The PR's diff as GitHub computes it: from the merge-base with the base branch (three dots),
 * 3 lines of context, renames detected. The flags pin the output format and stop the repo's
 * attributes from running external diff or textconv programs.
 */
export function prDiff(
  env: GitEnv,
  owner: string,
  repo: string,
  baseRef: string,
  sha: string,
  token?: string,
): Promise<string> {
  return git(
    [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--unified=3",
      "-M",
      `${baseRefName(baseRef)}...${sha}`,
    ],
    { cwd: mirrorPath(env, owner, repo), token },
  );
}
