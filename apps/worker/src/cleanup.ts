export async function cleanupPr(owner: string, repo: string, number: number): Promise<void> {
  throw new Error("not implemented");
}

export async function cleanupRepo(owner: string, repo: string): Promise<void> {
  throw new Error("not implemented");
}

/** Cleans PRs idle for 5 days and repos idle for N days. */
export async function gc(): Promise<void> {
  throw new Error("not implemented");
}
