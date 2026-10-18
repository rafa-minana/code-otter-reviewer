import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { ReviewJob } from "@otter/contracts";
import type { Config } from "./config.js";
import type { GitHubClient } from "./ports.js";

/** GitHub App auth (App ID + .pem → installation tokens). The only file that imports Octokit. */
export function octokitClient({
  appId,
  privateKey,
}: Pick<Config, "appId" | "privateKey">): GitHubClient {
  // One Octokit per installation: auth-app caches its token until it expires.
  const clients = new Map<number, Octokit>();
  const forJob = (job: ReviewJob) => {
    const { installationId } = job;
    if (!clients.has(installationId)) {
      clients.set(
        installationId,
        new Octokit({
          authStrategy: createAppAuth,
          auth: { appId, privateKey, installationId },
        }),
      );
    }
    return clients.get(installationId)!;
  };
  const pr = (job: ReviewJob) => ({
    owner: job.owner,
    repo: job.repo,
    pull_number: job.number,
  });

  return {
    async getPullRequest(job) {
      const { data } = await forJob(job).pulls.get(pr(job));
      return {
        title: data.title,
        body: data.body ?? "",
        baseRef: data.base.ref,
        headSha: data.head.sha,
      };
    },

    async getDiff(job) {
      const { data } = await forJob(job).pulls.get({
        ...pr(job),
        mediaType: { format: "diff" },
      });
      return data as unknown as string; // the diff media type returns plain text
    },

    async getFile(job, path, ref) {
      try {
        const { data } = await forJob(job).repos.getContent({
          owner: job.owner,
          repo: job.repo,
          path,
          ref,
          mediaType: { format: "raw" },
        });
        return data as unknown as string;
      } catch (err) {
        if ((err as { status?: number }).status === 404) return null;
        throw err;
      }
    },

    async createReview(job, body, comments) {
      const { data } = await forJob(job).pulls.createReview({
        ...pr(job),
        commit_id: job.sha, // pins the comments to the SHA we reviewed
        event: "COMMENT",
        body,
        comments: comments.map(({ startLine, ...c }) =>
          startLine === undefined
            ? c
            : { ...c, start_line: startLine, start_side: c.side },
        ),
      });
      return data.id;
    },

    async installationToken(job) {
      const { token } = (await forJob(job).auth({ type: "installation" })) as {
        token: string;
      };
      return token;
    },
  };
}
