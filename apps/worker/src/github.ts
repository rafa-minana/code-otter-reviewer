import type { GitHubClient } from "./ports.js";

/** GitHub App auth (App ID + .pem → installation tokens). The only file that imports Octokit. */
export function octokitClient(env: Record<string, string | undefined> = process.env): GitHubClient {
  throw new Error("not implemented");
}
