/** git worktree add for the PR's SHA; returns its path. */
export async function addWorktree(owner: string, repo: string, number: number, sha: string): Promise<string> {
  throw new Error("not implemented");
}

export async function removeWorktrees(owner: string, repo: string, number: number): Promise<void> {
  throw new Error("not implemented");
}
