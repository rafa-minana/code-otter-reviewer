/** Bare clone (--filter=blob:none) of the repo if missing; returns its path. */
export async function ensureMirror(owner: string, repo: string): Promise<string> {
  throw new Error("not implemented");
}

/** fetch pull/<n>/head into refs/otter/pr<n>, under a per-repo advisory lock. */
export async function fetchPr(owner: string, repo: string, number: number): Promise<void> {
  throw new Error("not implemented");
}
